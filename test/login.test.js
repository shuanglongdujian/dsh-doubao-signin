/**
 * login.js 的离线测试：cookie 判定、凭据存取、浏览器发现、路径。
 *
 * @module test/login.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  CORE_COOKIE_NAMES,
  FULL_COOKIE_NAMES,
  LOGIN_URL,
  browserProfileDir,
  clearCredentials,
  cookieHeaderOf,
  credentialsPath,
  findBrowser,
  loadCredentials,
  resolveCookieHeader,
  saveCredentials,
  sessionReadiness,
  stateDir,
} from '../src/login.js'

/** 把登录态目录指到临时目录（避免污染真实 ~/.dsh）。 */
function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'doubao-login-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

const fullCookies = FULL_COOKIE_NAMES.map(name => ({ name, value: `v-${name}` }))

test('LOGIN_URL 是豆包会话页', () => {
  assert.equal(LOGIN_URL, 'https://www.doubao.com/chat/')
})

test('sessionReadiness：全套齐 = 已登录', () => {
  const r = sessionReadiness(fullCookies)
  assert.equal(r.ok, true)
  assert.equal(r.missingCore.length, 0)
})

test('sessionReadiness：缺核心 = 未登录', () => {
  const r = sessionReadiness([{ name: 'ttwid' }])
  assert.equal(r.ok, false)
  assert.deepEqual(r.missingCore.sort(), [...CORE_COOKIE_NAMES].sort())
})

test('sessionReadiness：有核心缺辅助仍算已登录（辅助项不阻塞）', () => {
  const only = CORE_COOKIE_NAMES.map(name => ({ name, value: 'x' }))
  const r = sessionReadiness(only)
  assert.equal(r.ok, true)
  assert.ok(r.missingAux.includes('ttwid'))
})

test('sessionReadiness：空列表/undefined 安全', () => {
  assert.equal(sessionReadiness([]).ok, false)
  assert.equal(sessionReadiness(undefined).ok, false)
})

test('cookieHeaderOf 拼成请求头', () => {
  assert.equal(cookieHeaderOf([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2')
  assert.equal(cookieHeaderOf([]), '')
})

test('stateDir / credentialsPath / browserProfileDir 都在 DSH_HOME 下', () => {
  withTempHome(dir => {
    assert.equal(stateDir(), path.join(dir, 'doubao-signin'))
    assert.equal(credentialsPath(), path.join(dir, 'doubao-signin', 'credentials.json'))
    assert.equal(browserProfileDir(), path.join(dir, 'doubao-signin', 'browser-profile'))
  })
})

test('saveCredentials → loadCredentials 往返', () => {
  withTempHome(() => {
    assert.equal(loadCredentials(), undefined)
    const file = saveCredentials(fullCookies)
    assert.ok(existsSync(file))
    const back = loadCredentials()
    assert.equal(back.cookies.length, fullCookies.length)
    assert.equal(back.cookies[0].name, 'sessionid')
    assert.ok(back.savedAt)
  })
})

test('loadCredentials：文件损坏返回 undefined 而不是抛', () => {
  withTempHome(() => {
    saveCredentials(fullCookies)
    writeFileSync(credentialsPath(), '{not json')
    assert.equal(loadCredentials(), undefined)
  })
})

test('clearCredentials 删掉凭据，不删浏览器目录', () => {
  withTempHome(() => {
    saveCredentials(fullCookies)
    assert.equal(clearCredentials(), true)
    assert.equal(loadCredentials(), undefined)
    assert.equal(clearCredentials(), false) // 已删
  })
})

test('findBrowser：win32 找不到时返回 undefined（不抛）', () => {
  const r = findBrowser({ __fake: '1' }, 'win32')
  assert.equal(r, undefined)
})

test('findBrowser：linux 候选路径不存在时返回 undefined', () => {
  assert.equal(findBrowser({}, 'linux'), undefined)
})

test('resolveCookieHeader：优先已保存凭据', async () => {
  await withTempHome(async () => {
    saveCredentials(fullCookies)
    let clientCalled = false
    const r = await resolveCookieHeader({
      fromClient: async () => { clientCalled = true; return 'sessionid=from-client' },
    })
    assert.equal(r.source, 'saved')
    assert.equal(r.ready, true)
    assert.ok(r.header.includes('sessionid=v-sessionid'))
    assert.equal(clientCalled, false, '有保存凭据就不该碰客户端')
  })
})

test('resolveCookieHeader：没保存时退回客户端', async () => {
  await withTempHome(async () => {
    const r = await resolveCookieHeader({
      fromClient: async () => 'sessionid=x; sessionid_ss=x; sid_tt=x; uid_tt=x',
    })
    assert.equal(r.source, 'client')
    assert.equal(r.ready, true)
  })
})

test('resolveCookieHeader：都没有时 ready=false 不抛', async () => {
  await withTempHome(async () => {
    const r = await resolveCookieHeader({})
    assert.equal(r.ready, false)
    assert.equal(r.header, '')
  })
})
