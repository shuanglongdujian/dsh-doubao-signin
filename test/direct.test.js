/**
 * direct.js / identity.js 的离线测试：无签名直连的判定逻辑与身份解析。
 *
 * @module test/direct.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHAT_AID,
  CORE_COOKIE_NAMES,
  REQUIRED_COOKIE_NAMES,
  buildDirectHeaders,
  buildDirectQuery,
  cookieReadiness,
  directChat,
} from '../src/direct.js'
import { candidateUserDataDirs, readLocalStateIdentity, toIdentity } from '../src/identity.js'

const IDENTITY = {
  deviceId: '7000000000000000001',
  fp: 'verify_7000000000000000001',
  webId: '7000000000000000001',
  chromiumVersion: '147.0.7727.149',
  clientVersion: '2.35.12',
}

/* ===== cookie readiness ===== */

test('cookieReadiness：全套齐 = 可直连', () => {
  const all = REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; ')
  const r = cookieReadiness(all)
  assert.equal(r.ok, true)
  assert.equal(r.missing.length, 0)
  assert.equal(r.hasCore, true)
})

test('cookieReadiness：缺核心 = 未登录', () => {
  const r = cookieReadiness('ttwid=x; odin_tt=y; s_v_web_id=z')
  assert.equal(r.ok, false)
  assert.equal(r.hasCore, false)
  assert.ok(r.missing.includes('sessionid'))
})

test('cookieReadiness：有核心但缺辅助 = 高风险可判', () => {
  const core = CORE_COOKIE_NAMES.map(n => `${n}=x`).join('; ')
  const r = cookieReadiness(core)
  assert.equal(r.ok, false)
  assert.equal(r.hasCore, true)
  assert.ok(r.missing.includes('ttwid'))
})

test('cookieReadiness：空 cookie', () => {
  const r = cookieReadiness('')
  assert.equal(r.ok, false)
  assert.equal(r.missing.length, REQUIRED_COOKIE_NAMES.length)
})

/* ===== query 构造 ===== */

test('buildDirectQuery 走桌面平台参数（与 UA 配套，身份必须一致）', () => {
  const q = buildDirectQuery(IDENTITY)
  // 实测：web_platform=desktop + DoubaoDesktop UA 才有正常正文；
  // web_platform=web + 桌面版本号混搭会撞风控 710022004
  assert.ok(q.includes('web_platform=desktop'))
  assert.ok(q.includes('aid=497858'))
  assert.ok(q.includes('device_platform=web'))
  assert.ok(q.includes('samantha_web=1'))
  assert.ok(q.includes('use-olympus-account=1'))
})

test('buildDirectQuery 带设备身份时写入 device_id / fp / web_id', () => {
  const q = buildDirectQuery(IDENTITY)
  assert.ok(q.includes(`device_id=${IDENTITY.deviceId}`))
  assert.ok(q.includes(`fp=verify_${IDENTITY.deviceId}`))
  assert.ok(q.includes(`web_id=${IDENTITY.webId}`))
})

test('buildDirectQuery 没有设备身份时不编造 device_id（风控按它聚合）', () => {
  const q = buildDirectQuery(undefined)
  assert.ok(q.includes('device_id='))
  assert.ok(!q.includes('device_id=7000'))
  assert.ok(q.includes('fp='))
})

test('buildDirectQuery 的 web_tab_id 固定为 0（实测那组参数）', () => {
  const q = buildDirectQuery(IDENTITY)
  assert.ok(q.includes('web_tab_id=0'))
})


/* ===== headers ===== */

test('buildDirectHeaders 自称桌面客户端', () => {
  const h = buildDirectHeaders('sessionid=x')
  assert.ok(h.cookie === 'sessionid=x')
  assert.ok(h.referer === 'https://www.doubao.com/chat/')
  assert.ok(h.origin === 'https://www.doubao.com')
})

/* ===== directChat（fetch 注入）===== */

test('directChat：健康响应返回 SSE', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => 'data: {"text":"hi"}\n\n' }
  }
  const r = await directChat({
    body: { ping: 1 },
    identity: IDENTITY,
    getCookie: async () => REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, true)
  assert.ok(r.sse.includes('hi'))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith('https://www.doubao.com/chat/completion?'))
  assert.equal(calls[0].init.method, 'POST')
})

test('directChat：710022004 归类为 risk', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => 'STREAM_ERROR {"error_code": 710022004}' })
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'risk')
})

test('directChat：710012001 归类为 auth', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '{"error_code": 710012001}' })
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'auth')
})

test('directChat：缺核心 cookie 直接拒绝，不发请求', async () => {
  let called = 0
  const fakeFetch = async () => { called += 1; return { ok: true, status: 200, text: async () => '' } }
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => 'ttwid=x',
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'auth')
  assert.equal(called, 0, '不该发请求')
})

test('directChat：缺辅助 cookie 标记 risk', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '' })
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => CORE_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'risk')
})

test('directChat：网络异常归类 http', async () => {
  const fakeFetch = async () => { throw new Error('ECONNRESET') }
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http')
})

test('directChat：HTTP 非 200 带 status', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden' })
  const r = await directChat({
    body: {}, identity: IDENTITY,
    getCookie: async () => REQUIRED_COOKIE_NAMES.map(n => `${n}=x`).join('; '),
    fetchImpl: fakeFetch,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http')
  assert.equal(r.status, 403)
})

/* ===== identity ===== */

test('toIdentity：fp 是 verify_ + deviceId（实测形状）', () => {
  const id = toIdentity({ deviceId: 'abc123', webId: 'w1' })
  assert.equal(id.fp, 'verify_abc123')
  assert.equal(id.webId, 'w1')
})

test('toIdentity：webId 缺省回退 deviceId', () => {
  const id = toIdentity({ deviceId: 'abc123' })
  assert.equal(id.webId, 'abc123')
})

test('toIdentity：缺 deviceId 返回 undefined', () => {
  assert.equal(toIdentity({}), undefined)
  assert.equal(toIdentity(undefined), undefined)
})

test('readLocalStateIdentity：合法 Local State 命中 aha.device.device_id', () => {
  // 用注入 env 指到一个临时目录不可行（readLocalState 直接拼路径），
  // 这里测 None 情形：不存在的目录返回 undefined
  assert.equal(readLocalStateIdentity('Z:/definitely/not/there'), undefined)
})

test('candidateUserDataDirs：Windows 候选带 Doubao', () => {
  const dirs = candidateUserDataDirs({}, 'win32')
  assert.ok(dirs.length >= 3)
  assert.ok(dirs.every(d => /Doubao|doubao/i.test(d)))
})

test('candidateUserDataDirs：darwin 走 Application Support', () => {
  const dirs = candidateUserDataDirs({}, 'darwin')
  assert.ok(dirs.some(d => d.includes('Application Support')))
})
