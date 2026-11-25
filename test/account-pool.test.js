/**
 * 账号池与自动签到的离线测试。
 *
 * 形态对齐 dsh-connect-workbuddy / dsh-our-free-model：
 * - 凭据失效才换号（网络错、参数错不该换）；
 * - 今天跑过就不重复跑；
 * - 「已处理」按 UTC+8 日历日算（豆包的签到日界）。
 *
 * @module test/account-pool.test.js
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// 用临时 HOME 隔离文档
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-pool-'))
process.env.DSH_HOME = TMP

const {
  addAccount, loadPool, savePool, listEnabledAccounts, markAccountFailed,
  markAccountOk, pickAccount, withAccountFailover, poolDir,
} = await import('../src/account-pool.js')
const {
  beijingDayKey, alreadyRanToday, loadAutoCheckinState, runAutoCheckin,
  saveAutoCheckinState, autoCheckinStatePath,
} = await import('../src/auto-checkin.js')

/**
 * 造一个带凭据的账号。
 * @param {string} label - 标签。
 * @param {string} id - 目录名。
 * @returns {object} 账号条目。
 */
function seed(label, id) {
  return addAccount({
    label,
    dirName: id,
    cookies: [
      { name: 'sessionid', value: 'v-' + id },
      { name: 'sessionid_ss', value: 'v-' + id },
      { name: 'sid_tt', value: 'v-' + id },
      { name: 'uid_tt', value: 'v-' + id },
    ],
  })
}

test('addAccount 把凭据写进账号自己的目录', () => {
  seed('账号A', 'a')
  const p = path.join(poolDir(), 'a', 'credentials.json')
  assert.ok(fs.existsSync(p), '凭据应落在该账号目录')
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(parsed.cookies.length, 4)
  assert.equal(parsed.cookies[0].value, 'v-a')
})

test('loadPool / savePool 往返', () => {
  const pool = loadPool()
  assert.ok(pool.accounts.length >= 1)
  pool.accounts[0].label = '改过的名字'
  savePool(pool)
  assert.equal(loadPool().accounts[0].label, '改过的名字')
})

test('listEnabledAccounts 排除停用的', () => {
  seed('账号B', 'b')
  const before = listEnabledAccounts().length
  const pool = loadPool()
  const b = pool.accounts.find(x => x.id === 'b')
  b.enabled = false
  savePool(pool)
  assert.equal(listEnabledAccounts().length, before - 1)
})

test('markAccountFailed 记原因但默认不永久停用', () => {
  seed('账号C', 'c')
  const a = markAccountFailed('c', '登录过期')
  assert.equal(a.lastError, '登录过期')
  assert.equal(a.enabled, true, '默认只是临时跳过')
  const b = markAccountFailed('c', '封禁', true)
  assert.equal(b.enabled, false)
  assert.equal(b.disabledReason, '封禁')
})

test('markAccountOk 清错并恢复启用', () => {
  const a = markAccountOk('c', { total: 100, windows: 1 })
  assert.equal(a.lastError, null)
  assert.equal(a.enabled, true)
  assert.equal(a.quota.total, 100)
})

test('pickAccount 优先选剩余额度多的', () => {
  markAccountOk('a', { total: 100 })
  markAccountOk('b', { total: 900 })
  const picked = pickAccount(listEnabledAccounts())
  assert.equal(picked.id, 'b')
})

test('pickAccount 没有额度信息时选没用过的', () => {
  seed('账号D', 'd')
  const pool = loadPool()
  pool.accounts.forEach(a => { a.quota = null })
  savePool(pool)
  const picked = pickAccount(listEnabledAccounts())
  assert.ok(picked, '应能选出一个')
  assert.equal(picked.lastUsedAt, null, '没用过的优先')
})

test('withAccountFailover：凭据失效才换号', async () => {
  seed('账号E', 'e')
  seed('账号F', 'f')
  const tried = []
  const r = await withAccountFailover({
    accounts: listEnabledAccounts(),
    call: async (cookie, account) => {
      tried.push(account.id)
      // 任意账号第一次都失败（模拟凭据失效），后面的成功
      if (tried.length === 1) return { ok: false, kind: 'auth', message: '登录过期' }
      return { ok: true, sse: 'ok' }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(tried.length, 2, '失效后应换下一个账号')
  assert.ok(tried[0] !== tried[1], '应是不同的两个账号')
})

test('withAccountFailover：非凭据错误不换号', async () => {
  seed('账号G', 'g')
  seed('账号H', 'h')
  const tried = []
  const r = await withAccountFailover({
    accounts: listEnabledAccounts(),
    call: async (cookie, account) => {
      tried.push(account.id)
      return { ok: false, kind: 'http', message: '请求体被拒' }
    },
  })
  assert.equal(r.ok, false)
  assert.equal(tried.length, 1, '参数类错误不该换号（换了也一样错）')
  assert.match(r.message, /请求体被拒/)
})

test('withAccountFailover：池空时给出可行动提示', async () => {
  const r = await withAccountFailover({ accounts: [], call: async () => ({ ok: true }) })
  assert.equal(r.ok, false)
  assert.match(r.message, /doubao_login/)
})

/* ===== 自动签到 ===== */

test('beijingDayKey 用 UTC+8 日历日', () => {
  // 2026-11-25T16:30Z = 2026-11-26 00:30 北京时间 → 属于 11-26
  assert.equal(beijingDayKey(new Date('2026-11-25T16:30:00Z')), '2026-11-26')
  assert.equal(beijingDayKey(new Date('2026-11-25T15:30:00Z')), '2026-11-25')
})

test('状态文档独立存在且默认开关为开', () => {
  const s = loadAutoCheckinState()
  assert.equal(s.enabled, true)
  assert.equal(s.lastDate, null)
  assert.ok(autoCheckinStatePath().includes('auto-checkin.json'))
})

test('alreadyRanToday 按今天判断', () => {
  saveAutoCheckinState({ schema: 'x', enabled: true, lastDate: beijingDayKey(), lastResults: [] })
  assert.equal(alreadyRanToday(), true)
  saveAutoCheckinState({ schema: 'x', enabled: true, lastDate: '2000-01-01', lastResults: [] })
  assert.equal(alreadyRanToday(), false)
})

test('runAutoCheckin 跑一遍并记下今天', async () => {
  saveAutoCheckinState({ schema: 'x', enabled: true, lastDate: null, lastResults: [] })
  const seen = []
  const r = await runAutoCheckin({
    delayMs: 0,
    accounts: () => [{ id: 'x', label: 'X' }],
    runOne: async account => {
      seen.push(account.id)
      return { ok: true, state: 'signed', message: '签到成功 +200' }
    },
  })
  assert.equal(r.ran, true)
  assert.deepEqual(seen, ['x'])
  assert.equal(alreadyRanToday(), true, '跑完应记今天')
})

test('runAutoCheckin 今天跑过就跳过', async () => {
  saveAutoCheckinState({ schema: 'x', enabled: true, lastDate: beijingDayKey(), lastResults: [] })
  let called = false
  const r = await runAutoCheckin({
    delayMs: 0,
    accounts: () => [{ id: 'x' }],
    runOne: async () => { called = true; return { ok: true } },
  })
  assert.equal(r.ran, false)
  assert.equal(called, false)
})

test('runAutoCheckin 开关关闭时不跑', async () => {
  saveAutoCheckinState({ schema: 'x', enabled: false, lastDate: null, lastResults: [] })
  let called = false
  const r = await runAutoCheckin({
    delayMs: 0,
    accounts: () => [{ id: 'x' }],
    runOne: async () => { called = true; return { ok: true } },
  })
  assert.equal(r.ran, false)
  assert.equal(called, false)
})

test('runAutoCheckin 池空时记今天（避免每次启动都刷）', async () => {
  saveAutoCheckinState({ schema: 'x', enabled: true, lastDate: null, lastResults: [] })
  const r = await runAutoCheckin({ delayMs: 0, accounts: () => [], runOne: async () => ({ ok: true }) })
  assert.equal(r.ran, false)
  assert.equal(alreadyRanToday(), true)
})

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})
