/**
 * 豆包每日签到的**只读**状态查询（借网页 Cookie，不需要客户端）。
 *
 * 协议来自 dsh-checkin-all（MIT，原链 techysy/CreditDaddy）与
 * magpie-doubao-work-auth（MIT）的实测。要点：
 *
 * - 状态查询 `POST /alice/ug/campaign/v3/detail/` body `{campaign_group_code}` 是**只读安全**的；
 * - **领取** `POST /alice/ug/campaign/landing/checkin` 会**吃掉当天额度**：
 *   网页会话直接调一律回 710010702，之后客户端也签不了（服务端已消耗当日机会）。
 *   所以本模块**绝不发领取请求**——要签到必须去豆包电脑版客户端点真实按钮。
 * - `task_status === 2` 才算"可领取"，`1` 是未满足条件（账号没被投放活动）。
 *
 * @module src/signin-status.js
 */

/** 任务面板端点（只读）。 */
export const DETAIL_PATH = '/alice/ug/campaign/v3/detail/'

/** 签到任务的活动组。 */
export const CAMPAIGN_SCENE = 'pc_incentive_task_mvp_v3'

/** 签到任务 kind。 */
export const SIGNIN_TASK = 'daily_signin'

/** 错误码：登录失效。 */
export const LOGIN_INVALID = 710012001

/** 豆包桌面端 UA（平台参数要自称桌面版，和客户端点 UI 时的请求形态一致）。 */
export const CLIENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36'

/** 公共平台 query 参数（照抄开源实现里实测能用的那组）。 */
export const COMMON_PARAMS = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
  device_id: '',
  region: '',
  sys_region: '',
}

/**
 * 拼任务面板 URL。
 * @param {object} [ids] - {webId, teaUuid} 稳定网页身份；缺省用空串。
 * @returns {string} 完整 URL。
 */
export function detailUrl(ids = {}) {
  const q = new URLSearchParams({
    ...COMMON_PARAMS,
    web_id: ids.webId ?? '',
    tea_uuid: ids.teaUuid ?? '',
  })
  return `https://www.doubao.com${DETAIL_PATH}?${q}`
}

/**
 * 从详情响应里读签到状态（纯函数）。
 * @param {object} detail - detail 接口的 JSON。
 * @returns {{state: string, found: boolean, claimed?: boolean, claimable?: boolean, status?: number, points?: number, streak?: number, kinds: string[], message: string}} 状态。
 */
export function readCheckin(detail) {
  const data = detail?.data ?? detail
  const tasks = Array.isArray(data?.tasks)
    ? data.tasks
    : data?.campaign_group?.tasks
  if (!Array.isArray(tasks)) {
    return { state: 'error', found: false, kinds: [], message: '签到接口没有返回任务列表，暂时无法判断资格' }
  }
  const withDaily = tasks.filter(t => t?.daily_checkin && typeof t.daily_checkin === 'object' && !Array.isArray(t.daily_checkin))
  const task = tasks.find(t => t?.campaign_code === SIGNIN_TASK || t?.task_kind === SIGNIN_TASK)
    ?? (withDaily.length === 1 ? withDaily[0] : undefined)
  const kinds = [...new Set(tasks.map(t => t?.task_kind).filter(Boolean))]

  if (!task) {
    if (withDaily.length > 1 || tasks.some(t => !t || typeof t !== 'object' || !(t.campaign_code || t.task_kind))) {
      return { state: 'error', found: false, kinds, message: '无法识别签到任务，暂时无法判断资格' }
    }
    return {
      state: 'no_task',
      found: false,
      kinds,
      message: kinds.length
        ? `这个账号没有每日签到任务（现有任务：${kinds.join('/')}）——通常是工作版/飞书企业账号`
        : '账号当前没有投放签到活动',
    }
  }

  const daily = task.daily_checkin
  if (!daily || typeof daily.checked_in_today !== 'boolean') {
    return { state: 'error', found: true, kinds, message: '签到任务缺少今日签到状态，暂时无法判断资格' }
  }
  const status = readNumber(task.task_status)
  const claimed = daily.checked_in_today
  const claimable = !claimed && status === 2
  const points = readNumber(daily.reward?.reward_amount) ?? 0
  const streak = readNumber(daily.continuous_days) ?? 0

  let state = 'error'
  let message = '签到任务返回了未知状态，暂时无法判断资格'
  if (claimed) {
    state = 'already'
    message = `今天已签到${streak ? `，连续 ${streak} 天` : ''}`
  } else if (claimable) {
    state = 'can_sign'
    message = `今日可签${points > 0 ? `（+${points} 额度）` : ''}，请到豆包电脑版客户端点签到`
  } else if (status === 1) {
    state = 'ineligible'
    message = '今日未签，当前账号暂不可领'
  }

  return {
    state,
    found: true,
    claimed,
    claimable,
    status,
    points,
    streak,
    lastDate: daily.last_checkin_date ? String(daily.last_checkin_date) : undefined,
    kinds,
    message,
  }
}

function readNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 用 Cookie 只读查询签到状态（不发任何领取请求）。
 * @param {string} cookieHeader - 豆包 Cookie 头。
 * @param {object} [opts] - 配置。
 * @param {object} [opts.ids] - 稳定网页身份。
 * @param {string} [opts.group] - 活动组（缺省用常量）。
 * @param {number} [opts.timeoutMs] - 超时。
 * @param {typeof fetch} [opts.fetchImpl] - fetch 注入（测试用）。
 * @returns {Promise<{ok: boolean, state: string, message: string, details?: object}>} 结果。
 */
export async function querySigninStatus(cookieHeader, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const fetchImpl = opts.fetchImpl ?? fetch
  const group = opts.group ?? CAMPAIGN_SCENE

  let res
  try {
    res = await fetchImpl(detailUrl(opts.ids), {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.doubao.com/pc/agent-explore',
        Origin: 'https://www.doubao.com',
        'User-Agent': CLIENT_UA,
      },
      body: JSON.stringify({ campaign_group_code: group }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, state: 'error', message: `查询签到状态失败: ${error.message}` }
  }

  let body
  try { body = await res.json() } catch {
    return { ok: false, state: 'error', message: `签到状态接口返回非 JSON（HTTP ${res.status}）` }
  }

  const code = body?.code
  if (readNumber(code) === LOGIN_INVALID || res.status === 401) {
    return { ok: false, state: 'unlogged', message: '豆包登录已过期（Cookie 失效），重新扫码登录' }
  }
  if (res.ok === false || res.status >= 400) {
    return { ok: false, state: 'error', message: `签到状态接口异常（HTTP ${res.status}）` }
  }
  if (code !== 0 && code !== '0') {
    const reason = typeof code === 'number' || typeof code === 'string' ? `（code ${code}）` : ''
    return { ok: false, state: 'error', message: `签到状态接口未返回有效结果${reason}` }
  }

  const info = readCheckin(body)
  return {
    ok: info.found && info.state !== 'error',
    state: info.state,
    message: info.message,
    details: info,
  }
}
