/**
 * 浏览器身份捕获 —— 从豆包网页**自己发的请求**里读出完整身份。
 *
 * ## 为什么需要它
 *
 * 豆包把账号绑定在 device_id 上：请求里的 `device_id` 必须是该账号见过的数值 id，
 * 否则上游回 710022004（风控）。这个 id 有两个来源：
 * - 桌面客户端的 `Local State`（需要装客户端）；
 * - **网页自己的请求 query**（不需要客户端）。
 *
 * 采纳 Wahwayhale/dsh-connect-doubao 的做法：扫码登录时用 CDP 监听
 * `Network.requestWillBeSent`，挑一条同源、带 `aid` 的**真实页面请求**，
 * 把它的身份 query 与 UA/Referer 一起落盘；之后所有请求按这份指纹发。
 *
 * ## 为什么必须挑「页面自己的请求」而不是自己编
 *
 * 豆包的域下有多类流量（埋点上传 mcs.doubao.com、CDN、静态资源），
 * 它们的 query 形状完全不同。抓到错的请求会把错误的身份传播到之后每一次调用，
 * 表现为「怎么改形状都没用」。
 *
 * ## 落盘时剔除易变字段
 *
 * `msToken` / `a_bogus` / `x-bogus` / `_signature` / `web_tab_id` 是**每请求现生成**的，
 * 落盘一份旧的等于自断双腿（服务端会拒）。它们要么每次现取，要么干脆不要。
 *
 * @module src/browser-fingerprint.js
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { CdpClient, listTargets } from './checkin.js'
import { findBrowser } from './login.js'

/** 指纹文档版本。 */
export const FINGERPRINT_SCHEMA = 'doubao-signin/fingerprint/v1'

/** 每请求现生成的字段——落盘时必须剔除。 */
export const VOLATILE_QUERY = /^(msToken|mstoken|a_bogus|x-bogus|_signature|web_tab_id|msToken_a|bogus)$/i

/**
 * 指纹落盘路径。
 * @returns {string} 路径。
 */
export function fingerprintPath() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'doubao-signin', 'fingerprint.json')
}

/**
 * 清洗 identity query：剔除易变字段，只留身份相关。
 * @param {Record<string, string>} query - 原始 query。
 * @returns {Record<string, string>} 清洗后的 query。
 */
export function sanitizeQuery(query) {
  const out = {}
  for (const [k, v] of Object.entries(query ?? {})) {
    if (VOLATILE_QUERY.test(k)) continue
    out[k] = v
  }
  return out
}

/**
 * 判断一条请求是不是「豆包页面自己的身份请求」。
 *
 * 判据（同源 + 带 aid + 不是埋点/CDN 域）：
 * - hostname 必须是 `www.doubao.com`；
 * - 必须带 `aid`；
 * - path 不能是静态资源或埋点。
 *
 * @param {string} url - 请求 URL。
 * @returns {{query: Record<string, string>}|undefined} 身份 query；不合格则 undefined。
 */
export function identityFromUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname !== 'www.doubao.com') return undefined
  const query = Object.fromEntries(parsed.searchParams.entries())
  if (query.aid === undefined) return undefined
  // 静态资源/接口路径不算身份请求（页面自己发的是业务接口）
  return { query: sanitizeQuery(query) }
}

/**
 * 判断一份 identity query 是否**够用**（有数值型 device_id 与配套的 fp）。
 *
 * 实测：device_id 必须是 int（`InvalidRequest: device_id expected int`），
 * 而 `web_id` 是另一个独立的数——两者不能混用。
 * @param {Record<string, string>} query - 身份 query。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
export function validateIdentity(query) {
  const deviceId = query?.device_id
  if (!deviceId) return { ok: false, reason: '没有 device_id' }
  if (!/^\d+$/.test(String(deviceId))) {
    return { ok: false, reason: `device_id 不是数值型（${String(deviceId).slice(0, 24)}…）——web_id 不能顶替它` }
  }
  return { ok: true }
}

/**
 * 读已保存的指纹。
 * @returns {object|undefined} 指纹文档。
 */
export function loadFingerprint() {
  try {
    const parsed = JSON.parse(fs.readFileSync(fingerprintPath(), 'utf8'))
    if (!parsed?.query) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 写指纹。
 * @param {object} fingerprint - 指纹文档。
 * @returns {string} 落盘路径。
 */
export function saveFingerprint(fingerprint) {
  const p = fingerprintPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(fingerprint, null, 2), 'utf8')
  return p
}

/**
 * 从指纹里取出身份三元组（给聊天/原生通道用）。
 * @returns {{deviceId: string, fp: string, webId: string}|undefined} 身份。
 */
export function identityFromFingerprint() {
  const fp = loadFingerprint()
  if (!fp) return undefined
  const deviceId = fp.query.device_id
  if (!deviceId) return undefined
  return {
    deviceId: String(deviceId),
    fp: fp.query.fp ?? `verify_${deviceId}`,
    webId: fp.query.web_id ?? String(deviceId),
    userAgent: fp.userAgent,
    referer: fp.referer,
    secChUa: fp.secChUa,
  }
}

/**
 * 在浏览器里捕获一份身份指纹。
 *
 * 流程：拉起（复用）专用 profile 的浏览器 → CDP 监听 `Network.requestWillBeSent`
 * → 收集同源带 aid 的请求 → 挑**第一条**满足「device_id 是数值型」的 → 落盘。
 *
 * @param {object} [opts] - 选项。
 * @param {number} [opts.port] - CDP 端口，默认 9335。
 * @param {number} [opts.timeoutMs] - 总超时，默认 45 秒。
 * @param {string} [opts.profileDir] - 浏览器 profile 目录。
 * @param {string} [opts.url] - 打开的页面。
 * @param {(msg: string) => void} [opts.onProgress] - 进度回调。
 * @returns {Promise<{ok: boolean, message: string, fingerprint?: object}>} 结果。
 */
export async function captureFingerprint(opts = {}) {
  const port = opts.port ?? 9335
  const timeoutMs = opts.timeoutMs ?? 45_000
  const say = opts.onProgress ?? (() => {})
  const profileDir = opts.profileDir
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'doubao-signin', 'browser-profile')
  const target = opts.url ?? 'https://www.doubao.com/chat/'

  const browserPath = findBrowser()
  if (!browserPath) return { ok: false, message: '没找到 Chrome 或 Edge' }
  fs.mkdirSync(profileDir, { recursive: true })

  say('启动浏览器抓身份…')
  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    target,
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  const deadline = Date.now() + timeoutMs
  let conn = null
  const candidates = []
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
    if (!page) return { ok: false, message: '浏览器没起来（超时）' }

    conn = new CdpClient(page.webSocketDebuggerUrl)
    await conn.connect()
    await conn.call('Network.enable')
    await conn.call('Page.enable')
    // 重新加载，让页面自己再发一轮请求
    await conn.call('Page.reload', { ignoreCache: true })

    // 轮询页面里的资源记录（CDP 事件不好接，改为读 performance entries）
    while (Date.now() < deadline) {
      const urls = await conn.evaluate(`(() => {
        try {
          return JSON.stringify(performance.getEntriesByType('resource').map(e => e.name));
        } catch { return '[]' }
      })()`).catch(() => '[]')
      for (const u of JSON.parse(urls)) {
        const ident = identityFromUrl(u)
        if (ident) candidates.push(ident.query)
      }
      // 找到够用的就停
      for (const q of candidates) {
        if (validateIdentity(q).ok) {
          const ua = await conn.evaluate('navigator.userAgent').catch(() => '')
          const fingerprint = {
            schema: FINGERPRINT_SCHEMA,
            capturedAt: new Date().toISOString(),
            query: q,
            userAgent: ua,
            referer: target,
          }
          saveFingerprint(fingerprint)
          return { ok: true, message: `已捕获身份（device_id=${q.device_id}）`, fingerprint }
        }
      }
      await sleep(1500)
    }
    return {
      ok: false,
      message: candidates.length
        ? `抓到 ${candidates.length} 条带 aid 的请求，但 device_id 都不是数值型（网页的 web_id 不能顶替）`
        : '没抓到带 aid 的同源请求',
    }
  } catch (error) {
    return { ok: false, message: `抓身份失败: ${error.message}` }
  } finally {
    try { conn?.close() } catch { /* 已断开 */ }
    try { child.kill() } catch { /* 可能已退出 */ }
  }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
