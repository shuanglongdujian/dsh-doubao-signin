/**
 * 豆包网页协议的纯逻辑层：请求体构建、SSE 解析、工具调用抽取。
 *
 * 这一层不碰网络、不碰浏览器，因此可以离线单测。所有"没对上"的协议帧都会落到
 * `unknownEvents` 里，不会静默变成空回复。
 *
 * @module src/protocol.js
 */

/** 已知模型档案。`itemKey` 来自豆包工作台的路由键，不是火山方舟的 model id。 */
export const MODELS = {
  'doubao-pro-chat': { kind: 'chat', desc: '豆包主对话（默认）' },
  'doubao-lite': { kind: 'chat', itemKey: 'seed-lite-7b', desc: '轻量快速' },
  'doubao-work-auto': { kind: 'chat', itemKey: '9', workspace: true, desc: '豆包工作自动路由' },
  'doubao-2.1-pro': { kind: 'chat', itemKey: '5', workspace: true, desc: '豆包 2.1 Pro' },
  'deepseek-v4.1-flash': { kind: 'chat', itemKey: 'person-deepseek-v4-1-flash-261017', workspace: true, desc: '豆包工作里的 DeepSeek' },
  'kimi-k3': { kind: 'chat', itemKey: 'person-kimi-k3-261111', workspace: true, desc: '豆包工作里的 Kimi' },
  'glm-5.3': { kind: 'chat', itemKey: 'person-glm-5-3-261111', workspace: true, desc: '豆包工作里的 GLM' },
}

/** 默认路由用的 bot id。 */
export const DEFAULT_BOT_ID = '7338286299411103781'

/** 老纯 HTTP 路径的 bot id，实测对比时用。 */
export const LEGACY_BOT_ID = '7234781073513644036'

/** 聊天上游路径。 */
export const CHAT_PATH = '/chat/completion'

/** 签到卡片的活动页。 */
export const CHECKIN_PAGE = 'https://www.doubao.com/pc/agent-explore'

/** 签到卡片的语义锚点，换期也可能还认得。 */
export const DAILY_REWARD_CODE = 'daily_signin'

/**
 * 生成一个会话 id。用 crypto.randomUUID 而不是自增，避免多进程撞号。
 * @returns {string} UUID v4 字符串。
 */
export function newConversationId() {
  return globalThis.crypto.randomUUID()
}

/**
 * 把 OpenAI 风格的 messages 压平成一条 prompt。
 *
 * 豆包网页端每次都是"发一条新消息"，没有 messages 数组语义，所以多轮只能文本重现。
 * 这是本插件最大的功能损失，必须在返回里如实标注，不能假装有真会话状态。
 * @param {Array<object>} messages - OpenAI 风格的 messages。
 * @returns {string} 压平后的 prompt。
 */
export function flattenMessages(messages) {
  const chunks = []
  for (const m of messages ?? []) {
    const role = m?.role ?? 'user'
    const content = m?.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter(p => p && typeof p === 'object' && (p.type === 'text' || p.type === 'input_text'))
        .map(p => p.text ?? '')
        .join('')
    } else if (content != null) {
      text = String(content)
    }
    if (!text.trim()) continue
    const label = { system: '[系统设定]', user: '[用户]', assistant: '[助手]', tool: '[工具结果]' }[role] ?? `[${role}]`
    chunks.push(`${label}\n${text.trim()}`)
  }
  return chunks.join('\n\n').trim()
}

/**
 * 按模型档案构建上游请求体。
 * @param {object} req - { model, messages, conversationId, reasoningEffort, toolPrompt, deepThink }。
 * @returns {object} 可直接发给 `/chat/completion` 的 JSON body。
 */
export function buildChatBody(req) {
  const profile = MODELS[req.model]
  if (!profile) throw new Error(`model_not_found: ${req.model}`)
  if (profile.kind !== 'chat') throw new Error(`model_not_chat: ${req.model}`)

  let prompt = flattenMessages(req.messages)
  if (req.toolPrompt) prompt = `${req.toolPrompt}\n\n${prompt}`

  const conversationId = req.conversationId || newConversationId()
  const body = {
    messages: [
      {
        content: JSON.stringify({ text: prompt }),
        content_type: 2001,
        attachments: [],
        references: [],
        role: 'user',
      },
    ],
    completion_option: {
      is_regen: false,
      with_suggest: false,
      need_create_conversation: !req.conversationId,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      is_zen: false,
      use_deep_think: false,
      use_auto_think: false,
      use_truncate: false,
    },
    conversation_id: conversationId,
    local_conversation_id: `local_${conversationId}`,
    local_message_id: globalThis.crypto.randomUUID(),
    bot_id: DEFAULT_BOT_ID,
    evaluate_options: {},
    section_options: {},
  }

  const option = body.completion_option
  if (profile.workspace) {
    option.agent_mode = 1
    option.conversation_mode = 1
    option.reasoning_effort = req.reasoningEffort || 'medium'
    body.conversation_init_ext = { agent_mode: 1, model_item_key: profile.itemKey ?? '' }
    body.model_config = { model_item_key: profile.itemKey ?? '' }
    body.aggregate_params = { model_item_key: profile.itemKey ?? '' }
  } else if (profile.itemKey) {
    body.model_config = { model_item_key: profile.itemKey }
  } else {
    option.need_deep_think = Boolean(req.deepThink)
  }

  return body
}

/**
 * 解析一行 SSE。
 * @param {string} line - 一行原文。
 * @returns {{kind: 'text'|'think'|'done'|'unknown', text?: string, raw?: object}|null} 事件；非数据行返回 null。
 */
export function parseSseLine(line) {
  let s = String(line ?? '').trim()
  if (!s || s.startsWith(':')) return null
  if (s.startsWith('event:')) return null
  if (s.startsWith('data:')) s = s.slice(5).trim()
  if (!s) return null
  if (s === '[DONE]') return { kind: 'done' }

  let payload
  try {
    payload = JSON.parse(s)
  } catch {
    // 有些实现直接回纯文本块
    return /^[{[]/.test(s) ? { kind: 'unknown', raw: { unparsed: s.slice(0, 500) } } : { kind: 'text', text: s }
  }
  if (!payload || typeof payload !== 'object') return { kind: 'unknown', raw: { payload } }

  let data = payload.event_data ?? payload.eventData ?? payload.data
  if (typeof data === 'string' && data.trimStart().startsWith('{')) {
    try {
      data = JSON.parse(data)
    } catch {
      return { kind: 'text', text: data, raw: payload }
    }
  }

  if (data && typeof data === 'object') {
    const msg = data.message && typeof data.message === 'object' ? data.message : data
    const content = msg?.content
    if (typeof content === 'string' && content) {
      return msg?.content_type === 2006 ? { kind: 'think', text: content, raw: payload } : { kind: 'text', text: content, raw: payload }
    }
    if (content && typeof content === 'object' && typeof content.text === 'string' && content.text) {
      return { kind: 'text', text: content.text, raw: payload }
    }
    if (data.is_finish || data.finish_reason) return { kind: 'done', raw: payload }
  }

  const eventType = payload.event_type ?? payload.eventType
  if (eventType === 2003 || eventType === 2004 || eventType === 'done' || eventType === 'finish') {
    return { kind: 'done', raw: payload }
  }
  if (typeof data === 'string' && data) return { kind: 'text', text: data, raw: payload }

  return { kind: 'unknown', raw: payload }
}

/** 文本仿真工具调用的提示词模板。 */
export const TOOL_PROMPT_TEMPLATE = `你可以调用以下工具。需要时严格按这个格式输出，一次可以输出多个块：

<tool_call>{"name": "<工具名>", "arguments": {<JSON 参数>}}</tool_call>

可用工具：
{tools}

规则：
1. 只在确实需要外部信息或执行动作时调用，不要为了展示而调用。
2. 输出 <tool_call> 块时不要额外的解释文字。
3. 参数必须是合法 JSON，不带注释。
4. 如果不需要工具，直接回答。`

/**
 * 把 OpenAI tools 声明渲染成注入用的提示词。
 * @param {Array<object>} tools - OpenAI tools 数组。
 * @returns {string} 注入到 prompt 前面的说明。
 */
export function renderToolPrompt(tools) {
  const lines = []
  for (const t of tools ?? []) {
    const fn = t?.function ?? t ?? {}
    lines.push(`- ${fn.name ?? 'unknown'}: ${fn.description ?? ''}\n  参数 schema: ${JSON.stringify(fn.parameters ?? {})}`)
  }
  return TOOL_PROMPT_TEMPLATE.replace('{tools}', lines.join('\n'))
}

/**
 * 从模型输出里抠 `<tool_call>` 块。
 * 解析失败的块原样留在文本里，绝不悄悄吞掉。
 * @param {string} text - 模型原始输出。
 * @returns {{text: string, calls: Array<object>}} 剩余文本与 OpenAI tool_calls。
 */
export function extractToolCalls(text) {
  const calls = []
  const leftover = []
  let idx = 0
  const src = String(text ?? '')
  const OPEN = '<tool_call>'
  const CLOSE = '</tool_call>'
  while (true) {
    const start = src.indexOf(OPEN, idx)
    if (start === -1) {
      leftover.push(src.slice(idx))
      break
    }
    const end = src.indexOf(CLOSE, start)
    if (end === -1) {
      leftover.push(src.slice(idx))
      break
    }
    leftover.push(src.slice(idx, start))
    const blob = src.slice(start + OPEN.length, end).trim()
    const whole = src.slice(start, end + CLOSE.length)
    try {
      const obj = JSON.parse(blob)
      const name = obj?.name ?? obj?.tool
      let args = obj?.arguments ?? obj?.args ?? {}
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          // 参数是字符串但不是 JSON：原样传，符合 OpenAI 的 arguments 是字符串的约定
        }
      }
      if (name) {
        calls.push({
          id: `call_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
          type: 'function',
          function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        })
      } else {
        leftover.push(whole)
      }
    } catch {
      leftover.push(whole)
    }
    idx = end + CLOSE.length
  }
  return { text: leftover.join('').trim(), calls }
}

/**
 * 把 SSE 事件流收敛成最终文本。
 * @param {AsyncIterable<{kind: string, text?: string, raw?: object}>} events - 事件流。
 * @param {(frame: object) => void} [onUnknown] - 未识别帧的回调。
 * @returns {Promise<{text: string, thinking: string}>} 文本与思考过程。
 */
export async function collectStream(events, onUnknown) {
  let text = ''
  let thinking = ''
  for await (const ev of events) {
    if (ev.kind === 'text') text += ev.text ?? ''
    else if (ev.kind === 'think') thinking += ev.text ?? ''
    else if (ev.kind === 'unknown') onUnknown?.(ev.raw)
    else if (ev.kind === 'done') break
  }
  return { text, thinking }
}