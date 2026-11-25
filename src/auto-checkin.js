/**
 * 每日自动签到调度。
 *
 * 形态对齐 dsh-our-free-model 的 `vendor/channel-pack/src/auto-checkin.ts`：
 * - DSH 启动后延迟一小段（默认 30 秒，别跟启动抢资源）；
 * - 若开关开着、且**今天（UTC+8）还没跑过**，就串行遍历各账号跑签到；
 * - 跑完把日期与逐账号结果写进独立文档 → 当天不再触发；
 * - 用户手动点签到不受此限（那是显式操作，永远放行）。
 *
 * ## 豆包的特殊之处：签到只能在客户端点
 *
 * 实测（2026-11-25）：
 * - 网页活动页写着「该活动仅支持在豆包电脑版参与」，网页没有签到按钮；
 * - `POST /alice/ug/campaign/landing/checkin` 用网页 cookie 调会回 710010702，
 *   **并且会消耗掉当天的签到机会**（不可回滚、不可补救）——
 *   所以这里**绝不**发那个请求；
 * - 安全的做法是 CDP 点客户端真实按钮（走客户端自己的签名与会话）。
 *
 * 因此这里的「自动签到」= 有豆包桌面客户端时，用 CDP 点它的真实签到按钮；
 * 没有客户端时如实告知「装客户端才能签到」，绝不盲试接口。
 *
 * @module src/auto-checkin.js
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 状态文档版本。 */
export const AUTO_CHECKIN_SCHEMA = 'doubao-signin/auto-checkin/v1'

/** 默认延迟：等宿主其它服务先就绪，也等凭据续期跑一轮。 */
export const DEFAULT_DELAY_MS = 30_000

/**
 * 状态文档路径（独立文件，不与其它文档混写）。
 * @returns {string} 路径。
 */
export function autoCheckinStatePath() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'doubao-signin', 'auto-checkin.json')
}

/**
 * 读状态文档。
 * @returns {{schema: string, enabled: boolean, lastDate: string|null, lastResults: Array<object>}} 状态。
 */
export function loadAutoCheckinState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(autoCheckinStatePath(), 'utf8'))
    return {
      schema: AUTO_CHECKIN_SCHEMA,
      enabled: parsed?.enabled !== false,
      lastDate: parsed?.lastDate ?? null,
      lastResults: Array.isArray(parsed?.lastResults) ? parsed.lastResults : [],
    }
  } catch {
    return { schema: AUTO_CHECKIN_SCHEMA, enabled: true, lastDate: null, lastResults: [] }
  }
}

/**
 * 写状态文档。
 * @param {object} state - 状态。
 * @returns {string} 落盘路径。
 */
export function saveAutoCheckinState(state) {
  const p = autoCheckinStatePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
  return p
}

/**
 * 北京时区的日期键（豆包的签到日界是 UTC+8）。
 * @param {Date} [now] - 当前时间。
 * @returns {string} `YYYY-MM-DD`。
 */
export function beijingDayKey(now = new Date()) {
  // UTC+8 偏移后取日期部分
  const shifted = new Date(now.getTime() + 8 * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * 今天是否已经跑过。
 * @param {object} [state] - 状态（缺省现读）。
 * @returns {boolean} 已跑过为 true。
 */
export function alreadyRanToday(state = loadAutoCheckinState()) {
  return state.lastDate === beijingDayKey()
}

/**
 * 调度器：启动后延迟一段时间，若今天没跑过就执行。
 *
 * @param {object} deps - 依赖。
 * @param {(account: object) => Promise<object>} deps.runOne - 对一个账号跑签到（返回 {ok, state, message}）。
 * @param {() => Array<object>} [deps.accounts] - 账号列表。
 * @param {number} [deps.delayMs] - 延迟毫秒。
 * @param {(msg: string) => void} [deps.log] - 日志。
 * @param {boolean} [deps.enabled] - 开关（缺省读文档）。
 * @returns {{ran: boolean, results?: Array<object>, message?: string}} 结果。
 */
export async function runAutoCheckin({ runOne, accounts, delayMs = DEFAULT_DELAY_MS, log = () => {}, enabled } = {}) {
  const state = loadAutoCheckinState()
  const on = enabled === undefined ? state.enabled : enabled !== false
  if (!on) return { ran: false, message: '自动签到开关已关闭' }
  if (alreadyRanToday(state)) return { ran: false, message: '今天已经签过了' }

  if (delayMs > 0) {
    log(`自动签到将在 ${Math.round(delayMs / 1000)}s 后开始`)
    await sleep(delayMs)
  }

  const list = accounts?.() ?? []
  if (!list.length) {
    saveAutoCheckinState({ ...state, lastDate: beijingDayKey(), lastResults: [] })
    return { ran: false, message: '账号池是空的，没有可签到的账号' }
  }

  const results = []
  for (const account of list) {
    try {
      const r = await runOne(account)
      results.push({ account: account.id, ...r })
      log(`自动签到 ${account.label ?? account.id}: ${r.message ?? (r.ok ? '成功' : '失败')}`)
    } catch (error) {
      results.push({ account: account.id, ok: false, state: 'error', message: error.message })
      log(`自动签到 ${account.label ?? account.id} 抛错: ${error.message}`)
    }
  }

  // 记今天已处理：只要跑完就记（即便全失败，也避免每次启动都刷一遍）
  saveAutoCheckinState({ ...state, lastDate: beijingDayKey(), lastResults: results })
  return { ran: true, results }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
