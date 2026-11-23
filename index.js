/**
 * dsh-plugin-doubao —— Host 半身。
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
 * @module dsh-plugin-doubao
 */
import { runCheckin } from './src/checkin.js'
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
  createRefusalTracker,
  isRefusal,
} from './src/hardening.js'
import { ClientSigner, lines } from './src/signer.js'
import { parseQuotaSummary, renderQuota } from './src/quota.js'
import { directChat } from './src/direct.js'
import { findClientIdentity, toIdentity } from './src/identity.js'

/** Cordis 插件名。 */
export const name = 'plugin-doubao'

/** 唯一硬依赖是 tools；缺了别的只是少功能，不应该让插件挂不上。 */
export const inject = ['tools']

/** 默认配置；patch 里的 config 会逐项覆盖。 */
export const DEFAULTS = {
  cdpPort: 9222,
  relaunchClient: false,
  exePath: '',
  defaultModel: 'doubao-pro-chat',
  timeoutMs: 180_000,
  /** 轮间最小间隔（毫秒）。 */
  minIntervalMs: 1500,
  /** 风控熔断冷却（毫秒）。 */
  riskCooldownMs: 10 * 60_000,
  /** 直连优先：健康账号不碰客户端、不需要调试端口。false 强制永远走 CDP 签名桥。 */
  directFirst: true,
  /** 直连被风控拒绝后，本次进程内是否还允许降级到 CDP 签名桥。 */
  allowBridgeFallback: true,
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
  const config = { ...DEFAULTS, ...rawConfig }
  const logger = makeLogger(ctx)
  const log = (...args) => {
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
      const budgeted = applyPromptBudget(JSON.parse(body.messages[0].content).text)
      if (budgeted.truncated) {
        body.messages[0].content = JSON.stringify({ text: budgeted.text })
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

      // —— 路径一：无签名直连（健康账号不碰客户端）——
      let raw = null
      let viaDirect = false
      if (config.directFirst) {
        const probe = getIdentity()
        if (probe.found) {
          const result = await directChat({
            body,
            identity: probe.identity,
            getCookie: async () => {
              // cookie 借 CDP 从客户端页面读（客户端运行中唯一不被锁的来源）。
              // 这里先起 signer 连接但不走签名路径。
              const client = await ensureSigner()
              return client.cookieHeader()
            },
            signal: ac.signal,
          })
          if (result.ok) {
            raw = result.sse
            viaDirect = true
          } else if (result.kind === 'risk' || result.kind === 'auth') {
            // 风控/未登录：直接判失败（risk 会让熔断器决定要不要降级桥）
            if (result.kind === 'risk') circuit.trip()
            release()
            clearTimeout(timer)
            exec?.signal?.removeEventListener('abort', onAbort)
            throw new Error(
              result.message
              + (config.allowBridgeFallback
                ? '。直连已被风控拦截，且签名桥同样依赖这个会话——请在豆包客户端里完成一次人机验证后再试。'
                : ''),
            )
          }
          // 其它失败（http 层）静默落进签名桥路径
        }
        // 身份没找到时也直接走签名桥（那边会给出指引）
      }

      // —— 路径二：CDP 签名桥（直连失败/被禁用/身份缺失时）——
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
      if (isRefusal(text)) {
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
      + '通过 CDP 点击客户端界面上的真实签到按钮完成，签名由客户端自己算，'
      + '因此不会把聊天用的账号风控打进冷却。已签到时直接返回，不重复点击。'
      + 'relaunchClient 打开时会重启正在运行的豆包客户端。'
      + '不确定状态时先用 dryRun: true。',
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
      return runCheckin({
        port: config.cdpPort,
        exePath: args.exePath || config.exePath || undefined,
        dryRun: args.dryRun === true,
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

      const checkin = await runCheckin({
        port: config.cdpPort,
        exePath: config.exePath || undefined,
        dryRun: true,
        relaunchClient: false,
        timeoutMs: 8000,
      }).catch(error => ({ ok: false, state: 'error', message: error.message }))

      parts.push(`签到状态: [${checkin.state}] ${checkin.message}`)

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
        const client = await ensureSigner()
        const payload = await client.getQuota(exec?.signal)
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
          summary: renderQuota(parsed.windows, parsed.total),
        }
      } catch (error) {
        const message = error?.message ?? String(error)
        if (/客户端|端口|frontierSign|doubao\.com 页面/.test(message)) {
          return { ok: false, summary: `读不了额度（${message}）。额度查询同样需要客户端在运行且 CDP 端口已开。` }
        }
        return { ok: false, summary: `额度查询失败: ${message}` }
      }
    },
  })

  log(`已注册 doubao_chat / doubao_checkin / doubao_status / doubao_quota（CDP ${config.cdpPort}，默认模型 ${config.defaultModel}）`)
}