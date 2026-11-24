/**
 * routes.js 的离线测试：loopback 闸门与响应形状。
 *
 * @module test/routes.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUOTA_ROUTE_PATH,
  hostMatchesListener,
  originIsLoopback,
  registerQuotaRoute,
} from '../src/routes.js'

/* ===== host 闸 ===== */

test('hostMatchesListener：localhost / 127.0.0.1 / ::1 可信', () => {
  assert.equal(hostMatchesListener('localhost:60331'), true)
  assert.equal(hostMatchesListener('127.0.0.1:60331'), true)
  assert.equal(hostMatchesListener('[::1]:60331'), true)
})

test('hostMatchesListener：非本机名不可信（DNS rebinding 面）', () => {
  assert.equal(hostMatchesListener('evil.example.com'), false)
  assert.equal(hostMatchesListener('0.0.0.0:80'), false)
  assert.equal(hostMatchesListener(''), false)
  assert.equal(hostMatchesListener(undefined), false)
})

test('hostMatchesListener：与监听器本地地址完全一致也可信', () => {
  assert.equal(hostMatchesListener('192.168.1.5:8080', '192.168.1.5'), true)
  assert.equal(hostMatchesListener('192.168.1.5:8080', '192.168.1.6'), false)
})

/* ===== origin 闸 ===== */

test('originIsLoopback：缺失放行（curl / 插件自身调用）', () => {
  assert.equal(originIsLoopback(undefined), true)
  assert.equal(originIsLoopback(''), true)
})

test('originIsLoopback：本机回环可信，外部 Origin 拒绝', () => {
  assert.equal(originIsLoopback('http://localhost:60331'), true)
  assert.equal(originIsLoopback('http://127.0.0.1:60331'), true)
  assert.equal(originIsLoopback('http://evil.example.com'), false)
})

test('originIsLoopback：畸形 Origin 拒绝', () => {
  assert.equal(originIsLoopback('not a url'), false)
})

/* ===== registerQuotaRoute ===== */

/**
 * 构造假 webServer + 假 req/res。
 * @returns {object} { ctx, handler, makeReq, makeRes }。
 */
function makeHarness() {
  const registered = []
  const effects = []
  const ctx = {
    effect(fn) { effects.push(fn) },
    webServer: { register(entry) { registered.push(entry); return () => {} } },
  }
  return {
    ctx,
    registered,
    boot() { for (const fn of effects) fn() },
    get handler() { return registered[0]?.handler },
    makeReq(method = 'GET', headers = {}, localAddress = '127.0.0.1') {
      return { method, headers, socket: { localAddress } }
    },
    makeRes() {
      const res = { statusCode: 0, headers: {}, body: null }
      res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers }
      res.end = body => { res.body = body ? JSON.parse(body) : null }
      return res
    },
  }
}

test('registerQuotaRoute：注册 exact 路径，disposer 生效', () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: true, total: 1, windows: [] }) })
  h.boot()
  assert.equal(h.registered.length, 1)
  assert.equal(h.registered[0].path, QUOTA_ROUTE_PATH)
  assert.equal(h.registered[0].kind, 'exact')
})

test('registerQuotaRoute：GET 成功返回允许清单字段', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, {
    readQuota: async () => ({ ok: true, total: 123, windows: [{ name: '套餐积分', remaining: 100, total: 9000, usedPercent: 5 }], summary: '剩余额度合计: 123' }),
  })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('GET', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.total, 123)
  assert.equal(res.body.windows[0].name, '套餐积分')
  assert.equal(res.headers['cache-control'], 'no-store')
  // 不该有上游透传字段
  assert.ok(!('raw' in res.body))
})

test('registerQuotaRoute：坏 Host 403', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: true }) })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('GET', { host: 'evil.example.com' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error, 'host-not-trusted')
})

test('registerQuotaRoute：外部 Origin 403', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: true }) })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('GET', { host: 'localhost:1', origin: 'http://evil.example.com' }), res)
  assert.equal(res.statusCode, 403)
})

test('registerQuotaRoute：POST 405', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: true }) })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('POST', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 405)
})

test('registerQuotaRoute：读取失败 500 且不泄内部信息', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => { throw new Error('cookie jar missing secret=x') } })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('GET', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error, 'quota-read-failed')
  assert.ok(!JSON.stringify(res.body).includes('secret'))
})

test('registerQuotaRoute：readQuota 返回 ok:false 时照实转发', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: false, summary: '客户端没在运行' }) })
  h.boot()
  const res = h.makeRes()
  await h.handler(h.makeReq('GET', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.summary, '客户端没在运行')
})

/* ===== 签到与扫码登录路由 ===== */

test('registerQuotaRoute：注册 5 条路由（quota/checkin/login×3）', () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, {
    readQuota: async () => ({ ok: true, total: 1, windows: [] }),
    runCheckin: async () => ({ ok: true, state: 'done', message: '签到成功' }),
    startLogin: async () => ({ phase: 'starting' }),
    pollLogin: () => ({ phase: 'waiting' }),
    cancelLogin: () => {},
  })
  h.boot()
  const paths = h.registered.map(r => r.path).sort()
  assert.deepEqual(paths, [
    '/plugins/dsh-doubao-signin/checkin/run',
    '/plugins/dsh-doubao-signin/login/cancel',
    '/plugins/dsh-doubao-signin/login/poll',
    '/plugins/dsh-doubao-signin/login/start',
    '/plugins/dsh-doubao-signin/quota',
  ])
})

test('registerQuotaRoute：签到路由 POST 成功返回 state', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, {
    readQuota: async () => ({ ok: true }),
    runCheckin: async () => ({ ok: true, state: 'signed', message: '签到成功 +200' }),
  })
  h.boot()
  const handler = h.registered.find(r => r.path.endsWith('/checkin/run')).handler
  const res = h.makeRes()
  await handler(h.makeReq('POST', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.state, 'signed')
})

test('registerQuotaRoute：签到路由 GET 被拒（405）', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, { readQuota: async () => ({ ok: true }), runCheckin: async () => ({ ok: true }) })
  h.boot()
  const handler = h.registered.find(r => r.path.endsWith('/checkin/run')).handler
  const res = h.makeRes()
  await handler(h.makeReq('GET', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 405)
})

test('registerQuotaRoute：扫码 start → poll → cancel 全链路', async () => {
  const h = makeHarness()
  let phase = 'idle'
  registerQuotaRoute(h.ctx, {
    readQuota: async () => ({ ok: true }),
    startLogin: async () => { phase = 'waiting'; return { phase } },
    pollLogin: () => ({ phase }),
    cancelLogin: () => { phase = 'idle' },
  })
  h.boot()
  const start = h.registered.find(r => r.path.endsWith('/login/start')).handler
  const poll = h.registered.find(r => r.path.endsWith('/login/poll')).handler
  const cancel = h.registered.find(r => r.path.endsWith('/login/cancel')).handler

  let res = h.makeRes()
  await start(h.makeReq('POST', { host: 'localhost:1' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.phase, 'waiting')

  res = h.makeRes()
  await poll(h.makeReq('GET', { host: 'localhost:1' }), res)
  assert.equal(res.body.phase, 'waiting')

  res = h.makeRes()
  await cancel(h.makeReq('POST', { host: 'localhost:1' }), res)
  assert.equal(res.body.phase, 'idle')
})

test('registerQuotaRoute：扫码路由同样受 loopback 闸门保护', async () => {
  const h = makeHarness()
  registerQuotaRoute(h.ctx, {
    readQuota: async () => ({ ok: true }),
    startLogin: async () => ({ phase: 'starting' }),
  })
  h.boot()
  const start = h.registered.find(r => r.path.endsWith('/login/start')).handler
  const res = h.makeRes()
  await start(h.makeReq('POST', { host: 'evil.example.com' }), res)
  assert.equal(res.statusCode, 403)
})
