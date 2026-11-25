/**
 * 额度查询：豆包 `/alice/commerce/sale/subscription/quota/summary/` 的解析。
 *
 * 协议情报（2026-11 实测，本文件只做解析层，网络走 Host 侧）：
 *
 * **当前结构（豆包 2026-11 改版后）**：
 * - `data.quota_remaining_amount` —— 剩余总额，字符串带千分位（"3,921"），**权威字段**；
 * - `data.quota_blance_usage[]` —— 余额分类（category/title/total_amount/used_amount/used_percent）；
 * - `data.window_limit_section.window_limit_groups[].window_limits[]` —— 消耗窗口，
 *   `window_type 4`=月度套餐（带 start_time/end_time）、`3`=活动赠送额度；
 *
 * **旧结构（2026-10 及以前，保留兼容）**：
 * - 顶层 `window_limit_groups[].window_limits[]`；
 * - `window_type 1`（5 小时）/ `2`（周额度）已下线，留映射兜底；
 *
 * - 金额字段可能是 "9,000" 这种带千分位的字符串，必须先去逗号再转数字；
 * - 读取失败返回 undefined（「读不出」≠「没有」），调用方据此区分。
 *
 * @module src/quota.js
 */

/** 额度汇总端点路径。 */
export const QUOTA_PATH = '/alice/commerce/sale/subscription/quota/summary/'

/** window_type → 人类可读名称。 */
export const WINDOW_NAMES = {
  1: '5小时窗口',
  2: '周额度',
  3: '活动赠送额度',
  4: '套餐积分',
}

/**
 * 从 summary 响应里抽取额度窗口。
 * @param {unknown} payload - 上游 JSON（已解析）。
 * @returns {{windows: Array<object>, total: number}|undefined} 解析失败返回 undefined。
 */
export function parseQuotaSummary(payload) {
  if (!payload || typeof payload !== 'object') return undefined

  // 结构可能有 data 包裹层
  let root = payload
  for (const key of ['data', 'result']) {
    if (root && typeof root === 'object' && root[key] && typeof root[key] === 'object') root = root[key]
  }

  // 窗口可能在旧位置 root.window_limit_groups，也可能在新位置
  // root.window_limit_section.window_limit_groups（2026-11 改版后）。
  const groups =
    (Array.isArray(root?.window_limit_groups) && root.window_limit_groups) ||
    (Array.isArray(root?.window_limit_section?.window_limit_groups) && root.window_limit_section.window_limit_groups) ||
    []

  const windows = []
  for (const g of groups) {
    const limits = g?.window_limits
    if (!Array.isArray(limits)) continue
    for (const w of limits) {
      const parsed = parseWindow(w, g)
      if (parsed) windows.push(parsed)
    }
  }

  // 新结构还有 quota_blance_usage（分类余额，无时间戳）——只在窗口数据为空时用它兜底，
  // 避免和 window_limits 重复计数。
  if (windows.length === 0 && Array.isArray(root?.quota_blance_usage)) {
    for (const u of root.quota_blance_usage) {
      const total = num(u?.total_amount) ?? num(u?.total)
      const used = num(u?.used_amount) ?? num(u?.used)
      if (total === undefined || used === undefined) continue
      windows.push({
        type: -1,
        name: String(u?.title ?? '额度'),
        total,
        used,
        remaining: Math.max(0, total - used),
        usedPercent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      })
    }
  }

  if (!windows.length && !groups.length && root?.quota_blance_usage === undefined) return undefined

  // 优先用上游给的剩余总额（权威）；它带千分位，num() 已处理。
  const declared = num(root?.quota_remaining_amount)
  const total = declared !== undefined
    ? declared
    : windows.reduce((sum, w) => sum + w.remaining, 0)
  return { windows, total }
}

/**
 * 解析单个窗口。
 * @param {object} w - window_limits 成员。
 * @param {object} [group] - 所属 group（可有 section 描述）。
 * @returns {object|null} 归一化窗口；不可解析返回 null。
 */
function parseWindow(w, group) {
  if (!w || typeof w !== 'object') return null
  const wt = Number(w.window_type)
  if (!Number.isFinite(wt)) return null

  const total = num(w.total_amount) ?? num(w.total)
  const used = num(w.used_amount) ?? num(w.used)
  if (total === undefined || used === undefined) return null

  const remaining = Math.max(0, total - used)
  const start = num(w.start_time) ?? num(w.started_at)
  const end = num(w.end_time) ?? num(w.resets_at)

  return {
    type: wt,
    name: WINDOW_NAMES[wt] ?? `窗口${wt}`,
    total,
    used,
    remaining,
    usedPercent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
    ...(start !== undefined ? { startedAt: normTime(start) } : {}),
    ...(end !== undefined ? { resetsAt: normTime(end) } : {}),
    ...(typeof group?.section === 'string' && group.section ? { section: group.section } : {}),
  }
}

/**
 * 把上游秒/毫秒时间戳归一成毫秒。
 * @param {number} v - 原始时间戳。
 * @returns {number} 毫秒 epoch。
 */
function normTime(v) {
  return v < 10_000_000_000 ? v * 1000 : v
}

/**
 * 安全取数。
 * @param {unknown} v - 值。
 * @returns {number|undefined} 数字或 undefined。
 */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    // 豆包金额是 "9,000" / "3,921" 这种带千分位的字符串——不去逗号会 NaN
    const cleaned = v.replace(/,/g, '').trim()
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned)
  }
  return undefined
}

/**
 * 渲染额度摘要文本。
 * @param {Array<object>} windows - parseQuotaSummary 的 windows。
 * @param {number} total - 剩余合计。
 * @returns {string} 多行摘要。
 */
export function renderQuota(windows, total) {
  const lines = [`剩余额度合计: ${total.toLocaleString('zh-CN')}`]
  for (const w of windows) {
    const parts = [`${w.name}: 剩 ${w.remaining.toLocaleString('zh-CN')} / ${w.total.toLocaleString('zh-CN')}（已用 ${w.usedPercent}%）`]
    if (w.resetsAt && w.resetsAt > Date.now()) {
      const mins = Math.round((w.resetsAt - Date.now()) / 60000)
      parts.push(mins >= 1440 ? `重置: ${Math.round(mins / 1440)} 天后` : mins >= 60 ? `重置: ${Math.round(mins / 60)} 小时后` : `重置: ${mins} 分钟后`)
    }
    lines.push('  ' + parts.join(' · '))
  }
  return lines.join('\n')
}
