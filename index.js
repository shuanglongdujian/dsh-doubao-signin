/**
 * dsh-doubao-signin —— Host 半身。
 *
 * 三个模型面向的工具：
 * - `doubao_chat`     豆包网页反代（OpenAI 风格返回）
 * - `doubao_checkin`  每日签到（CDP 点 UI，签名交给客户端）
 * - `doubao_status`   只看状态：客户端在不在、端口开没开、签到卡片什么样
 *
 * 设计前提：签名一律借本机已登录的豆包客户端做，插件自己不算 a_bogus、不复刻混淆 JS。
 * 所以本插件不依赖 Playwright，也不额外起浏览器 —— 客户端的 Chromium 就是签名器。
 *
 * 本文件不 import 任何 `@deepseek-ai/*`：第三方插件跑在 profile 的 node_modules，
 * 那里没有核心包，只有 `ctx` 是可用的入口。
 *
 * @module dsh-doubao-signin
 */
import { runCheckin } from './src/checkin.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadCredentials, loginWithBrowser, credentialsPath, resolveCookieHeader, readAccountCookies } from './src/login.js'
import {
  MODELS,
  buildChatBody,
  collectStream,
  extractToolCalls,
  parseSseLine,
  renderToolPrompt,
} from './src/protocol.js'
import {
  Circuit,
  Pacer,
  applyPromptBudget,
  cleanForWire,
  classifyFailure,
  isDoubaoFallbackReply,
  createRefusalTracker,
  isRefusal,
} from './src/hardening.js'
import { ClientSigner, lines } from './src/signer.js'
import { parseQuotaSummary, renderQuota, QUOTA_PATH } from './src/quota.js'
import { directChat, buildDirectQuery } from './src/direct.js'
import { findClientIdentity, toIdentity } from './src/identity.js'
import { registerQuotaRoute } from './src/routes.js'
import { createDoubaoAdapter, PROVIDER } from './src/doubao-adapter.js'
import { createOpenAIGateway } from './src/openai-gateway.js'
import {
  accountCookieHeader,
  addAccount,
  listEnabledAccounts,
  loadPool,
  markAccountFailed,
  markAccountOk,
  pickAccount,
  withAccountFailover,
} from './src/account-pool.js'
import { runAutoCheckin, loadAutoCheckinState } from './src/auto-checkin.js'

/** Cordis 插件名。 */
export const name = 'doubao-signin'

/** 唯一硬依赖：tools（工具）和 llm（让豆包模型出现在模型选择器）。 */
export const inject = ['tools', 'llm']

/** 默认配置；patch 里的 config 会逐项覆盖。 */
export const DEFAULTS = {
  cdpPort: 9222,
  relaunchClient: false,
  exePath: '',
  defaultModel: 'doubao',
  timeoutMs: 180_000,
  /** 轮间最小间隔（毫秒）。 */
  minIntervalMs: 1500,
  /** 风控熔断冷却（毫秒）。 */
  riskCooldownMs: 10 * 60_000,
  /** 直连优先：健康账号不碰客户端、不需要调试端口。false 强制永远走 CDP 签名桥。 */
  directFirst: true,
  /** 直连被风控拒绝后，本次进程内是否还允许降级到 CDP 签名桥。 */
  allowBridgeFallback: true,
  /** 每日自动签到（启动后延迟 autoCheckinDelayMs 跑一次；今天跑过就跳过）。 */
  autoCheckin: true,
  /** 自动签到的启动延迟（毫秒）。默认 30 秒：别跟启动抢资源，也等凭据续期先跑一轮。 */
  autoCheckinDelayMs: 30_000,
  /** 多账号池：凭据失效时自动换下一个账号。 */
  accountFailover: true,
  /**
   * 是否把「豆包工作」模式的模型（agentMode=1，如 doubao-auto / kimi-k3 / glm-5.3）
   * 也注册进模型选择器。
   *
   * 默认 false：实测「免费体验」会员（has_active_subscription=true, level=std）
   * **只有会员身份、没有工作模式的实际额度**——选工作模型一律回「出了点问题」。
   * v0.8.5 曾基于"有会员身份"错误地默认全开，导致点一个错一个。
   * 真正开通了工作权益的账号可设为 true。
   */
  includeWorkModels: false,
  openaiGatewayEnabled: false,
  openaiGatewayPort: 8793,
  openaiGatewayModelIds: [],
}

/** 聊天工具的参数 JSON Schema（隐式根对象，逐属性写 required）。 */
const CHAT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string', description: '要发送的内容。多轮上下文请自己拼进 prompt。' },
    system: { type: 'string', description: '系统设定，会以「[系统设定]」前缀拼进 prompt。' },
    model: {
      type: 'string',
      enum: Object.keys(MODELS),
      description: `模型，默认 ${DEFAULTS.defaultModel}。workspace 类模型走豆包工作台路由。`,
    },
    tools: {
      type: 'array',
      description: 'OpenAI 风格 tools 数组；用 <tool_call> 文本协议仿真后解析回 tool_calls。',
      items: { type: 'object', additionalProperties: true },
    },
    timeoutMs: { type: 'integer', description: `超时毫秒数，默认 ${DEFAULTS.timeoutMs}。` },
  },
  required: ['prompt'],
}

/** 聊天工具的返回 schema。 */
const CHAT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    model: { type: 'string' },
    thinking: { type: 'string' },
    toolCalls: { type: 'array', items: { type: 'object', additionalProperties: true } },
    unknownFrames: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'model', 'notes'],
}

/** 签到工具的参数 schema。 */
const CHECKIN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dryRun: { type: 'boolean', description: '只判定状态、不点击。第一次用请先跑这个。' },
    relaunchClient: { type: 'boolean', description: '端口没开时是否重启客户端。' },
    exePath: { type: 'string', description: '显式指定客户端可执行文件，跳过自动发现。' },
    timeoutMs: { type: 'integer', description: '等待签到页就绪的毫秒数，默认 25000。' },
  },
}

/** 签到工具的返回 schema。 */
const CHECKIN_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    state: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['ok', 'state', 'message'],
}

/** 状态工具的参数 schema。 */
const STATUS_PARAMETERS = { type: 'object', additionalProperties: false, properties: {} }

/** 状态工具的返回 schema。 */
const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    clientFound: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['clientFound', 'summary'],
}

/**
 * 取一个能用的 logger。真实 DSH 的 `ctx.logger` 既可当带 info/warn/error 的对象用
 * （官方包 `ctx.logger.warn(...)`），也可当命名空间工厂用（`ctx.logger('ns')`），
 * 两种形态都要接住；缺服务时退回 console。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{info: Function, warn: Function, error: Function}} 可用的 logger。
 */
function makeLogger(ctx) {
  let raw
  try {
    raw = ctx?.logger
  } catch {
    // cordis proxy 在没 inject('logger') 时会抛，这里不声明该依赖，落回 console
    raw = undefined
  }
  if (raw && typeof raw.info === 'function') {
    return { info: raw.info.bind(raw), warn: raw.warn?.bind(raw) ?? raw.info, error: raw.error?.bind(raw) ?? raw.info }
  }
  if (typeof raw === 'function') {
    try {
      const sub = raw('doubao')
      if (sub && typeof sub.info === 'function') {
        return { info: sub.info.bind(sub), warn: sub.warn?.bind(sub) ?? sub.info, error: sub.error?.bind(sub) ?? sub.info }
      }
    } catch {
      // 工厂调用失败就落回 console
    }
  }
  return { info: console.info, warn: console.warn, error: console.error }
}

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - patch 提供的配置，缺项用 DEFAULTS 补。
 * @returns {Promise<void>} 注册完成。
 */
export async function apply(ctx, rawConfig = {}) {
  // —— 诊断探针：DSH_DOUBAO_DEBUG=1 时把装载轨迹写进 ~/.dsh/doubao-signin-debug.log ——
  // Electron 主进程的 console 用户看不到，这是唯一能穿透到文件系统的观测点。
  const debugSink = (() => {
    try {
      if (process.env.DSH_DOUBAO_DEBUG !== '1') return null
      const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
      const file = path.join(home, 'doubao-signin-debug.log')
      // 显式 utf8：Windows 上 appendFileSync 默认按 utf8 写，但用 Buffer 更稳
      // （避免宿主的默认编码把中文写成乱码，排查时根本看不清）。
      return message => fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8' })
    } catch {
      return null
    }
  })()
  debugSink?.(`apply entered, pid=${process.pid}`)

  const config = { ...DEFAULTS, ...rawConfig }
  const logger = makeLogger(ctx)
  const log = (...args) => {
    debugSink?.(args.map(a => String(a)).join(' '))
    try {
      logger.info(...args)
    } catch {
      // 日志失败不该影响工具本身
    }
  }

  let signer = null
  const pacer = new Pacer({ minIntervalMs: config.minIntervalMs })
  const circuit = new Circuit({ cooldownMs: config.riskCooldownMs })
  // 设备身份：进程内只探测一次（客户端重装会换 id，但那需要重启宿主才生效）
  let identityCache = undefined

  /**
   * 拿设备身份（Local State 优先，leveldb 兜底）。
   * @returns {{identity?: object, found: boolean, source?: string}} 身份或未找到。
   */
  const getIdentity = () => {
    if (identityCache !== undefined) return identityCache
    const probe = findClientIdentity()
    identityCache = probe.found ? { found: true, identity: toIdentity(probe.info), source: probe.dir } : { found: false }
    return identityCache
  }

  /**
   * 惰性拿一个已连接的签名器。
   * @returns {Promise<ClientSigner>} 已连接实例。
   */
  const ensureSigner = async () => {
    if (signer?.conn) return signer
    signer = new ClientSigner({
      port: config.cdpPort,
      exePath: config.exePath || undefined,
      relaunchClient: config.relaunchClient,
      log,
    })
    await signer.connect()
    return signer
  }

  const modelIds = Object.keys(MODELS)

  /**
   * 统一的 cookie 来源：扫码保存的凭据优先，其次借客户端页面。
   * @returns {Promise<{header: string, source: string, ready: boolean}>} cookie 头与来源。
   */
  const cookieSource = async () => resolveCookieHeader({
    fromClient: async () => {
      const client = await ensureSigner()
      return client.cookieHeader()
    },
    fromPool: () => {
      // 账号池优先（多账号时选额度最多的那个）
      const accounts = listEnabledAccounts()
      const picked = pickAccount(accounts)
      if (!picked) return undefined
      const header = accountCookieHeader(picked)
      return header ? { header, source: 'pool', account: picked, ready: true } : undefined
    },
  })

  const readCheckinStatus = async () => {
    const cookie = await cookieSource().catch(() => ({ header: '' }))
    if (!cookie.header) {
      return { ok: false, state: 'unlogged', message: '没有登录凭据。先扫码登录，再查签到状态。' }
    }
    const { querySigninStatus } = await import('./src/signin-status.js')
    return querySigninStatus(cookie.header)
  }

  // —— LLM provider：让豆包模型出现在模型选择器 ——
  // 契约来自 dsh-llm registerAdapter：结构化校验，不需要 extends / pi-ai / 新依赖。
  // llm 服务由 inject=['tools','llm'] 保证就绪。
  const adapter = createDoubaoAdapter({ config, getIdentity, cookieSource, ensureSigner, log })
  try {
    const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.effect(() => () => releaseAdapter(), 'doubao: llm adapter')
    log('LLM provider 已注册: ' + PROVIDER + '（' + Object.keys(MODELS).length + ' 个模型进入选择器）')
  } catch (error) {
    log('LLM provider 注册失败（工具仍可用）: ' + error.message)
  }

  if (config.openaiGatewayEnabled === true) {
    ctx.effect(() => {
      const port = config.openaiGatewayPort
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        log('OpenAI 网关未启动：openaiGatewayPort 必须是 1 到 65535 的整数。')
        return
      }
      let server
      try {
        server = createOpenAIGateway({
          key: process.env.DOUBAO_GATEWAY_KEY,
          arkKey: process.env.ARK_API_KEY,
          modelIds: config.openaiGatewayModelIds,
          timeoutMs: config.timeoutMs,
        })
      } catch (error) {
        log('OpenAI 网关未启动：' + error.message)
        return
      }
      server.on('error', error => log('OpenAI 网关监听失败：' + (error.code ?? error.name)))
      server.listen(port, '127.0.0.1', () => log(`OpenAI 网关监听于 http://127.0.0.1:${port}/v1`))
      return () => {
        server.close()
        server.closeAllConnections()
      }
    }, 'doubao: OpenAI gateway')
  }

  // —— doubao_accounts：账号池管理（多账号 / 换号 / 看额度）——
  ctx.tools.register({
    name: 'doubao_accounts',
    description:
      '管理豆包账号池：列出账号与各自的额度、切换主账号、停用/启用某个账号。'
      + '多个账号时，聊天和额度查询会自动用剩余额度最多的那个；'
      + '某个账号凭据失效时会自动换下一个。'
      + '加账号用 doubao_login（带 label 参数会存成独立账号）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'enable', 'disable'],
          description: 'list=看账号池（默认）；enable/disable=启用或停用某个账号。',
        },
        accountId: { type: 'string', description: 'enable/disable 时指定账号 id。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['ok', 'summary'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall() {
      return { card: 'generic', title: '豆包账号池', kind: 'other', rawInput: {} }
    },
    async execute(args) {
      const pool = loadPool()
      if (args.action === 'enable' || args.action === 'disable') {
        const a = pool.accounts.find(x => x.id === args.accountId)
        if (!a) return { ok: false, summary: `没有这个账号: ${args.accountId}` }
        if (args.action === 'enable') {
          a.enabled = true
          a.disabledReason = null
        } else {
          a.enabled = false
          a.disabledReason = '用户停用'
        }
        savePool(pool)
        return { ok: true, summary: `账号 ${a.label ?? a.id} 已${args.action === 'enable' ? '启用' : '停用'}` }
      }

      // list：顺带读每个账号的额度
      const rows = []
      for (const a of pool.accounts) {
        let quota = a.quota ?? null
        const header = accountCookieHeader(a)
        if (header) {
          try {
            const res = await fetch(`https://www.doubao.com${QUOTA_PATH}?aid=497858&device_platform=web&_t=${Date.now()}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json', accept: 'application/json, text/plain, */*',
                origin: 'https://www.doubao.com', referer: 'https://www.doubao.com/chat/',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                cookie: header,
              },
              body: '{}',
              signal: AbortSignal.timeout(15_000),
            })
            if (res.ok) {
              const parsed = parseQuotaSummary(await res.json())
              if (parsed) {
                quota = { total: parsed.total, windows: parsed.windows.length }
                markAccountOk(a.id, quota)
              }
            }
          } catch (error) {
            markAccountFailed(a.id, error.message, false)
          }
        }
        rows.push(
          `  ${a.label ?? a.id}  ${a.enabled === false ? '(已停用)' : ''}  `
          + `剩余额度 ${quota?.total ?? '未知'}  ${a.lastError ? '上次错误: ' + a.lastError : ''}`,
        )
      }
      const auto = loadAutoCheckinState()
      const summary = [
        `账号池（${pool.accounts.length} 个）:`,
        ...(rows.length ? rows : ['  （空）—— 用 doubao_login 扫码登录一个账号']),
        `自动签到: ${auto.enabled ? '开' : '关'} | 上次跑: ${auto.lastDate ?? '从未'}`,
      ].join('\n')
      return { ok: true, summary }
    },
  })

  // —— doubao_login：浏览器扫码登录（不需要豆包桌面客户端） ——
  ctx.tools.register({
    name: 'doubao_login',
    description:
      '打开浏览器扫码登录豆包（用抖音 App 扫），把会话 cookie 保存到本机，'
      + '之后聊天/额度/签到都用这份凭据。**不需要安装豆包桌面客户端**。'
      + '会拉起一个独立的浏览器窗口（不影响你日常浏览器），扫码完成后自动关闭。'
      + '超时默认 3 分钟；重复调用会复用同一个浏览器目录，通常免扫码。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', description: '等待扫码的毫秒数，默认 180000（3 分钟）。' },
        browserPath: { type: 'string', description: '显式指定 Chrome/Edge 路径，缺省自动发现。' },
        dryRun: { type: 'boolean', description: '只看当前登录态、不拉起浏览器。' },
        label: {
          type: 'string',
          description:
            '把这个登录存成独立的账号（多账号池用）。留空则用默认账号。'
            + '每个账号有独立的浏览器 profile 与凭据，互不影响。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          cookieCount: { type: 'integer' },
        },
        required: ['ok', 'message'],
      },
      render(_args, value) {
        const lines = [`${value.ok ? '✓' : '✗'} ${value.message}`]
        if (value.path) lines.push(`  凭据: ${value.path}`)
        if (value.cookieCount) lines.push(`  cookie 数: ${value.cookieCount}`)
        if (value.missingCore?.length) lines.push(`  缺: ${value.missingCore.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', title: args.dryRun ? '豆包登录状态' : '豆包扫码登录', kind: 'other', rawInput: args }
    },
    async execute(args) {
      if (args.dryRun === true) {
        const saved = loadCredentials()
        if (!saved) {
          return { ok: false, message: `尚未登录。没有找到 ${credentialsPath()}。去掉 dryRun 再调用即可拉起扫码。` }
        }
        return {
          ok: true,
          message: `已登录（保存于 ${saved.savedAt}，${saved.cookies.length} 个 cookie）`,
          path: credentialsPath(),
          cookieCount: saved.cookies.length,
        }
      }
      const progress = []
      const accountId = args.label
        ? args.label.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || ('acct-' + Date.now())
        : undefined
      const result = await loginWithBrowser({
        timeoutMs: args.timeoutMs ?? 180_000,
        browserPath: args.browserPath || undefined,
        accountId,
        onProgress: msg => progress.push(msg),
      })
      // 带 label 的登录进账号池
      if (result.ok && accountId) {
        const pairs = readAccountCookies(accountId)
        if (pairs.length) {
          addAccount({ label: args.label, cookies: pairs, dirName: accountId })
          result.message += `（已加入账号池：${args.label}）`
        }
      }
      return { ...result, ...(progress.length ? { progress } : {}) }
    },
  })


  ctx.tools.register({
    name: 'doubao_chat',
    description:
      '向豆包网页端发一次对话，返回回答文本。签名借本机已登录的豆包客户端完成，'
      + '因此要求客户端在运行且已登录（客户端没开会给出明确指引，不会静默失败）。'
      + '已知边界：多轮历史会被压平成一条 prompt，没有真会话状态；'
      + 'temperature / max_tokens 在网页端不存在，不生效；'
      + '工具调用是 <tool_call> 文本仿真，不是上游原生通道。',
    parameters: CHAT_PARAMETERS,
    output: {
      schema: CHAT_OUTPUT,
      render(_args, value) {
        const blocks = [{ type: 'text', text: value.text || '(上游没有返回文本)' }]
        if (value.toolCalls?.length) {
          const names = value.toolCalls.map(c => c?.function?.name ?? '?').join(', ')
          blocks.push({ type: 'text', text: `\n[工具调用 ${value.toolCalls.length} 个] ${names}` })
        }
        if (value.notes?.length) blocks.push({ type: 'text', text: `\n[说明] ${value.notes.join('；')}` })
        return blocks
      },
    },
    timeoutMs: config.timeoutMs + 30_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: `豆包 · ${args.model ?? config.defaultModel}`,
        kind: 'other',
        rawInput: { prompt: args.prompt?.slice(0, 200), system: args.system },
      }
    },
    async execute(args, exec) {
      const model = args.model ?? config.defaultModel
      if (!MODELS[model]) {
        throw new Error(`未知模型: ${model}。可用: ${modelIds.join(', ')}`)
      }
      if (circuit.open) {
        throw new Error(
          `豆包风控熔断中（剩 ${Math.ceil(circuit.remainingMs / 1000)}s）。`
          + '在豆包客户端里完成一次人机验证后可直接重试；或等冷却结束。',
        )
      }

      // 出网前清洗：剥宿主注入，防审核
      const messages = []
      if (args.system) {
        const cleanedSystem = cleanForWire(args.system, 'system')
        if (cleanedSystem) messages.push({ role: 'system', content: cleanedSystem })
      }
      const cleanedPrompt = cleanForWire(args.prompt, 'user')
      messages.push({ role: 'user', content: cleanedPrompt || args.prompt })

      const toolPrompt = args.tools?.length ? renderToolPrompt(args.tools) : ''
      let body = buildChatBody({ model, messages, toolPrompt })

      // 32K 预算：长会话压平后网关会静默拒
      // （正文现在在 content_block[0].content.text_block.text，不再是 content 字符串）
      const textBlock = body.messages[0].content_block?.[0]?.content?.text_block
      const budgeted = applyPromptBudget(textBlock?.text ?? '')
      if (budgeted.truncated && textBlock) {
        textBlock.text = budgeted.text
      }

      const release = await pacer.begin()
      const budget = args.timeoutMs ?? config.timeoutMs
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('doubao_chat 超时')), budget)
      const onAbort = () => ac.abort(new Error('调用方取消'))
      exec?.signal?.addEventListener('abort', onAbort, { once: true })

      /**
       * 统一的失败出口：分类、熔断、清场。
       * @param {string} message - 原始错误信息。
       * @returns {Error} 带分类的异常。
       */
      const bail = message => {
        const fail = classifyFailure(message)
        if (fail.kind === 'risk') circuit.trip()
        release()
        clearTimeout(timer)
        exec?.signal?.removeEventListener('abort', onAbort)
        const e = new Error(fail.message)
        e.kind = fail.kind
        return e
      }

      // —— 路径一：无签名直连（扫码凭据即可，不需要客户端）——
      // 实测（2026-11-25）：只要有有效会话 cookie + 正确的 block 结构 body +
      // 与 cookie 配套的桌面身份参数，直连就能拿到正常正文。
      // 有客户端时额外带上 device_id（风控按它聚合，用客户端的更可信）。
      let raw = null
      let viaDirect = false
      if (config.directFirst) {
        const probe = getIdentity()
        // 账号池优先：多账号时凭据失效自动换号（成熟反代插件的通用做法）
        const pooled = listEnabledAccounts()
        const attempt = async cookieHeader => {
          const r = await directChat({
            body,
            identity: probe.found ? probe.identity : undefined,
            getCookie: async () => cookieHeader,
            signal: ac.signal,
          })
          return r.ok
            ? { ok: true, sse: r.sse }
            : { ok: false, kind: r.kind, message: r.message }
        }

        let result
        if (config.accountFailover !== false && pooled.length > 1) {
          const failover = await withAccountFailover({
            accounts: pooled,
            call: async (cookieHeader, account) => {
              const r = await attempt(cookieHeader)
              if (r.ok) log(`直连成功（账号 ${account.label ?? account.id}）`)
              return r
            },
          })
          result = failover.ok
            ? { ok: true, sse: failover.result.sse }
            : { ok: false, kind: failover.result?.kind ?? 'http', message: failover.message ?? '所有账号都失败了' }
          if (!failover.ok) log(`账号池全部失败（试了 ${failover.tried.length} 个）: ${result.message}`)
        } else {
          const cookie = await cookieSource()
          result = await attempt(cookie.header)
        }

        if (result.ok) {
          raw = result.sse
          viaDirect = true
        } else if (result.kind === 'auth') {
          // 凭据过期：先静默续期（用本地浏览器 profile，不弹窗），再试一次
          const { ensureSession } = await import('./src/session.js')
          const renewed = await ensureSession({ onProgress: m => log(`凭据续期: ${m}`) })
          if (!renewed.ok) {
            release()
            clearTimeout(timer)
            exec?.signal?.removeEventListener('abort', onAbort)
            throw new Error(
              `${result.message}。静默续期也失败：${renewed.message}。`
              + '跑一次 doubao_login 扫码登录即可（凭据会持久化，之后不需要重复扫）。',
            )
          }
          // 续期成功后再试一次直连
          const retry = await directChat({
            body,
            identity: probe.found ? probe.identity : undefined,
            getCookie: async () => (await cookieSource()).header,
            signal: ac.signal,
          })
          if (retry.ok) {
            raw = retry.sse
            viaDirect = true
          } else {
            if (retry.kind === 'risk') circuit.trip()
            release()
            clearTimeout(timer)
            exec?.signal?.removeEventListener('abort', onAbort)
            throw new Error(retry.message)
          }
        } else if (result.kind === 'risk') {
          // 风控：熔断并给出可行动指引（签名桥需要客户端）
          circuit.trip()
          release()
          clearTimeout(timer)
          exec?.signal?.removeEventListener('abort', onAbort)
          throw new Error(
            result.message
            + '。两个可行办法：① 在豆包网页端手工过一次滑块验证（账号级的，过了直连就通）；'
            + '② 装豆包电脑版并登录，插件会用它的签名通道重试。',
          )
        }
        // 其它失败（http 层，如请求体被拒）静默落进签名桥路径
      }

      // —— 路径二：CDP 签名桥（直连失败/被禁用时）——
      if (raw === null) {
        try {
          const client = await ensureSigner()
          raw = await client.postChat(body, ac.signal)
        } catch (error) {
          throw bail(error.message)
        }
      }

      let unknownFrames = 0
      const refusalTracker = createRefusalTracker()
      const { text, thinking } = await collectStream(
        (async function* stream() {
          for await (const line of lines(raw)) {
            const ev = parseSseLine(line)
            if (ev) yield ev
          }
        })(),
        () => {
          unknownFrames += 1
        },
      )
      release()
      clearTimeout(timer)
      exec?.signal?.removeEventListener('abort', onAbort)

      // 审核拦截识别：不让 canned 文案冒充模型回答
      if (isRefusal(text) || isDoubaoFallbackReply(text)) {
        const fail = classifyFailure(text)
        const e = new Error(fail.message)
        e.kind = fail.kind
        throw e
      }

      const notes = [
        viaDirect ? '本轮走直连（未触碰客户端签名）' : '本轮走 CDP 签名桥',
        '多轮历史已压平为单条 prompt；网页端没有真实会话状态',
      ]
      if (args.tools?.length) notes.push('工具调用为 <tool_call> 文本仿真，非上游原生通道')
      if (unknownFrames > 0) notes.push(`${unknownFrames} 个 SSE 帧未能识别，已按原样忽略（协议可能改版）`)
      if (budgeted.truncated) notes.push(`prompt 超预算，已截断（原 ${budgeted.original} 字符 → 32K 内）`)
      if (!text) notes.push('上游返回 0 长度文本，可能是 SSE 事件结构变了；先跑 doubao_status')

      let finalText = text
      let toolCalls
      if (args.tools?.length) {
        const parsed = extractToolCalls(text)
        finalText = parsed.text
        if (parsed.calls.length) toolCalls = parsed.calls
      }

      return {
        text: finalText,
        model,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        unknownFrames,
        notes,
      }
    },
  })

  ctx.tools.register({
    name: 'doubao_checkin',
    description:
      '领取豆包「天天领额度」的每日签到（平日 200 额度，周一翻倍）。'
      + '**只能在豆包电脑版客户端点真实按钮**——网页会话代签会返回 710010702 并作废当天额度（实测，不可回滚），所以本工具绝不盲试接口。'
      + 'dryRun: true 时用 Cookie 只读查询今天的签到状态（不需要客户端、绝对安全）。'
      + '真签到时若无客户端会明确告知原因；有客户端则通过 CDP 点击真实按钮，签名由客户端自己算。'
      + 'relaunchClient 打开时会重启正在运行的豆包客户端。',
    parameters: CHECKIN_PARAMETERS,
    output: {
      schema: CHECKIN_OUTPUT,
      render(_args, value) {
        const icon = value.ok ? '✓' : '✗'
        const lines = [`${icon} [${value.state}] ${value.message}`]
        if (value.before) {
          lines.push(`  签到前: canSign=${value.before.canSign} 按钮=${JSON.stringify(value.before.buttonLabels ?? [])}`)
        }
        if (value.after && typeof value.after === 'object') {
          lines.push(`  签到后: canSign=${value.after.canSign} rewarded=${value.after.rewarded}`)
        }
        if (value.client) lines.push(`  客户端: ${value.client}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        title: args.dryRun ? '豆包签到（只看状态）' : '豆包每日签到',
        kind: 'other',
        rawInput: args,
      }
    },
    async execute(args) {
      if (args.dryRun === true) return readCheckinStatus()

      // 真签到：只允许走客户端真实 UI（CDP）
      // 绝不发 /landing/checkin——网页代签返回 710010702 且作废当天额度，不可回滚。
      try {
        await findClient(args.exePath || config.exePath || undefined)
      } catch {
        return {
          ok: false,
          state: 'client_required',
          message:
            '签到只能在豆包电脑版客户端点真实按钮：网页会话代签会返回 710010702，'
            + '并且会把你今天的签到机会作废（实测，不可补救）。'
            + '请安装并登录豆包电脑版，然后我可以通过 CDP 帮你点按钮；'
            + '或你自己去客户端点一下「免费领额度」。想先看今天签没签，用 dryRun: true。',
        }
      }
      return runCheckin({
        port: config.cdpPort,
        exePath: args.exePath || config.exePath || undefined,
        dryRun: false,
        relaunchClient: args.relaunchClient ?? config.relaunchClient,
        timeoutMs: args.timeoutMs ?? 25_000,
      })
    },
  })

  ctx.tools.register({
    name: 'doubao_status',
    description:
      '检查豆包环境：客户端装在哪、CDP 端口通不通、页面有没有暴露签名函数、签到卡片什么状态。'
      + '不点击、不重启、不改任何东西。doubao_chat / doubao_checkin 出问题时先跑这个。',
    parameters: STATUS_PARAMETERS,
    output: {
      schema: STATUS_OUTPUT,
      render(_args, value) {
        return [{ type: 'text', text: value.summary }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall() {
      return { card: 'generic', title: '豆包环境检查', kind: 'other', rawInput: {} }
    },
    async execute() {
      const { findClient, listTargets } = await import('./src/checkin.js')
      const parts = []

      let clientFound = false
      let clientPath = ''
      try {
        clientPath = await findClient(config.exePath || undefined)
        clientFound = true
        parts.push(`客户端: ${clientPath}`)
      } catch (error) {
        parts.push(`客户端: 未找到（${error.message}）`)
      }

      let portOpen = false
      if (clientFound) {
        try {
          const targets = await listTargets(config.cdpPort)
          portOpen = true
          const pages = targets.filter(t => t.type === 'page')
          parts.push(`CDP ${config.cdpPort}: 已开，${pages.length} 个页面`)
          const doubao = pages.find(p => /doubao\.com/.test(p.url ?? ''))
          parts.push(
            doubao
              ? `豆包页面: ${doubao.url}`
              : '豆包页面: 没有（聊天时会自动开一个）',
          )
        } catch {
          parts.push(
            `CDP ${config.cdpPort}: 未开（`
            + (config.relaunchClient
              ? '调用时会重启客户端'
              : '需要在启动客户端时带 --remote-debugging-port，或打开 relaunchClient')
            + '）',
          )
        }
      }

      // 签到状态优先用 Cookie 只读查询（不需要客户端，不发任何领取请求——
      // 网页直接调领取接口会吃掉当天额度，这是实测结论，绝不能盲试）。
      let checkin
      const cookie = await cookieSource().catch(() => ({ header: '', source: 'none', ready: false }))
      if (cookie.header) {
        const { querySigninStatus } = await import('./src/signin-status.js')
        checkin = await querySigninStatus(cookie.header).catch(error => ({
          ok: false, state: 'error', message: error.message,
        }))
        parts.push(`签到状态: [${checkin.state}] ${checkin.message}（只读查询，来源：${cookie.source === 'saved' ? '扫码凭据' : '客户端'}）`)
        parts.push('  注：签到领取只能在豆包电脑版客户端点真实按钮；网页代签会作废当天额度')
      } else {
        checkin = await runCheckin({
          port: config.cdpPort,
          exePath: config.exePath || undefined,
          dryRun: true,
          relaunchClient: false,
          timeoutMs: 8000,
        }).catch(error => ({ ok: false, state: 'error', message: error.message }))
        parts.push(`签到状态: [${checkin.state}] ${checkin.message}（CDP 探测，无凭据）`)
      }

      return {
        clientFound,
        ...(clientPath ? { clientPath } : {}),
        portOpen,
        checkin,
        summary: parts.join('\n'),
      }
    },
  })

  // —— doubao_quota：额度看板（不消耗推理额度，只认 cookie 不验签名） ——
  ctx.tools.register({
    name: 'doubao_quota',
    description:
      '查询豆包账号剩余额度：套餐积分与活动赠送额度（签到领的那份），带重置倒计时。'
      + '只读、不消耗推理额度；借客户端 cookie 直连汇总端点（实测不验 a_bogus）。'
      + '读取失败返回 undefined 语义（「读不出」≠「没有」），不会静默显示 0。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer', description: '剩余额度合计。' },
          summary: { type: 'string' },
        },
        required: ['ok', 'summary'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall() {
      return { card: 'generic', title: '豆包额度查询', kind: 'other', rawInput: {} }
    },
    async execute(_args, exec) {
      try {
        // 额度端点只认 cookie：扫码凭据优先，无需客户端
        const cookie = await cookieSource().catch(() => ({ header: '', source: 'none', ready: false }))
        let payload
        if (cookie.header) {
          const probe = getIdentity()
          const query = probe.found
            ? buildDirectQuery(probe.identity)
            : `aid=582478&device_platform=web&_t=${Date.now()}`
          const res = await fetch(`https://www.doubao.com${QUOTA_PATH}?${query}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/plain, */*',
              origin: 'https://www.doubao.com',
              referer: 'https://www.doubao.com/chat/',
              cookie: cookie.header,
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
            },
            body: '{}',
            signal: exec?.signal,
          })
          if (!res.ok) throw new Error(`额度端点 HTTP ${res.status}`)
          payload = await res.json()
        } else {
          const client = await ensureSigner()
          payload = await client.getQuota(exec?.signal)
        }
        const parsed = parseQuotaSummary(payload)
        if (!parsed) {
          return {
            ok: false,
            summary: '额度端点返回了无法解析的结构（可能协议改版）。原始片段: '
              + JSON.stringify(payload).slice(0, 300),
          }
        }
        return {
          ok: true,
          total: parsed.total,
          windows: parsed.windows,
          source: cookie.source,
          summary: renderQuota(parsed.windows, parsed.total),
        }
      } catch (error) {
        const message = error?.message ?? String(error)
        return {
          ok: false,
          summary: `额度查询失败: ${message}\n`
            + '先跑 doubao_login（扫码登录）或 doubao_status 看凭据来源。',
        }
      }
    },
  })

  log(`已注册 doubao_chat / doubao_checkin / doubao_status / doubao_quota（CDP ${config.cdpPort}，默认模型 ${config.defaultModel}）`)

  // —— 卡片数据源：loopback 路由 ——
  // 关键：webServer 在插件 apply 时还没就绪（our-free-model 源码里明确记录过
  // ctx.get('webServer') 在真实 web 组合里返回 undefined，路由永远注册不上的坑）。
  // 必须用 ctx.inject(['webServer'], scoped => …) 等服务就绪后再注册。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      const server = scoped.webServer
      if (!server || typeof server.register !== 'function') return
      // —— 扫码登录状态机（卡片轮询用）——
      let loginTask = null
      let loginState = { phase: 'idle' }

      // 注意：必须传 scoped（而不是外层 ctx）——effect 要挂在 inject fiber 上，
      // webServer 被替换时回调重跑能正确清理旧路由，避免 duplicate route。
      registerQuotaRoute(scoped, {
        webServer: server,
        readCheckinStatus,
        readQuota: async () => {
          try {
            const cookie = await cookieSource().catch(() => ({ header: '', source: 'none', ready: false }))
            if (!cookie.header) {
              return { ok: false, summary: '尚未登录。用 doubao_login 扫码登录一次即可看到额度。' }
            }
            const probe = getIdentity()
            const query = probe.found
              ? buildDirectQuery(probe.identity)
              : `aid=582478&device_platform=web&_t=${Date.now()}`
            const res = await fetch(`https://www.doubao.com${QUOTA_PATH}?${query}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/plain, */*',
                origin: 'https://www.doubao.com',
                referer: 'https://www.doubao.com/chat/',
                cookie: cookie.header,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
              },
              body: '{}',
              signal: AbortSignal.timeout(20_000),
            })
            if (!res.ok) throw new Error(`额度端点 HTTP ${res.status}`)
            const payload = await res.json()
            const parsed = parseQuotaSummary(payload)
            if (!parsed) return { ok: false, summary: '额度端点返回了无法解析的结构（协议可能改版）' }
            return {
              ok: true,
              total: parsed.total,
              windows: parsed.windows,
              source: cookie.source,
              summary: renderQuota(parsed.windows, parsed.total),
            }
          } catch (error) {
            return { ok: false, summary: `读不了额度：${error.message}` }
          }
        },
        runCheckin: async () => {
          // 只允许客户端真实 UI；没客户端明确拒绝，绝不发网页领取接口（会作废当天额度）
          try {
            await findClient(config.exePath || undefined)
          } catch {
            return {
              ok: false,
              state: 'client_required',
              message: '签到只能在豆包电脑版客户端点真实按钮。网页代签会返回 710010702 并作废今天的额度（不可补救）。请先安装并登录客户端。',
            }
          }
          return runCheckin({
            port: config.cdpPort,
            exePath: config.exePath || undefined,
            dryRun: false,
            relaunchClient: config.relaunchClient,
            timeoutMs: 30_000,
          })
        },
        startLogin: async () => {
          if (loginTask) return loginState
          loginState = { phase: 'starting', message: '正在拉起浏览器…' }
          loginTask = loginWithBrowser({
            timeoutMs: 180_000,
            onProgress: msg => { loginState = { phase: 'waiting', message: msg } },
          }).then(result => {
            loginState = result.ok
              ? { phase: 'success', message: result.message, ok: true }
              : { phase: 'error', message: result.message, ok: false }
            return result
          }).catch(error => {
            loginState = { phase: 'error', message: error.message, ok: false }
            return { ok: false, message: error.message }
          }).finally(() => { loginTask = null })
          return loginState
        },
        pollLogin: () => loginState,
        cancelLogin: () => { loginState = { phase: 'idle' } },
        log,
    })
      log('卡片路由已注册: /plugins/dsh-doubao-signin/{quota,checkin/*,login/*}')
    })
  } else {
    // 无 ctx.inject 的环境（测试替身）：退回同步探测，不影响工具
    let webServer = undefined
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (!webServer || typeof webServer.register !== 'function') {
        try { webServer = ctx.webServer } catch { webServer = undefined }
      }
    } catch { webServer = undefined }
    if (webServer && typeof webServer.register === 'function' && typeof ctx.effect === 'function') {
      registerQuotaRoute(ctx, { webServer, readQuota: async () => ({ ok: false, summary: '测试环境' }), log })
    }
  }

  // —— 每日自动签到（对齐 our-free-model 的 auto-checkin 形态）——
  // DSH 启动后延迟一小段再跑；今天跑过就跳过；结果写进独立文档。
  //
  // ⚠️ 豆包的安全约束：网页端**没有**签到入口（活动页写着「仅支持在豆包电脑版参与」），
  // 盲调领取接口会返回 710010702 并作废当天额度。所以这里只在
  // **豆包电脑版客户端可用**时用 CDP 点它的真实按钮；否则如实告知。
  if (config.autoCheckin !== false) {
    const timer = setTimeout(() => {
      runAutoCheckin({
        delayMs: 0,
        log: m => log('自动签到: ' + m),
        accounts: () => listEnabledAccounts(),
        runOne: async () => {
          // 只在客户端可用时尝试（客户端会用自己的签名点真按钮）
          try {
            const r = await runCheckin({
              port: config.cdpPort,
              exePath: config.exePath || undefined,
              dryRun: false,
              relaunchClient: config.relaunchClient,
              timeoutMs: 25_000,
            })
            return { ok: r.ok === true, state: r.state ?? 'unknown', message: r.message }
          } catch (error) {
            return {
              ok: false,
              state: 'client_required',
              message: '签到需要豆包电脑版客户端（网页端没有签到入口，且网页代签会作废当天额度）：' + error.message,
            }
          }
        },
      }).catch(error => log('自动签到失败: ' + error.message))
    }, config.autoCheckinDelayMs ?? 30_000)
    timer.unref?.()
  }
}
