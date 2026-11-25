/**
 * 豆包账号池 —— 多账号、失效自动换号、按额度择号。
 *
 * 形态对齐 dsh-connect-workbuddy / dsh-our-free-model 的成熟做法：
 * - 账号存一份本机文档（每个账号一份 cookie + 元信息）；
 * - 请求失败且判定为「凭据失效」时，换下一个账号重试；
 * - 「额度择号」：选剩余额度最多的账号（额度端点能读到窗口剩余量）；
 * - 单账号时行为不变（不引入额外复杂度）。
 *
 * 凭据怎么来：每个账号 = 一次浏览器扫码（doubao_login），存各自的 profile。
 * 这样多账号互不影响（各自独立登录态）。
 *
 * @module src/account-pool.js
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cookieHeaderOf, sessionReadiness } from './login.js'

/** 账号池文档版本。 */
export const POOL_SCHEMA = 'doubao-signin/accounts/v1'

/**
 * 账号池目录（每个账号一个子目录：credentials.json + browser-profile/）。
 * @returns {string} 目录路径。
 */
export function poolDir() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'doubao-signin', 'accounts')
}

/**
 * 读账号池。
 * @returns {{schema: string, accounts: Array<object>}} 账号池文档（没有时返回空池）。
 */
export function loadPool() {
  try {
    const p = path.join(poolDir(), 'pool.json')
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!Array.isArray(parsed?.accounts)) return { schema: POOL_SCHEMA, accounts: [] }
    return parsed
  } catch {
    return { schema: POOL_SCHEMA, accounts: [] }
  }
}

/**
 * 写账号池。
 * @param {{schema: string, accounts: Array<object>}} pool - 账号池文档。
 * @returns {string} 落盘路径。
 */
export function savePool(pool) {
  const dir = poolDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'pool.json')
  fs.writeFileSync(p, JSON.stringify(pool, null, 2), 'utf8')
  return p
}

/**
 * 往池里加一个账号（用它自己的 cookie 目录）。
 * @param {object} opts - 参数。
 * @param {string} opts.label - 账号标签（显示用）。
 * @param {Array<{name: string, value: string}>} opts.cookies - cookie 列表。
 * @param {string} [opts.dirName] - 该账号的独立目录名（缺省按标签生成）。
 * @returns {object} 写入的账号条目。
 */
export function addAccount({ label, cookies, dirName }) {
  const pool = loadPool()
  const dir = dirName || (label.replace(/[^\w.-]+/g, '_') || ('acct-' + Date.now()))
  const accountDir = path.join(poolDir(), dir)
  fs.mkdirSync(accountDir, { recursive: true })
  fs.writeFileSync(
    path.join(accountDir, 'credentials.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2),
    'utf8',
  )
  const entry = {
    id: dir,
    label,
    dir,
    enabled: true,
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
    lastError: null,
    disabledReason: null,
    quota: null,
  }
  pool.accounts = pool.accounts.filter(a => a.id !== dir)
  pool.accounts.push(entry)
  savePool(pool)
  return entry
}

/**
 * 列出可用账号（enabled 且没被标记失效）。
 * @returns {Array<object>} 账号条目。
 */
export function listEnabledAccounts() {
  return loadPool().accounts.filter(a => a.enabled !== false && !a.disabledReason)
}

/**
 * 读某账号的 cookie 头。
 * @param {object} account - 账号条目。
 * @returns {string} cookie 头；没有则空串。
 */
export function accountCookieHeader(account) {
  try {
    const p = path.join(poolDir(), account.dir, 'credentials.json')
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    const ready = sessionReadiness(parsed.cookies ?? [])
    return ready.ok ? cookieHeaderOf(parsed.cookies) : ''
  } catch {
    return ''
  }
}

/**
 * 标记账号失效（凭据过期 / 被风控）。
 * @param {string} id - 账号 id。
 * @param {string} reason - 原因（会显示给用户）。
 * @param {boolean} [permanent] - 是否永久停用（false = 临时跳过本轮）。
 * @returns {object|null} 更新后的账号条目。
 */
export function markAccountFailed(id, reason, permanent = false) {
  const pool = loadPool()
  const a = pool.accounts.find(x => x.id === id)
  if (!a) return null
  a.lastError = reason
  a.lastUsedAt = new Date().toISOString()
  if (permanent) {
    a.disabledReason = reason
    a.enabled = false
  }
  savePool(pool)
  return a
}

/**
 * 记录账号本轮成功，并记下它的额度。
 * @param {string} id - 账号 id。
 * @param {object} [quota] - 额度信息。
 * @returns {object|null} 更新后的账号条目。
 */
export function markAccountOk(id, quota) {
  const pool = loadPool()
  const a = pool.accounts.find(x => x.id === id)
  if (!a) return null
  a.lastError = null
  a.disabledReason = null
  a.enabled = true
  a.lastUsedAt = new Date().toISOString()
  if (quota) a.quota = quota
  savePool(pool)
  return a
}

/**
 * 选一个账号来用：优先剩余额度多的、其次最近没用过的。
 * @param {Array<object>} accounts - 候选账号。
 * @returns {object|undefined} 选中的账号。
 */
export function pickAccount(accounts) {
  const usable = accounts.filter(a => a.enabled !== false && !a.disabledReason)
  if (!usable.length) return undefined
  const withQuota = usable.filter(a => typeof a.quota?.total === 'number')
  if (withQuota.length) {
    return withQuota.sort((x, y) => (y.quota.total - x.quota.total) || 0)[0]
  }
  const never = usable.filter(a => !a.lastUsedAt)
  if (never.length) return never[0]
  return usable.sort((x, y) => String(x.lastUsedAt).localeCompare(String(y.lastUsedAt)))[0]
}

/**
 * 一次请求的账号选择器：按池顺序试，每个账号最多试一次。
 *
 * 成熟插件（workbuddy/our-free-model）的做法是「失败即换号」，
 * 判定为凭据失效的错误（登录无效 / 额度耗尽）才换号；
 * 其它错误（网络、参数）不该换号——换了也一样错。
 *
 * @param {object} deps - 依赖。
 * @param {(cookie: string, account: object) => Promise<{ok: boolean, kind?: string, message?: string}>} deps.call - 用某账号发一次请求。
 * @param {Array<object>} [deps.accounts] - 候选账号（缺省用池里可用账号）。
 * @returns {Promise<{ok: boolean, account?: object, result?: object, tried: string[], message?: string}>} 结果。
 */
export async function withAccountFailover({ call, accounts } = {}) {
  const list = accounts ?? listEnabledAccounts()
  const picked = pickAccount(list)
  if (!picked) {
    return { ok: false, tried: [], message: '账号池是空的。先跑 doubao_login 扫码登录一个账号。' }
  }

  const tried = []
  const ordered = [picked, ...list.filter(a => a.id !== picked.id)]
  let lastMessage = ''
  for (const account of ordered) {
    const cookie = accountCookieHeader(account)
    if (!cookie) {
      tried.push(account.id + '(无凭据)')
      continue
    }
    tried.push(account.id)
    const r = await call(cookie, account)
    if (r.ok) {
      markAccountOk(account.id, r.quota)
      return { ok: true, account, result: r, tried }
    }
    lastMessage = r.message ?? '未知错误'
    // 只有凭据类错误才换号
    if (r.kind === 'auth') {
      markAccountFailed(account.id, lastMessage, false)
      continue
    }
    return { ok: false, account, result: r, tried, message: lastMessage }
  }
  return { ok: false, tried, message: lastMessage || '所有账号都失败了' }
}
