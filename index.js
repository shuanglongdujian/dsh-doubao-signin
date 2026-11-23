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
import { ClientSigner, lines } from './src/signer.js'

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

      const messages = []
      if (args.system) messages.push({ role: 'system', content: args.system })
      messages.push({ role: 'user', content: args.prompt })

      const toolPrompt = args.tools?.length ? renderToolPrompt(args.tools) : ''
      const body = buildChatBody({ model, messages, toolPrompt })

      const client = await ensureSigner()
      const budget = args.timeoutMs ?? config.timeoutMs
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('doubao_chat 超时')), budget)
      const onAbort = () => ac.abort(new Error('调用方取消'))
      exec?.signal?.addEventListener('abort', onAbort, { once: true })

      let raw
      try {
        raw = await client.postChat(body, ac.signal)
      } finally {
        clearTimeout(timer)
        exec?.signal?.removeEventListener('abort', onAbort)
      }

      let unknownFrames = 0
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

      const notes = ['多轮历史已压平为单条 prompt；网页端没有真实会话状态']
      if (args.tools?.length) notes.push('工具调用为 <tool_call> 文本仿真，非上游原生通道')
      if (unknownFrames > 0) notes.push(`${unknownFrames} 个 SSE 帧未能识别，已按原样忽略（协议可能改版）`)
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

  log(`已注册 doubao_chat / doubao_checkin / doubao_status（CDP ${config.cdpPort}，默认模型 ${config.defaultModel}）`)
}