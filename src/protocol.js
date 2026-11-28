/**
 * 豆包网页协议的纯逻辑层：请求体构建、SSE 解析、工具调用抽取、模型目录。
 *
 * 这一层不碰网络、不碰浏览器，因此可以离线单测。所有"没对上"的协议帧都会落到
 * `unknownEvents` 里，不会静默变成空回复。
 *
 * ## 模型目录
 *
 * 目录来自 [dsh-plugin-doubao](https://github.com/woc-jpg/dsh-plugin-doubao)（MIT）
 * 在 2026-11-19 实测读到的豆包菜单清单（`/alice/slot/action_bar_v3/brief_list`）。
 * 每个模型带：
 * - `itemKey`：上线路由键（请求里 `model_item_key` 就是它）；
 * - `modeId`/`agentMode`/`convMode`：请求形态的三元组（**必须整体一致**——
 *   客户端切换模型时这三个一起变；只改一个会让上游按错的形态应答）；
 * - `effort`：默认思考档位，`levels` 记录各模型实际支持的档位和顺序；
 * - `extraParams`：`model_extra_params`，要**原样转发**——它告诉服务端预留多少内存。
 *
 * 有客户端（能从 `Local State` 读到 device_id）时可以动态拉取菜单刷新这份表；
 * 没有客户端时用这份快照，保证选择器永远不为空。
 *
 * @module src/protocol.js
 */

/** 已知模型档案（快照 2026-11-19，共 16 个）。 */
export const MODELS = {
  'doubao': {
    kind: 'chat', itemKey: '0', name: '豆包', desc: '豆包快速',
    modeId: '1', agentMode: 2, convMode: 1, effort: 3, deepThink: 0,
    levels: [], extraParams: undefined, contextWindow: 131_072,
  },
  'doubao-expert': {
    kind: 'chat', itemKey: '3', name: '豆包 专家', desc: '豆包专家模式',
    modeId: '1', agentMode: 2, convMode: 1, effort: 3, deepThink: 1,
    levels: [3, 4, 5], extraParams: undefined, contextWindow: 131_072,
  },
  'doubao-auto': {
    kind: 'chat', itemKey: '9', name: '豆包 自动', desc: '豆包工作自动路由（会员额度）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 9,
    levels: [3, 8, 5], extraParams: { total_window_size: '256000' }, contextWindow: 256_000,
  },
  'doubao-2.1-lite': {
    kind: 'chat', itemKey: 'seed-lite-7b', name: '豆包 2.1 Lite', desc: '轻量（限时优惠 0.01x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5], extraParams: { memory_profile: '256k', total_window_size: '256000' }, contextWindow: 256_000,
  },
  'doubao-2.1-pro': {
    kind: 'chat', itemKey: '5', name: '豆包 2.1 Pro', desc: '豆包 2.1 Pro（0.65x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 5,
    levels: [3, 4, 5], extraParams: { total_window_size: '256000' }, contextWindow: 256_000,
  },
  'deepseek-v4.1-flash': {
    kind: 'chat', itemKey: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash',
    desc: '豆包里的 DeepSeek（限时优惠 0.01x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5, 6, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'qwen4-max': {
    kind: 'chat', itemKey: 'person-qwen4-max', name: 'Qwen 4 Max', desc: '豆包里的 Qwen',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 5, 6],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'kimi-k3.1-pro': {
    kind: 'chat', itemKey: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', desc: '豆包里的 Kimi（0.95x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5, 6, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'kimi-k3.1-pro-highspeed': {
    kind: 'chat', itemKey: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速',
    desc: '豆包里的 Kimi 高速（1.44x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5, 6, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'kimi-k3': {
    kind: 'chat', itemKey: 'person-kimi-k3-261111', name: 'Kimi K3', desc: '豆包里的 Kimi（1.48x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5, 6, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'glm-5.3': {
    kind: 'chat', itemKey: 'person-glm-5-3-261111', name: 'GLM 5.3', desc: '豆包里的 GLM（0.80x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8,
    levels: [3, 5, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'glm-5.3-flash': {
    kind: 'chat', itemKey: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', desc: '豆包里的 GLM 极速（0.08x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8,
    levels: [3, 5, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'deepseek-v4-pro': {
    kind: 'chat', itemKey: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro',
    desc: '豆包里的 DeepSeek Pro（0.46x）',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 4, 5, 6, 7],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'qwen3.8-max': {
    kind: 'chat', itemKey: 'person-qwen3-8-max', name: 'Qwen 3.8 Max', desc: '豆包里的 Qwen 3.8',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 5, 6],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
  'qwen3.8-flash': {
    kind: 'chat', itemKey: 'person-qwen3-8-flash', name: 'Qwen 3.8 Flash', desc: '豆包里的 Qwen 3.8 极速',
    modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    levels: [3, 5, 6],
    extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000,
  },
}

const REASONING_LEVELS = {
  3: { id: 'low', name: '低' },
  4: { id: 'medium', name: '中' },
  5: { id: 'high', name: '高' },
  6: { id: 'xhigh', name: '极高' },
  7: { id: 'max', name: '最高' },
  8: { id: 'medium', name: '中' },
}

/** 将模型档位目录转换成 Harness 使用的档位和默认值。 */
export function modelReasoningInfo(model) {
  const profile = MODELS[model]
  if (!profile?.levels?.length) return undefined
  return {
    efforts: profile.levels.map(level => ({ ...REASONING_LEVELS[level] })),
    defaultEffort: REASONING_LEVELS[profile.effort].id,
  }
}

/** 默认模型（对话面、速度最快）。 */
export const DEFAULT_MODEL = 'doubao'

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

  // 请求体形状：**content_block 块结构**（实测 2026-11 唯一可用的形态）。
  // 早先用 messages[].content 字符串 + completion_option，豆包网关一律回
  // 710020202 common invalid param —— 它认的是 block 结构。
  //
  // modeId / agentMode / convMode / effort 是**模型形态四元组**，必须整体一致
  // （客户端切换模型时这四个一起变）；extraParams（model_extra_params）要原样转发。
  const key = profile.itemKey ?? '0'
  const modeId = profile.modeId ?? '1'
  const agentMode = profile.agentMode ?? 2
  const convMode = profile.convMode ?? 1
  const requested = req.reasoningEffort
  const requestedLevel = profile.levels?.find(level => (
    requested === REASONING_LEVELS[level].id || requested === level || requested === String(level)
  ))
  const effort = String(requestedLevel ?? profile.effort ?? 3)
  const deepThink = profile.deepThink ?? 0

  const body = {
    client_meta: {
      local_conversation_id: `local_${conversationId.replace(/-/g, '').slice(0, 16)}`,
      conversation_id: conversationId,
      bot_id: DEFAULT_BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: globalThis.crypto.randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
              pc_event_block: '',
            },
            block_id: globalThis.crypto.randomUUID(),
            parent_id: '',
            meta_info: [],
            extra_info: {},
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      agent_mode: agentMode,
      need_deep_think: deepThink,
      scene_type: 0,
      need_create_conversation: !req.conversationId,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: key, reasoning_effort: effort, mode_id: modeId },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_old_user: true,
      mention_skill_list: '[]',
      mention_plugin_list: '[]',
      mention_ext: '[{}]',
      conversation_mode: convMode,
      mode_id: modeId,
      model_item_key: key,
      reasoning_effort: effort,
      provider_id: '',
    },
    conversation_mode: convMode,
    unique_key: globalThis.crypto.randomUUID(),
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: String(deepThink),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  }

  // model_extra_params 原样转发——它告诉服务端预留多少内存（不转发会被压到小窗口）
  if (profile.extraParams) {
    body.model_extra_params = { ...profile.extraParams }
  }

  return body
}

/**
 * 解析一行 SSE。
 *
 * **实测格式（2026-11-25，带真实凭据抓的帧）**：豆包的正文不是
 * `event_data.message.content`，而是**补丁式增量**：
 *
 * ```
 * event: STREAM_CHUNK
 * data: {"patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[
 *   {"block_type":10000,"block_id":"...","content":{"text_block":{"text":"好"}},"is_finish":false}]}}]}
 * ```
 *
 * `block_type` 10000 = 正文，10040 = 思考容器（其子块是正文时另算）。
 * 早先只认 `event_data.message.content` 的解析器在这种帧上**返回空**——
 * 所以聊天"没反应"的根因在这里。
 *
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

  // ── 补丁式增量（实测形态：STREAM_CHUNK）──
  const ops = payload.patch_op ?? payload.patchOp
  if (Array.isArray(ops) && ops.length > 0) {
    let text = ''
    let think = ''
    for (const op of ops) {
      const value = op?.patch_value ?? op?.patchValue ?? op
      const blocks = value?.content_block ?? value?.contentBlock ?? []
      for (const b of Array.isArray(blocks) ? blocks : [blocks]) {
        const type = b?.block_type ?? b?.blockType
        const t = b?.content?.text_block?.text ?? b?.content?.textBlock?.text
        if (typeof t !== 'string' || !t) continue
        // 10040 = 思考容器（其内容是思考摘要）；10000 = 正文
        if (type === 10040) think += t
        else text += t
      }
    }
    if (think) return { kind: 'think', text: think, raw: payload }
    if (text) return { kind: 'text', text, raw: payload }
    return { kind: 'unknown', raw: payload }
  }

  // ── 直接的 content_block 结构（实测形态：STREAM_MSG_NOTIFY）──
  //   {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"你"}}}]}}
  const directBlocks = payload.content?.content_block ?? payload.content_block
  if (Array.isArray(directBlocks) && directBlocks.length > 0) {
    let text = ''
    let think = ''
    for (const b of directBlocks) {
      const type = b?.block_type ?? b?.blockType
      const t = b?.content?.text_block?.text ?? b?.content?.textBlock?.text
      if (typeof t !== 'string' || !t) continue
      if (type === 10040) think += t
      else text += t
    }
    if (think) return { kind: 'think', text: think, raw: payload }
    if (text) return { kind: 'text', text, raw: payload }
    return { kind: 'unknown', raw: payload }
  }

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
