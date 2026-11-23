/**
 * 健壮性层：豆包内容审核识别、prompt 清洗与预算、速率锁。
 *
 * 情报来源（2026-11 对两款同类插件的逆向结论）：
 *
 * 1. 豆包内容审核不返回错误码——它回一段以「该内容涉嫌违反」开头的普通文本流 + stop。
 *    不识别它的话，用户会看到一个"突然不会说话"的模型。
 * 2. DSH 宿主会在 messages 里塞 <system-reminder>（AGENTS.md、运行模式前言等，
 *    数万字符）。这些词正是触发消费者端点审核的主因，必须在出网前剥掉。
 * 3. 压平后的长会话（百万字符级）会被网关以 `common invalid param` 静默拒绝
 *    （HTTP 仍 200）。32K 字符预算 + 保尾截断是同一类故障的标准解法。
 * 4. 豆包风控对"连发"敏感：整轮持锁 + 最小间隔，被拒后熔断冷却且绝不自动重试
 *    ——重试只会加深风控。
 *
 * @module src/hardening.js
 */

/** 压平后 prompt 的硬上限（字符）。与同类插件的实测值对齐。 */
export const MAX_PROMPT_CHARS = 32_000

/** 审核通知的开头。任何以它起头的回答都在第一个 delta 就被拦下。 */
export const REFUSAL_LEAD = '该内容涉嫌违反'

/** 审核通知里嵌入的社区规范链接（兜底锚点）。 */
export const REFUSAL_ANCHOR = 'doubao.com/legal/community_guidelines'

/**
 * 判断一段（可能流式累积的）文本是不是豆包的审核通知。
 * 用前缀匹配，所以流式场景里第一个 delta 就能判出来。
 * @param {string} text - 待判文本。
 * @returns {boolean} 是审核通知时为 true。
 */
export function isRefusal(text) {
  const s = String(text ?? '').replace(/^\s+/, '')
  return s.startsWith(REFUSAL_LEAD) || s.includes(REFUSAL_ANCHOR)
}

/**
 * 给流式消费用的前缀拦截器。
 * 只有当累积文本仍是审核通知开头的前缀时才继续缓冲；一旦确定不是审核
 * （比如正常回答的第一个字），立即放行——正常回答不会有任何可感知延迟。
 * @returns {{push(delta: string): {refusal: boolean, text: string}, done(): {refusal: boolean, text: string}}} 状态机。
 */
export function createRefusalTracker() {
  let acc = ''
  let verdict = null // true=审核, false=正常回答
  const lead = REFUSAL_LEAD
  const step = () => {
    if (verdict !== null) return verdict
    if (acc.replace(/^\s+/, '').startsWith(lead) || acc.includes(REFUSAL_ANCHOR)) { verdict = true; return true }
    if (lead.startsWith(acc.replace(/^\s+/, '').slice(0, lead.length))) return null // 还没定
    verdict = false
    return false
  }
  return {
    /**
     * 喂入一个 delta。
     * @param {string} delta - 增量文本。
     * @returns {{refusal: boolean|null, text: string}} refusal 为 true/false/未定。
     */
    push(delta) {
      if (verdict === false) return { refusal: false, text: delta } // 已放行，直通
      acc += delta
      const v = step()
      return { refusal: v, text: verdict === false ? acc : '' }
    },
    /**
     * 流结束时的最终判定。
     * @returns {{refusal: boolean, text: string}} 结果。
     */
    done() {
      if (verdict === null) {
        verdict = acc.replace(/^\s+/, '').startsWith(lead) || acc.includes(REFUSAL_ANCHOR)
      }
      return { refusal: verdict === true, text: verdict === false ? acc : '' }
    },
  }
}

/** 系统提醒标签的正则（含未闭合的裸标签兜底）。 */
const REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi

/** 宿主前言的特征标记。 */
const HOST_MARKERS = /Instructions from:|AGENTS\.md|<compacted-summary>|operating mode|无限制模式|PRIME DIRECTIVE/i

/**
 * 出网前的文本清洗。
 *
 * 规则（对齐同类插件实测结论）：
 * - 剥 <system-reminder> 块（含内容）；
 * - 纯宿主前言（system/developer 角色的长块或带宿主标记的块）整个丢弃；
 * - 用户/工具内容只剥标签，不丢弃——用户粘贴的长文档必须活着到达上游。
 * @param {string} text - 原文。
 * @param {string} [role] - 消息角色。
 * @returns {string} 清洗后的文本。
 */
export function cleanForWire(text, role = 'user') {
  let s = String(text ?? '').replace(REMINDER_RE, '').trim()
  if (!s) return ''
  const isHostPreamble =
    (role === 'system' || role === 'developer')
      ? s.length > 2000 || HOST_MARKERS.test(s)
      : HOST_MARKERS.test(s) && s.length > 2000 && role !== 'user'
  if (isHostPreamble) return ''
  return s
}

/**
 * 带预算的保尾截断。
 *
 * 超预算时：保留开头一条系统提示的占位 + 「… earlier turns omitted …」标记，
 * 尽可能多保留尾部（指令通常在最后一条）。最后一条本身超预算时保留它的尾段
 * ——那里是真正的指令。
 * @param {string} prompt - 压平后的 prompt。
 * @param {number} [max] - 上限，默认 MAX_PROMPT_CHARS。
 * @returns {{text: string, truncated: boolean, original: number}} 结果与元信息。
 */
export function applyPromptBudget(prompt, max = MAX_PROMPT_CHARS) {
  const s = String(prompt ?? '')
  if (s.length <= max) return { text: s, truncated: false, original: s.length }
  const marker = '\n\n[… 较早的轮次已省略 …]\n\n'
  const tailBudget = max - marker.length - 200 /* 头部提示空间 */
  const tail = s.slice(-tailBudget)
  // 别从词中间切开：往后找第一个换行
  const nl = tail.indexOf('\n')
  const cleanTail = nl > 0 && nl < 200 ? tail.slice(nl + 1) : tail
  const head = s.length > 400 ? `[会话共 ${s.length} 字符，已截断]` : ''
  return {
    text: `${head}${marker}${cleanTail}`.slice(0, max),
    truncated: true,
    original: s.length,
  }
}

/**
 * 轮次速率锁：整轮（请求 + 流）持锁，轮与轮之间保持最小间隔。
 *
 * 用法：`const release = await pacer.begin()` → 干活 → `release()`。
 * `begin()` 排队等前一轮结束 + 间隔到期。
 * @param {object} [opts] - 配置。
 * @param {number} [opts.minIntervalMs] - 轮间最小间隔，默认 1500。
 */
export class Pacer {
  constructor(opts = {}) {
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 1500)
    this.tail = Promise.resolve()
    this.lastEnd = 0
  }

  /**
   * 排队取锁。
   * @returns {Promise<() => void>} 释放函数。
   */
  begin() {
    const wait = this.tail.then(async () => {
      const gap = this.minIntervalMs - (Date.now() - this.lastEnd)
      if (this.lastEnd && gap > 0) await sleep(gap)
    })
    // 防御：前一轮如果抛了错，这里也必须继续走
    this.tail = wait.then(() => {}, () => {})
    let release
    const gate = new Promise(resolve => { release = resolve })
    this.tail = Promise.all([wait, gate]).then(([ok]) => {
      this.lastEnd = Date.now()
      return ok
    })
    return wait.then(() => {
      let done = false
      return () => {
        if (done) return
        done = true
        release()
      }
    })
  }
}

/**
 * 风控熔断器：上游风控拒绝后进入冷却，冷却期内直接给结构化错误、不发请求。
 * 绝不自动重试——重试只会加深风控。
 * @param {object} [opts] - 配置。
 * @param {number} [opts.cooldownMs] - 冷却时长，默认 10 分钟。
 */
export class Circuit {
  constructor(opts = {}) {
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 10 * 60_000)
    this.openUntil = 0
  }

  /** @returns {boolean} 熔断中。 */
  get open() {
    return Date.now() < this.openUntil
  }

  /** @returns {number} 剩余冷却毫秒。 */
  get remainingMs() {
    return Math.max(0, this.openUntil - Date.now())
  }

  /** 打开熔断。 @returns {void} */
  trip() {
    this.openUntil = Date.now() + this.cooldownMs
  }

  /** 手动解除（比如用户在客户端过了滑块）。 @returns {void} */
  reset() {
    this.openUntil = 0
  }
}

/** 上游风控拒绝的 SSE 错误码（"rate limit" 文案下的滑块验证）。 */
export const RISK_CODE = 710022004

/** 上游审核/风控错误的分类结果。 */
export const FailureKind = {
  /** 鲨鱼风控滑块：需要人工在客户端过验证。 */
  RISK: 'risk',
  /** 内容审核：换措辞可解。 */
  MODERATED: 'moderated',
  /** 其它上游错误。 */
  UPSTREAM: 'upstream',
}

/**
 * 从上游响应文本里分类错误。
 * @param {string} body - SSE 原文或错误文本。
 * @returns {{kind: string, code?: number, message: string}} 分类。
 */
export function classifyFailure(body) {
  const s = String(body ?? '')
  const codeHit = /710022004/.exec(s)
  if (codeHit) return { kind: FailureKind.RISK, code: RISK_CODE, message: '上游风控要求人机验证（710022004）。在豆包客户端里完成一次滑块/验证后即可恢复；插件在冷却期内不再自动发请求。' }
  if (isRefusal(s)) return { kind: FailureKind.MODERATED, message: '豆包内容审核拦截了本次请求（不是模型故障）。换一种措辞或减少注入内容后重试。' }
  const invalid = /invalid param|common_error/i.exec(s)
  if (invalid) return { kind: FailureKind.UPSTREAM, message: `上游拒绝请求体（${invalid[0]}）。通常是 prompt 超预算或字段形态变了。` }
  return { kind: FailureKind.UPSTREAM, message: s.slice(0, 300) || '上游返回空错误' }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
