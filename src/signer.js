/**
 * a_bogus 签名与非流式请求执行，全部借本机豆包客户端的浏览器环境。
 *
 * 为什么不用 Playwright 自起 Chromium：
 * 1. 豆包桌面客户端本身就是 Electron，附带完整 Chromium 与已登录会话；
 * 2. `frontierSign` 是混淆过的 JS，每版都变，纯 JS 复刻必然持续腐烂；
 * 3. 我们再起一个浏览器 = 多一份风控面 + 多 300MB 内存 + 还要重新登录。
 *
 * 所以签名一律走 CDP 到客户端里已经登录的页面，把它当黑盒调用。
 * 结果缓存 120 秒（同一组 query 复用），跨请求共享。
 *
 * @module src/signer.js
 */
import { CdpClient, ensurePort, findClient, listTargets } from './checkin.js'
import { CHAT_PATH } from './protocol.js'
import { QUOTA_PATH } from './quota.js'

/** 签名缓存时长。 */
export const SIGN_TTL_MS = 120_000

/** 会话页地址。 */
const CHAT_PAGE = 'https://www.doubao.com/chat/'

/** 默认 UA，与客户端内置 Chromium 对齐。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/**
 * 借客户端浏览器环境做签名与发请求的门面。
 */
export class ClientSigner {
  /**
   * @param {object} opts - 配置。
   * @param {number} [opts.port] - CDP 端口。
   * @param {string} [opts.exePath] - 客户端路径。
   * @param {boolean} [opts.relaunchClient] - 是否允许重启客户端。
   * @param {(msg: string) => void} [opts.log] - 日志回调。
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 9222
    this.exePath = opts.exePath
    this.relaunchClient = opts.relaunchClient === true
    this.log = opts.log ?? (() => {})
    this.cache = new Map()
    this.conn = null
    this.targetId = null
  }

  /**
   * 连上客户端里的豆包会话页；没有就开一个。
   * @returns {Promise<void>} 就绪。
   */
  async connect() {
    if (this.conn) return
    const exe = await findClient(this.exePath)
    await this.ensurePort(exe)

    let targets = await listTargets(this.port)
    let page = targets.find(t => t.type === 'page' && /doubao\.com/.test(t.url ?? ''))

    if (!page) {
      const anyPage = targets.find(t => t.type === 'page')
      if (!anyPage) throw new Error('客户端没有可用页面，无法借浏览器环境签名')

      const boot = new CdpClient(anyPage.webSocketDebuggerUrl)
      await boot.connect()
      try {
        await boot.call('Page.enable')
        await boot.call('Target.createTarget', { url: CHAT_PAGE }).catch(() => {})
      } finally {
        boot.close()
      }
      await sleep(3000)
      targets = await listTargets(this.port)
      page = targets.find(t => t.type === 'page' && /doubao\.com/.test(t.url ?? ''))
      if (!page) throw new Error('开不出 doubao.com 页面，客户端可能禁止了新标签')
    }

    this.targetId = page.id
    this.conn = new CdpClient(page.webSocketDebuggerUrl)
    await this.conn.connect()

    // frontierSign 是页面脚本注入的，等它挂到 window 上
    await this.waitForSignerFunction()
  }

  /**
   * 确保调试端口在监听（复用 checkin.js 的同一份实现，避免两处漂移）。
   * @param {string} exe - 客户端路径。
   * @returns {Promise<void>} 端口就绪。
   */
  async ensurePort(exe) {
    try {
      await listTargets(this.port)
      return
    } catch {
      if (!this.relaunchClient) {
        throw new Error(
          `CDP 端口 ${this.port} 没开。豆包的 --remote-debugging-port 只能在启动时带上，`
          + '所以要么手动带它启动客户端，要么把 relaunchClient 设为 true（会重启客户端）。',
        )
      }
    }
    await ensurePort(exe, this.port, true, msg => this.log(msg))
  }

  /**
   * 等页面暴露 frontierSign。
   * @returns {Promise<void>} 可用时返回。
   */
  async waitForSignerFunction() {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const ok = await this.conn
        .evaluate('!!(window.byted_acrawler && window.byted_acrawler.frontierSign)')
        .catch(() => false)
      if (ok) return
      await sleep(1000)
    }
    throw new Error('页面没暴露 frontierSign（可能被风控页拦了，或前端改版）。用 dryRun 看一眼页面长什么样。')
  }

  /**
   * 取当前页面的 cookie 头。
   * @returns {Promise<string>} `k=v; k2=v2` 形式的 Cookie。
   */
  async cookieHeader() {
    const raw = await this.conn.evaluate('document.cookie')
    return String(raw ?? '')
  }

  /**
   * 取 msToken。
   * @returns {Promise<string>} msToken 值，没有则空串。
   */
  async msToken() {
    const raw = await this.cookieHeader()
    const hit = /(?:^|;\s*)msToken=([^;]+)/.exec(raw)
    return hit ? hit[1] : ''
  }

  /**
   * 对一组 query 签名。
   * @param {string} query - 不带问号的 query string。
   * @param {boolean} [force] - 忽略缓存强制重签。
   * @returns {Promise<{aBogus: string, msToken: string, query: string, at: number}>} 签名结果。
   */
  async sign(query, force = false) {
    const q = query.startsWith('?') ? query : `?${query}`
    const hit = this.cache.get(q)
    if (hit && !force && Date.now() - hit.at < SIGN_TTL_MS) return hit

    let raw
    try {
      raw = await this.conn.evaluate(
        `JSON.stringify(window.byted_acrawler.frontierSign({query: ${JSON.stringify(q)}}))`,
      )
    } catch (error) {
      // 页面可能已跳转或被风控，重载一次再试
      this.log(`签名失败，重载页面重试: ${error.message}`)
      await this.conn.evaluate('location.reload()').catch(() => {})
      await sleep(4000)
      await this.waitForSignerFunction()
      raw = await this.conn.evaluate(
        `JSON.stringify(window.byted_acrawler.frontierSign({query: ${JSON.stringify(q)}}))`,
      )
    }

    const parsed = JSON.parse(raw)
    const aBogus = pickString(parsed, ['a_bogus', 'a-bogus', 'X-Bogus', 'x-bogus', 'xbogus'])
    if (!aBogus) throw new Error(`frontierSign 返回里没有 a_bogus: ${String(raw).slice(0, 200)}`)

    const value = { aBogus, msToken: await this.msToken(), query: q, at: Date.now() }
    this.cache.set(q, value)
    return value
  }

  /**
   * 发一次带签名的非流式聊天请求。
   * @param {object} body - 请求体。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<string>} 上游 SSE 原文。
   */
  async postChat(body, signal) {
    const query = `aid=497858&device_platform=web&pc_version=3.45.5&_t=${Date.now()}`
    const signed = await this.sign(query)
    const url = `https://www.doubao.com${CHAT_PATH}?${query}&a_bogus=${encodeURIComponent(signed.aBogus)}`

    const headers = {
      'content-type': 'application/json',
      'user-agent': UA,
      accept: 'text/event-stream, application/json;q=0.9, */*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      origin: 'https://www.doubao.com',
      referer: 'https://www.doubao.com/chat/',
      cookie: await this.cookieHeader(),
    }
    if (signed.msToken) headers['x-ms-token'] = signed.msToken

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`上游 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return res.text()
  }

  /**
   * 查额度汇总（不消耗推理额度）。
   *
   * 实测结论（dsh-connect-doubao，2026-11）：额度端点只认 cookie，不验 a_bogus——
   * 故意发坏签名的请求照样 200。所以这里直接用 cookie 直连，不进签名缓存。
   * @param {AbortSignal} [signal] - 取消信号。
   * @param {string} [cookieHeader] - 显式 cookie 头（扫码登录保存的那份）；缺省用页面 cookie。
   * @returns {Promise<object>} 上游 JSON。
   */
  async getQuota(signal, cookieHeader) {
    const url = `https://www.doubao.com${QUOTA_PATH}?aid=497858&device_platform=web&_t=${Date.now()}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        origin: 'https://www.doubao.com',
        referer: 'https://www.doubao.com/chat/',
        cookie: cookieHeader || await this.cookieHeader(),
      },
      body: '{}',
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`额度端点 HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  /** 释放连接。 @returns {void} */
  close() {
    this.conn?.close()
    this.conn = null
  }

  /** 清空签名缓存。 @returns {void} */
  invalidate() {
    this.cache.clear()
  }
}

/**
 * 从任意嵌套结构里挑出第一个命中的字符串字段。
 * @param {unknown} obj - 待搜索的值。
 * @param {string[]} keys - 候选字段名。
 * @returns {string} 命中的值，没有则空串。
 */
function pickString(obj, keys) {
  if (typeof obj === 'string') return ''
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const got = pickString(v, keys)
      if (got) return got
    }
    return ''
  }
  if (obj && typeof obj === 'object') {
    for (const k of keys) {
      const v = obj[k]
      if (typeof v === 'string' && v) return v
    }
    for (const v of Object.values(obj)) {
      const got = pickString(v, keys)
      if (got) return got
    }
  }
  return ''
}

/**
 * 睡一会儿。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 定时结束。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 把 SSE 原文切成逐行异步迭代器。
 *
 * **只 yield `data:` 行**——SSE 帧由三部分组成：
 * ```
 * id: 0            ← 帧序号，不是数据
 * event: STREAM_CHUNK
 * data: {...}      ← 只有这行是数据
 * ```
 * 早先把这三种行全丢进解析器，导致 `id: 0` 被当成正文（回答变成
 * "id: 0id: 1id: 2…"），而真正的正文反倒漏了。
 * @param {string} text - 完整 SSE 文本。
 * @returns {AsyncGenerator<string>} 行流（只有 data 行）。
 */
export async function* lines(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    yield trimmed.slice(5).trim()
  }
}