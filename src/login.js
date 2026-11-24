/**
 * 浏览器扫码登录 —— 不依赖豆包桌面客户端。
 *
 * 背景：本插件原先的凭据全部来自「已登录的豆包桌面客户端」（CDP 借它的会话）。
 * 这要求客户端装着、登录过、还开着调试端口。没有客户端就完全没有凭据来源，
 * 也就没有扫码入口。
 *
 * 这里的做法（同类插件实测可行的路线）：
 * 1. 拉起一个**独立 Chromium 用户目录**（`~/.dsh/doubao-signin/browser-profile`），
 *    不影响你日常浏览器；
 * 2. 打开 `https://www.doubao.com/chat/`，你用抖音 App 扫码（或手机号）登录；
 * 3. 通过 CDP 读页面 cookie（`Network.getCookies`），挑出豆包域下的会话 cookie；
 * 4. 落盘到 `~/.dsh/doubao-signin/credentials.json`，之后所有请求只读这份；
 * 5. 关闭浏览器。
 *
 * 安全边界：cookie 是用户的实时会话，只写本机用户目录，权限 0600；不写日志、不进命令行。
 *
 * @module src/login.js
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { CdpClient, listTargets } from './checkin.js'

/** 登录页（客户端真正签发会话的页面）。 */
export const LOGIN_URL = 'https://www.doubao.com/chat/'

/** 核心会话 cookie：缺任何一项都算未登录。 */
export const CORE_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']

/** 完整会话集合（辅助项，缺了不一定失败，但齐了最稳）。 */
export const FULL_COOKIE_NAMES = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt',
  'ttwid', 'odin_tt', 'passport_csrf_token', 's_v_web_id',
]

/** 登录态根目录。 */
export function stateDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'doubao-signin')
}

/** 凭据落盘路径。 */
export function credentialsPath() {
  return join(stateDir(), 'credentials.json')
}

/** 独立浏览器用户目录（持久化：第二次登录通常不用扫码）。 */
export function browserProfileDir() {
  return join(stateDir(), 'browser-profile')
}

/**
 * 读已保存的凭据。
 * @returns {{cookies: Array<{name: string, value: string}>, savedAt: string}|undefined} 凭据或 undefined。
 */
export function loadCredentials() {
  try {
    const raw = readFileSync(credentialsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.cookies) || parsed.cookies.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 保存凭据（权限 0600）。
 * @param {Array<{name: string, value: string}>} cookies - cookie 列表。
 * @returns {string} 落盘路径。
 */
export function saveCredentials(cookies) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const file = credentialsPath()
  const payload = { savedAt: new Date().toISOString(), cookies }
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows 上 chmod 部分无效，忽略 */ }
  return file
}

/**
 * 清空登录态（只删凭据，不删浏览器目录——那是下次免扫码的关键）。
 * @returns {boolean} 是否删掉了东西。
 */
export function clearCredentials() {
  const file = credentialsPath()
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/**
 * 判断 cookie 列表是否含核心会话。
 * @param {Array<{name: string}>} cookies - cookie 列表。
 * @returns {{ok: boolean, missingCore: string[], missingAux: string[]}} 评估。
 */
export function sessionReadiness(cookies) {
  const have = new Set((cookies ?? []).map(c => c?.name).filter(Boolean))
  const missingCore = CORE_COOKIE_NAMES.filter(n => !have.has(n))
  const missingAux = FULL_COOKIE_NAMES.filter(n => !have.has(n))
  return { ok: missingCore.length === 0, missingCore, missingAux }
}

/**
 * 把 cookie 列表拼成请求头。
 * @param {Array<{name: string, value: string}>} cookies - cookie 列表。
 * @returns {string} `k=v; k2=v2` 形式。
 */
export function cookieHeaderOf(cookies) {
  return (cookies ?? []).map(c => `${c.name}=${c.value}`).join('; ')
}

/**
 * 找本机 Chromium 系浏览器（Edge 优先：Windows 必装）。
 * @param {object} [env] - 环境变量。
 * @param {string} [platform] - 平台。
 * @returns {string|undefined} 可执行文件路径。
 */
export function findBrowser(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const roots = [
      env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA,
    ].filter(Boolean)
    const rels = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ]
    for (const root of roots) {
      for (const rel of rels) {
        const p = join(root, ...rel)
        if (existsSync(p)) return p
      }
    }
    return undefined
  }
  if (platform === 'darwin') {
    for (const p of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]) if (existsSync(p)) return p
    return undefined
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * 用浏览器扫码登录并抓回会话 cookie。
 *
 * 流程：拉起独立浏览器 → 打开登录页 → 轮询 cookie 直到核心会话齐备（用户完成扫码）
 * → 落盘 → 关闭浏览器。超时则关闭并报错。
 *
 * @param {object} [opts] - 配置。
 * @param {string} [opts.browserPath] - 浏览器路径（缺省自动发现）。
 * @param {number} [opts.port] - CDP 端口，默认 9333。
 * @param {number} [opts.timeoutMs] - 等待扫码的总时长，默认 180000（3 分钟）。
 * @param {(msg: string) => void} [opts.onProgress] - 进度回调（给人看的）。
 * @param {object} [opts.env] - 环境变量。
 * @param {string} [opts.platform] - 平台。
 * @returns {Promise<{ok: boolean, message: string, path?: string, cookieCount?: number, missingCore?: string[]}>} 结果。
 */
export async function loginWithBrowser(opts = {}) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const port = opts.port ?? 9333
  const timeoutMs = opts.timeoutMs ?? 180_000
  const say = opts.onProgress ?? (() => {})

  const browserPath = opts.browserPath || findBrowser(env, platform)
  if (!browserPath) {
    return { ok: false, message: '没找到 Chrome 或 Edge。装一个再用扫码登录，或改用已登录的豆包客户端。' }
  }

  const profile = browserProfileDir()
  mkdirSync(profile, { recursive: true })

  say(`启动浏览器: ${browserPath}`)
  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    LOGIN_URL,
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  const deadline = Date.now() + timeoutMs
  let conn = null
  try {
    // 等页面起来
    let page
    while (Date.now() < deadline) {
      try {
        const targets = await listTargets(port)
        page = targets.find(t => t.type === 'page' && /doubao\.com/.test(t.url ?? ''))
        if (page) break
      } catch {
        // 浏览器还没开调试口
      }
      await sleep(1000)
    }
    if (!page) {
      return { ok: false, message: `浏览器起来了但没找到豆包页面（${timeoutMs}ms 内）。可能被安全软件拦了调试端口。` }
    }

    conn = new CdpClient(page.webSocketDebuggerUrl)
    await conn.connect()
    say('已连上页面，请在弹出的浏览器窗口里用抖音 App 扫码登录')

    // 轮询 cookie
    let cookies = []
    while (Date.now() < deadline) {
      try {
        const res = await conn.call('Network.getCookies', { urls: ['https://www.doubao.com', LOGIN_URL] })
        cookies = (res?.result?.cookies ?? res?.cookies ?? []).filter(c => /doubao\.com$/i.test(String(c?.domain ?? '').replace(/^\./, '')))
        const ready = sessionReadiness(cookies)
        if (ready.ok) {
          const file = saveCredentials(cookies.map(c => ({ name: c.name, value: c.value })))
          say(`登录成功，已保存 ${cookies.length} 个 cookie`)
          return { ok: true, message: `扫码登录成功，凭据已保存（${cookies.length} 个 cookie）`, path: file, cookieCount: cookies.length }
        }
      } catch {
        // 页面导航中会短暂失败
      }
      await sleep(2000)
    }

    const ready = sessionReadiness(cookies)
    return {
      ok: false,
      message: `等待扫码超时（${Math.round(timeoutMs / 1000)}s）。${ready.missingCore.length ? '缺核心会话 cookie: ' + ready.missingCore.join(', ') : ''}`,
      missingCore: ready.missingCore,
    }
  } finally {
    try { conn?.close() } catch { /* 已断开 */ }
    try { child.kill() } catch { /* 可能已退出 */ }
  }
}

/**
 * 统一取 cookie：优先已保存的扫码凭据，其次借客户端页面。
 * @param {object} opts - 依赖。
 * @param {() => Promise<string>} [opts.fromClient] - 从客户端页面取 cookie 的回调。
 * @returns {Promise<{header: string, source: 'saved'|'client', ready: boolean}>} cookie 头与来源。
 */
export async function resolveCookieHeader({ fromClient } = {}) {
  const saved = loadCredentials()
  if (saved) {
    const ready = sessionReadiness(saved.cookies)
    if (ready.ok) return { header: cookieHeaderOf(saved.cookies), source: 'saved', ready: true }
  }
  if (fromClient) {
    const header = await fromClient()
    const names = String(header ?? '').split(';').map(p => p.split('=')[0]?.trim()).filter(Boolean)
    return { header, source: 'client', ready: sessionReadiness(names.map(name => ({ name }))).ok }
  }
  return { header: '', source: 'saved', ready: false }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

void dirname
