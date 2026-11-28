/**
 * 标题请求本地化 —— 消除 DSH 自动标题生成在豆包里留下的对话记录。
 *
 * ## 背景
 *
 * DSH 每开一个新会话都会发一次"标题生成"请求，走当前选中的 provider。
 * 它走豆包时会产生两条副作用（截图实证）：
 * 1. 在豆包客户端/手机同步里冒出一条「简短会话交互」记录；
 * 2. 消耗额度（哪怕很少）。
 *
 * 这类请求不是用户真正想发给模型的内容——它只是宿主想给会话起个名字。
 * 而且它的 prompt 是固定模板（`Generate the session title from this JSON array…`），
 * 完全可以在本地产出标题，不需要发给豆包。
 *
 * ## 做法
 *
 * 识别固定的标题 prompt 模板 → 从 JSON 数组里取第一条人类消息 → 截取成一行短标题。
 * 这与 WorkBuddy 项目 issue #133 的处理思路一致（把标题请求改写到轻量模型），
 * 但我们更彻底：直接本地生成，零请求、零记录。
 *
 * ## 安全性
 *
 * 只匹配**精确的模板前缀**，且 payload 必须是合法 JSON。任何不完全匹配的请求
 * 都返回 undefined，走正常网络链路——不会误伤普通对话。
 *
 * @module src/session-title.js
 */

/** 标题模板前缀（两种形态：首轮生成 / 更新标题）。 */
const TITLE_PREFIXES = [
  'Generate the session title from this JSON array of human messages:\n',
  'Update the session title from this JSON object:\n',
]

/**
 * 判断是不是 DSH 的标题生成请求，并本地产出标题。
 *
 * @param {object} options - GenerateOptions（dsh-llm 传入）。
 * @returns {string|undefined} 本地生成的标题；不是标题请求则返回 undefined。
 */
export function localSessionTitle(options) {
  // 标题请求特征：只有一条 user 消息、无 tools、无 system
  const msgs = options?.messages
  if (!Array.isArray(msgs) || msgs.length !== 1) return undefined
  if (options?.tools?.length) return undefined
  const content = msgs[0]?.content
  if (typeof content !== 'string') return undefined

  for (const prefix of TITLE_PREFIXES) {
    if (!content.startsWith(prefix)) continue
    const payload = content.slice(prefix.length)
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      return undefined // 不完全匹配 → 不接管，走正常链路
    }
    return titleFromPayload(parsed)
  }
  return undefined
}

/**
 * 从标题请求 payload 里产出一行短标题。
 * @param {unknown} payload - JSON 解析结果（数组或 {currentTitle, messages}）。
 * @returns {string|undefined} 标题。
 */
function titleFromPayload(payload) {
  // 首轮形态：JSON array of human messages
  let messages = payload
  // 更新形态：{ currentTitle, messages }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.messages)) {
    messages = payload.messages
  }
  if (!Array.isArray(messages)) return undefined

  // 取第一条有文本的人类消息
  let first = ''
  for (const m of messages) {
    if (typeof m === 'string') { first = m; break }
    if (m && typeof m === 'object') {
      const c = m.content ?? m.text ?? m.message
      if (typeof c === 'string' && c.trim()) { first = c; break }
      if (Array.isArray(c)) {
        const t = c.find(p => typeof p === 'string' || (p && typeof p.text === 'string'))
        if (t) { first = typeof t === 'string' ? t : t.text; break }
      }
    }
  }
  const clean = String(first).replace(/\s+/g, ' ').trim()
  if (!clean) return '新对话'
  // 一行、最多 24 字（与 DSH 标题长度习惯一致）
  return clean.length > 24 ? clean.slice(0, 24) + '…' : clean
}
