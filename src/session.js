/**
 * 凭据有效性检查与静默续期。
 *
 * 问题背景：豆包 session（sessionid 等）会过期。过期后插件表现是「每次都要重新扫码」，
 * 但其实只需要刷新一下 cookie —— 登录态还在我们自己的浏览器 profile 里。
 *
 * 做法：
 * 1. 用一个**只读的轻量请求**（额度端点）判断凭据是否还有效；
 * 2. 无效时，用**持久化的浏览器 profile** 启动一次浏览器（**不弹窗**：
 *    Edge/Chrome 的 --headless=new 仍能读 profile 里的 cookie），
 *    从页面里重新读一遍 cookie 存回磁盘 —— 这一步完全静默，不需要用户扫码；
 * 3. 只有连静默续期都失败（profile 里登录态也没了），才需要真的扫码。
 *
 * @module src/session.js
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { CdpClient, listTargets } from './checkin.js'
import { browserProfileDir, findBrowser, loadCredentials, saveCredentials, sessionReadiness, cookieHeaderOf } from './login.js'

/** 登录失效的错误码。 */
export const LOGIN_INVALID = 710012001

/** 判定用的探针端点（只读、便宜）。 */
const PROBE_PATH = '/alice/commerce/sale/subscription/quota/summary/'

/**
 * 判断当前凭据是否还有效。
 * @param {string} cookieHeader - Cookie 头。
 * @param {object} [opts] - 配置。
 * @param {typeof fetch} [opts.fetchImpl] - fetch 注入。
 * @param {number} [opts.timeoutMs] - 超时。
 * @returns {Promise<{valid: boolean, code?: number, reason: string}>} 判定结果。
 */
export async function checkSession(cookieHeader, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  if (!cookieHeader) return { valid: false, reason: '没有凭据' }
  try {
    const res = await fetchImpl(`https://www.doubao.com${PROBE_PATH}?aid=497858&device_platform=web&_t=${Date.now()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        origin: 'https://www.doubao.com',
        referer: 'https://www.doubao.com/chat/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        cookie: cookieHeader,
      },
      body: '{}',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    const body = await res.json().catch(() => null)
    const code = Number(body?.code ?? 0)
    if (code === LOGIN_INVALID) {
      return { valid: false, code, reason: '豆包登录已过期（710012001）' }
    }
    if (!res.ok) {
      return { valid: false, code: res.status, reason: `额度端点 HTTP ${res.status}` }
    }
    return { valid: true, reason: '凭据有效' }
  } catch (error) {
    return { valid: false, reason: `检查失败: ${error.message}` }
  }
}

/**
 * 静默续期：用持久化的浏览器 profile 重新读一次 cookie，**不弹窗**。
 *
 * 关键点：Edge/Chrome 支持 `--headless=new`，它仍会加载 user-data-dir 里的
 * 登录态；配合 CDP 的 Network.getCookies 就能把刷新后的 cookie 读出来。
 * 只有当 profile 里本来就没登录态时，续期才会失败——那时才真的需要扫码。
 *
 * @param {object} [opts] - 配置。
 * @param {number} [opts.port] - CDP 端口，默认 9334（与扫码用的 9333 错开）。
 * @param {number} [opts.timeoutMs] - 总超时，默认 45s。
 * @param {(msg: string) => void} [opts.onProgress] - 进度回调。
 * @returns {Promise<{ok: boolean, message: string, cookieCount?: number}>} 结果。
 */
export async function refreshSessionSilently(opts = {}) {
  const port = opts.port ?? 9334
  const timeoutMs = opts.timeoutMs ?? 45_000
  const say = opts.onProgress ?? (() => {})
  const browserPath = findBrowser()
  if (!browserPath) return { ok: false, message: '没找到 Chrome/Edge，无法静默续期' }

  const profile = browserProfileDir()
  if (!fs.existsSync(profile)) {
    return { ok: false, message: '没有本地浏览器 profile（首次使用需要扫码登录一次）' }
  }

  say('静默续期中（不弹窗）…')
  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'https://www.doubao.com/chat/',
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  const deadline = Date.now() + timeoutMs
  let conn = null
  try {
    let page
    while (Date.now() < deadline) {
      try {
        const targets = await listTargets(port)
        page = targets.find(t => t.type === 'page' && /doubao\.com/.test(t.url ?? ''))
        if (page) break
      } catch { /* 还没起来 */ }
      await sleep(800)
    }
    if (!page) return { ok: false, message: '静默续期超时（浏览器没起来）' }

    conn = new CdpClient(page.webSocketDebuggerUrl)
    await conn.connect()
    try { await conn.call('Network.enable') } catch { /* 可选 */ }

    // 给页面一点时间加载并刷新 cookie
    const cookies = []
    while (Date.now() < deadline) {
      try {
        const res = await conn.call('Network.getCookies', { urls: ['https://www.doubao.com'] })
        const list = (res?.result?.cookies ?? res?.cookies ?? [])
          .filter(c => /(^|\.)doubao\.com$/i.test(String(c?.domain ?? '').replace(/^\./, '')))
        const ready = sessionReadiness(list)
        if (ready.ok) {
          cookies.length = 0
          cookies.push(...list)
          break
        }
      } catch { /* 导航中 */ }
      await sleep(1500)
    }

    if (!cookies.length) {
      return { ok: false, message: '本地浏览器 profile 里的登录态也没了——需要重新扫码' }
    }
    saveCredentials(cookies.map(c => ({ name: c.name, value: c.value })))
    return { ok: true, message: `静默续期成功（${cookies.length} 个 cookie）`, cookieCount: cookies.length }
  } catch (error) {
    return { ok: false, message: `静默续期失败: ${error.message}` }
  } finally {
    try { conn?.close() } catch { /* 已断开 */ }
    try { child.kill() } catch { /* 可能已退出 */ }
  }
}

/**
 * 一站式：确保有可用凭据——有效就返回；过期则先静默续期；续期失败才提示扫码。
 * @param {object} opts - 配置。
 * @returns {Promise<{ok: boolean, source: string, message: string, needsScan: boolean}>} 结果。
 */
export async function ensureSession(opts = {}) {
  const saved = loadCredentials()
  if (!saved) {
    return { ok: false, source: 'none', message: '尚未登录，用 doubao_login 扫码登录一次即可。', needsScan: true }
  }
  const header = cookieHeaderOf(saved.cookies)
  const check = await checkSession(header, opts)
  if (check.valid) {
    return { ok: true, source: 'saved', message: '凭据有效', needsScan: false }
  }

  const refreshed = await refreshSessionSilently(opts)
  if (refreshed.ok) {
    return { ok: true, source: 'refreshed', message: refreshed.message, needsScan: false }
  }
  return {
    ok: false,
    source: 'expired',
    message: `${check.reason}；${refreshed.message}`,
    needsScan: true,
  }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
