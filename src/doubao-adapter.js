/**
 * 豆包 LLM adapter —— 让豆包模型出现在 DSH 模型选择器里。
 *
 * 契约来自本机源码实读（dsh-llm/src/index.ts:416 registerAdapter）：
 * - inject 加 'llm'，注册 handler 只调 providerInfo / providerRetryPolicy；
 * - listModels 返回非空数组才会进入选择器（空数组 = 分组被过滤）；
 * - prepareCall 将解析后的模型信息与本适配器的流式调用绑定；
 * - 上下文预算检查还会读取图片估算和尺寸投影接口；
 * - stream(options) 是核心：输入 GenerateOptions，产出 StreamChunk；
 * - block-start/block-end 成对，usage 在 finish 前，finish 最后；
 * - 纯手写对象即可（our-free-model 已跑通），不需要 extends / pi-ai / 新 peerDependency。
 *
 * @module src/doubao-adapter.js
 */
import { MODELS, buildChatBody, modelReasoningInfo, parseSseLine, renderToolPrompt, extractToolCalls, flattenMessages } from './protocol.js'
import { directChat } from './direct.js'
import { lines } from './signer.js'
import { localSessionTitle } from './session-title.js'
import { classifyFailure, isDoubaoFallbackReply } from './hardening.js'

/** 注册到选择器的 provider id。 */
export const PROVIDER = 'doubao'

function upstreamErrorCode(frame) {
  let data = frame?.event_data ?? frame?.eventData ?? frame?.data
  if (typeof data === 'string' && data.trimStart().startsWith('{')) {
    try { data = JSON.parse(data) } catch { data = undefined }
  }
  for (const details of [frame, frame?.error, data, data?.error]) {
    if (!details || typeof details !== 'object') continue
    if (/^[1-9]\d{0,9}$/.test(details.error_code ?? '')) return String(details.error_code)
    if (/^710\d{6}$/.test(details.code ?? '')) return String(details.code)
  }
  return undefined
}

const UPSTREAM_ERROR_MESSAGES = {
  '710012001': '豆包登录已失效（710012001）。',
  '710020202': '豆包拒绝了本次请求参数（710020202）。',
  '710022004': '豆包上游要求完成账号验证（710022004）。',
}

/**
 * 创建豆包 adapter。
 * @param {object} deps - 依赖（全部来自 index.js 的闭包）。
 * @param {object} deps.config - 配置。
 * @param {Function} deps.getIdentity - 取设备身份。
 * @param {Function} deps.cookieSource - 取 cookie {header, source, ready}。
 * @param {Function} deps.ensureSigner - 取签名桥。
 * @param {Function} deps.log - 日志。
 * @returns {object} adapter。
 */
export function createDoubaoAdapter({ config, getIdentity, cookieSource, ensureSigner, log = () => {} }) {
  /**
   * 选路并拿 SSE 原文：直连优先（有设备身份时），否则 CDP 签名桥。
   * @param {string} model - 模型 id。
   * @param {object} options - GenerateOptions。
   * @returns {Promise<{sse: string, requestId?: string}>} SSE 原文与上游请求编号。
   */
  async function pickRaw(model, options) {
    const msgs = options.system
      ? [{ role: 'system', content: options.system }, ...(options.messages ?? [])]
      : (options.messages ?? [])
    const toolPrompt = options.tools?.length ? renderToolPrompt(options.tools) : ''
    const body = buildChatBody({
      model,
      messages: msgs,
      toolPrompt,
      reasoningEffort: options.reasoningEffort,
    })

    // 直连：扫码凭据即可（有客户端时额外带 device_id，风控按它聚合，客户端的更可信）
    if (config.directFirst !== false) {
      const probe = getIdentity()
      const r = await directChat({
        body,
        identity: probe.found ? probe.identity : undefined,
        getCookie: async () => (await cookieSource()).header,
        signal: options.signal,
      })
      if (r.ok) return r
      if (r.kind === 'auth') {
        // 凭据过期：静默续期（不弹窗），再试一次
        const { ensureSession } = await import('./session.js')
        const renewed = await ensureSession({ onProgress: m => log(`凭据续期: ${m}`) })
        if (!renewed.ok) {
          throw new Error(`${r.message}。静默续期也失败：${renewed.message}。跑一次 doubao_login 扫码登录即可。`)
        }
        const retry = await directChat({
          body,
          identity: probe.found ? probe.identity : undefined,
          getCookie: async () => (await cookieSource()).header,
          signal: options.signal,
        })
        if (retry.ok) return retry
        log(`直连续期后仍失败(${retry.kind}): ${retry.message}`)
      } else {
        log(`直连失败(${r.kind})，降级 CDP 签名桥: ${r.message}`)
      }
    }

    const client = await ensureSigner()
    return { sse: await client.postChat(body, options.signal) }
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: '豆包 Doubao' }
    },

    /**
     * 重试策略。
     *
     * 必须实现：dsh-llm 的 prepareRoutes 会**直接调用** adapter.providerRetryPolicy(provider)
     * （src/index.ts），不是可选探测——纯手写 adapter 缺这个方法，注册时抛 TypeError，
     * 表现为「模型不进选择器」。继承 LlmAdapter 基类的插件有默认实现所以没事。
     *
     * 返回的是**已解析策略**（不是配置片段）：延迟字段摊平在顶层。
     * 嵌进 backoff: {} 会让调度器读到 NaN，把可恢复的瞬时故障变成中止的回合
     * （our-free-model 源码里记了这个坑）。
     *
     * RATE_LIMIT 故意不在重试集里：豆包风控对重试敏感（710022004 是滑块验证，
     * 重试只会加深它），这与我自己的 Circuit 熔断是同一个道理。
     * @param {string} _provider - 路由 id（未使用，策略与具体路由无关）。
     * @returns {object} 已解析的重试策略。
     */
    providerRetryPolicy(_provider) {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        initialDelayMs: 700,
        maxDelayMs: 8000,
        jitterRatio: 0.2,
      })
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels(provider) {
      // LlmModelInfo: { provider, id, name, description?, inputModalities?, badge? }
      // name 是选择器里显示的模型名，description 是副标题——别把描述塞进 name。
      //
      // 默认只注册**对话面**模型（agentMode !== 1）。工作模式模型（agentMode === 1，
      // 如 doubao-auto / kimi-k3 / glm-5.3）需要豆包工作会员额度；普通账号选它们
      // 只会得到「出了点问题，请稍后重试。」——列出来就是让人踩坑。
      // 有会员额度的账号可在 cordis.patch.yml 里开 includeWorkModels: true。
      const includeWork = config.includeWorkModels === true
      return Object.entries(MODELS)
        .filter(([, m]) => includeWork || m.agentMode !== 1)
        .map(([id, m]) => ({
          provider,
          id,
          name: m.name ?? id,
          ...(m.desc ? { description: m.desc } : {}),
          inputModalities: ['text'],
        }))
    },

    async resolveModel(provider, model) {
      const known = MODELS[model]
      const reasoning = modelReasoningInfo(model)
      return {
        provider,
        id: model,
        name: known?.name ?? model,
        ...(known?.desc ? { description: known.desc } : {}),
        inputModalities: ['text'],
        ...(reasoning ? { reasoning } : {}),
        context: { contextWindow: known?.contextWindow ?? 131_072 },
        defaultMaxTokens: 32_768,
      }
    },

    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted()
      const modelInfo = await this.resolveModel(provider, model, signal)
      signal?.throwIfAborted()
      return {
        model: modelInfo,
        stream: options => this.stream(options),
      }
    },

    async *stream(options) {
      // —— DSH 自动标题请求：本地产出，零请求、零豆包对话记录 ——
      // 每开一个新会话 DSH 都会发这种请求；走豆包会在客户端/手机里冒一条
      // 「简短会话交互」记录（截图实证），还会消耗额度。它在本地就能完成。
      const localTitle = localSessionTitle(options)
      if (localTitle !== undefined) {
        log('标题请求本地生成（未发往豆包）: ' + localTitle.slice(0, 30))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: localTitle }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: localTitle } }
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      const model = MODELS[options.model] ? options.model : (config.defaultModel ?? 'doubao')
      let upstream
      try {
        upstream = await pickRaw(model, options)
      } catch (error) {
        // 两条路都不通时，把「怎么办」说清楚——网页直连被风控 + 没有客户端签名器
        const msg = String(error?.message ?? error)
        if (/710022004|人机验证|滑块/.test(msg)) {
          throw new Error(
            '豆包拒绝了这次请求（风控 710022004，需要人机验证）。'
            + '两条可行路径：① 装豆包电脑版并登录，插件会用它的签名通道重试；'
            + '② 在豆包网页端手工过一次滑块验证后立刻再试。',
          )
        }
        if (/客户端|CDP|调试端口|端口/.test(msg)) {
          throw new Error(
            '没有可用的豆包通道：网页直连会被风控拦（710022004），'
            + '而 CDP 签名桥需要豆包电脑版客户端在运行。'
            + '请安装并登录豆包电脑版（客户端会提供签名能力），或先在网页端过一次滑块。',
          )
        }
        throw error
      }

      // 来源标记：每个 DSH→豆包 的对话都在日志里留一行，便于对照豆包客户端里的记录
      log(`[DSH→豆包] 模型=${model} requestId=${upstream.requestId ?? '-'} 消息数=${(options.messages ?? []).length}`)

      // 全文 SSE → 事件数组（postChat/directChat 都是一次性拿全文，无法逐块流式）
      const events = []
      for await (const line of lines(upstream.sse)) {
        const ev = parseSseLine(line)
        if (ev) events.push(ev)
      }

      const providerCode = events.map(event => upstreamErrorCode(event.raw)).find(Boolean)
      const replyText = events.filter(event => event.kind === 'text').map(event => event.text).join('')
      if (providerCode || isDoubaoFallbackReply(replyText)) {
        let message = providerCode
          ? (UPSTREAM_ERROR_MESSAGES[providerCode] ?? '豆包上游返回错误码 ' + providerCode + '。')
          : classifyFailure(replyText).message
        // 工作模式模型（agentMode=1）在**没有明确错误码、只回通用失败**时，
        // 可能是没会员额度——给个提示。但注意：
        // 1. 有明确错误码（尤其 710022004 风控）时**不要**追加会员猜测——会误导；
        // 2. 实测账号有 has_active_subscription=true（免费体验会员），别再说"没开通"。
        if (!providerCode && MODELS[model]?.agentMode === 1) {
          message += ' 这是「豆包工作」模型，通用失败有时与工作权益有关；'
          + '若你账号没开通工作权益，可改选「豆包」或「豆包 专家」（对话面）。'
        }
        // 风控给可行动指引（装了客户端就走页面中继，B 路线）
        if (providerCode === '710022004') {
          message += ' 请先到豆包网页端完成一次人机验证（滑块），或等冷却过去再试。'
          + ' 已装豆包电脑版时，降级会用客户端页面 fetch 中继（会在豆包留下对话记录）。'
        }
        const code = 'DOUBAO_UPSTREAM_ERROR'
        const requestId = upstream.requestId
        log('豆包调用失败（' + model + '）：' + message)
        throw Object.assign(new Error(message), { code, failure: { code, message, ...(requestId ? { requestId } : {}) } })
      }

      let idx = 0

      // 工具调用：文本仿真 → 解析 → tool-call 块
      if (options.tools?.length) {
        const parsed = extractToolCalls(replyText)
        if (parsed.text?.trim()) {
          const t = parsed.text.trim()
          yield { type: 'block-start', index: idx, blockType: 'text' }
          yield { type: 'text-delta', index: idx, text: t }
          yield { type: 'block-end', index: idx, block: { type: 'text', text: t } }
          idx++
        }
        for (const call of parsed.calls) {
          const args = call.function?.arguments ?? '{}'
          const name = call.function?.name ?? 'unknown'
          yield { type: 'block-start', index: idx, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: idx, id: call.id, name, argumentsDelta: args }
          yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: call.id, name, arguments: args } }
          idx++
        }
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: parsed.calls.length ? 'tool-calls' : 'stop' } }
        return
      }

      // 普通对话：text / reasoning 各自成块
      let text = ''
      let reasoning = ''
      let textOpen = false
      let reasonOpen = false
      const reasonIdx = 1
      for (const ev of events) {
        if (ev.kind === 'text') {
          if (!textOpen) {
            yield { type: 'block-start', index: idx, blockType: 'text' }
            textOpen = true
          }
          yield { type: 'text-delta', index: idx, text: ev.text }
          text += ev.text
        } else if (ev.kind === 'think') {
          if (!reasonOpen) {
            yield { type: 'block-start', index: reasonIdx, blockType: 'reasoning' }
            reasonOpen = true
          }
          yield { type: 'reasoning-delta', index: reasonIdx, text: ev.text }
          reasoning += ev.text
        }
      }
      if (textOpen) yield { type: 'block-end', index: idx, block: { type: 'text', text } }
      if (reasonOpen) yield { type: 'block-end', index: reasonIdx, block: { type: 'reasoning', text: reasoning } }

      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

void flattenMessages
