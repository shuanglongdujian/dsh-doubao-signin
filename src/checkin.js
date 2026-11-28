/**
 * 豆包每日签到：CDP 点 UI，签名交给客户端自己算。
 *
 * 为什么不直接打签到接口：签到接口的风控比聊天接口严得多，一次异常调用会把
 * `msToken` 打进冷却，聊天跟着一起 401。让客户端自己发请求、我们只做"电子手"，
 * 就不背这个锅。
 *
 * 状态判定是纯 DOM 语义的（`data-reward-code` 卡片里的按钮还在不在），不截图、
 * 不比坐标 —— 截图会随缩放和主题漂移。
 *
 * @module src/checkin.js
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { CHECKIN_PAGE, DAILY_REWARD_CODE } from './protocol.js'

export { CHECKIN_PAGE, DAILY_REWARD_CODE }

const execFileAsync = promisify(execFile)

/** 默认 CDP 端口。 */
export const DEFAULT_PORT = 9222

/**
 * 把页面探针结果映射成状态。
 * 纯函数，方便单测：不碰浏览器、不碰网络。
 * @param {{hasCard?: boolean, canSign?: boolean, rewarded?: boolean, loginWall?: boolean}} probe - 页面探针。
 * @returns {{state: string, ok: boolean, message: string}} 状态判定。
 */
export function decideState(probe) {
  if (probe?.hasCard) {
    if (probe.rewarded) return { state: 'already', ok: true, message: '今日已签到' }
    if (probe.canSign) return { state: 'not_signed', ok: true, message: '未签到，存在可点击的签到按钮' }
    return { state: 'unknown', ok: false, message: '找到了签到卡片，暂时无法确认今日的签到状态' }
  }
  if (probe?.loginWall) return { state: 'unlogged', ok: false, message: '页面出现登录墙，先在客户端里登录豆包' }
  return {
    state: 'no_card',
    ok: false,
    message: `没找到 ${DAILY_REWARD_CODE} 卡片：活动换期/下线，或页面结构变了，需要更新选择器`,
  }
}

/**
 * 页面探针脚本。只读，不改页面。
 * @returns {string} 可直接送进 Runtime.evaluate 的表达式。
 */
export function probeExpression() {
  return `(() => {
    const cards = [...document.querySelectorAll('[data-reward-code]')];
    const daily = cards.find(c => c.getAttribute('data-reward-code') === ${JSON.stringify(DAILY_REWARD_CODE)});
    const btns = daily ? [...daily.querySelectorAll('button, [role="button"]')] : [];
    const clickable = btns.find(b => /签到/.test(b.innerText || '') && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const rewarded = daily?.querySelector('[class^="rewarded-"], [class*=" rewarded-"], .rewarded')
      || btns.some(b => /^(?:今日)?已签到$|^已领取$/.test((b.innerText || '').trim()));
    const loginWall = !!document.querySelector('[class*="login"], [class*="qrcode"], [class*="scan"]');
    return {
      hasCard: !!daily,
      cardCount: cards.length,
      buttonLabels: btns.map(b => (b.innerText || '').trim()),
      canSign: !!clickable,
      rewarded: !!rewarded,
      loginWall,
      url: location.href
    };
  })()`
}

/**
 * 点击脚本。用完整指针事件序列，因为普通 click 常被 React 侧过滤掉。
 * @returns {string} 可直接送进 Runtime.evaluate 的表达式。
 */
export function clickExpression() {
  return `(() => {
    const cards = [...document.querySelectorAll('[data-reward-code]')];
    const daily = cards.find(c => c.getAttribute('data-reward-code') === ${JSON.stringify(DAILY_REWARD_CODE)});
    if (!daily) return { clicked: false, reason: 'no_card' };
    const btn = [...daily.querySelectorAll('button, [role="button"]')]
      .find(b => /签到/.test(b.innerText || '') && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!btn) return { clicked: false, reason: 'no_button' };
    const r = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
    btn.dispatchEvent(new MouseEvent('mouseup', opts));
    btn.dispatchEvent(new MouseEvent('click', opts));
    return { clicked: true, label: (btn.innerText || '').trim() };
  })()`
}

/**
 * 发现豆包客户端可执行文件。
 *
 * 三级发现：运行中的进程 → 常见安装目录扫描 → Electron 目录校验。
 * @param {string} [explicit] - 显式指定的路径，跳过发现。
 * @returns {Promise<string>} Doubao.exe（或平台对应可执行文件）的绝对路径。
 */
export async function findClient(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`指定的豆包客户端不存在: ${explicit}。检查 exePath 配置，或清空它改用自动发现。`)
    }
    return explicit
  }

  const candidates = []
  const platform = process.platform

  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-Process Doubao -ErrorAction SilentlyContinue | Select-Object -First 1).Path',
      ], { timeout: 15_000 })
      if (stdout.trim()) candidates.push(stdout.trim())
    } catch {
      // 没装 / 没运行都算正常，继续扫目录
    }
    const bases = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Doubao', 'Application'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Doubao'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Doubao'),
      // 非标准安装：很多人把第三方客户端装在 D 盘自建目录（如 D:\AI工具\doubao\app）。
      // 扫各盘符根下 2 层内的 doubao 目录，深度受限，不会全盘遍历。
      ...driveRoots()
        .flatMap(drive => [
          path.join(drive, 'Doubao'),
          path.join(drive, 'doubao'),
          path.join(drive, 'AI工具', 'doubao'),
          path.join(drive, '软件', 'doubao'),
        ]),
    ].filter(Boolean)
    for (const base of bases) {
      if (!fs.existsSync(base)) continue
      candidates.push(...depthLimitedGlob(base, /^Doubao\.exe$/i, 4))
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Doubao.app/Contents/MacOS/Doubao',
      path.join(os.homedir(), 'Applications/Doubao.app/Contents/MacOS/Doubao'),
    )
  } else {
    candidates.push('/opt/Doubao/doubao', '/usr/bin/doubao')
  }

  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue
    // Electron 应用目录一定带这两个资源之一
    const dir = path.dirname(c)
    if (fs.existsSync(path.join(dir, 'resources.pak')) || fs.existsSync(path.join(dir, 'icudtl.dat'))) return c
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(parent, 'icudtl.dat'))) return c
  }

  throw new Error('没找到豆包客户端。用 checkin 的 exePath 配置项指定可执行文件路径，或先安装并登录客户端。')
}

/**
 * 列出本机固定盘符根目录（C:\ D:\ …）。
 * @returns {string[]} 盘符根路径。
 */
function driveRoots() {
  if (process.platform !== 'win32') return []
  const out = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      if (fs.existsSync(root)) out.push(root)
    } catch { /* 不存在的盘符跳过 */ }
  }
  return out
}

/**
 * 有深度上限的目录扫描。
 * @param {string} root - 起始目录。
 * @param {RegExp} pattern - 文件名匹配。
 * @param {number} maxDepth - 最大深度。
 * @returns {string[]} 匹配到的文件绝对路径。
 */
function depthLimitedGlob(root, pattern, maxDepth) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile() && pattern.test(e.name)) out.push(full)
      else if (e.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/**
 * 极简 CDP 客户端，只用 Node 内置 WebSocket。
 */
export class CdpClient {
  /** @param {string} wsUrl - webSocketDebuggerUrl。 */
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
  }

  /** 建立连接。 @returns {Promise<void>} 连接就绪。 */
  async connect() {
    const WS = globalThis.WebSocket
    if (!WS) throw new Error('当前 Node 没有全局 WebSocket，需要 Node 22+')
    await new Promise((resolve, reject) => {
      const ws = new WS(this.wsUrl)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时: ${this.wsUrl}`)), 15_000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`CDP 连接失败: ${this.wsUrl}`))
      }, { once: true })
      ws.addEventListener('message', event => {
        let msg
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          return
        }
        const fut = this.pending.get(msg.id)
        if (!fut) return
        this.pending.delete(msg.id)
        if (msg.error) fut.reject(new Error(`CDP ${msg.error.message ?? 'error'}`))
        else fut.resolve(msg.result ?? {})
      })
    })
  }

  /** 关闭连接。 @returns {void} */
  close() {
    try {
      this.ws?.close()
    } catch {
      // 关一个已经断的 socket 不值得报错
    }
    for (const fut of this.pending.values()) fut.reject(new Error('CDP 已关闭'))
    this.pending.clear()
  }

  /**
   * 发一条 CDP 命令。
   * @param {string} method - 方法名。
   * @param {object} [params] - 参数。
   * @param {number} [timeoutMs] - 超时。
   * @returns {Promise<object>} 结果。
   */
  call(method, params = {}, timeoutMs = 20_000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * 在页面里求值。
   * @param {string} expression - 表达式。
   * @param {number} [timeoutMs] - 超时。
   * @returns {Promise<unknown>} 返回值。
   */
  async evaluate(expression, timeoutMs = 20_000) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error(`页面脚本异常: ${r.exceptionDetails.text ?? 'unknown'}`)
    }
    return r.result?.value
  }

  /**
   * 在页面里求值并等待 Promise 完成（用于页面 fetch 中继）。
   * @param {string} expression - 返回 Promise 的表达式。
   * @param {number} [timeoutMs] - 超时（聊天可达数分钟）。
   * @returns {Promise<unknown>} Promise 解析后的值。
   */
  async evaluateAsync(expression, timeoutMs = 180_000) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error(`页面脚本异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown'}`)
    }
    return r.result?.value
  }
}

/**
 * 列出 CDP 目标。
 * @param {number} port - 调试端口。
 * @returns {Promise<Array<object>>} 目标列表。
 */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`CDP 目标列表 HTTP ${res.status}`)
  return res.json()
}

/**
 * 等到 CDP 端口可用。
 * @param {number} port - 端口。
 * @param {number} timeoutMs - 总超时。
 * @returns {Promise<void>} 端口可用时返回。
 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await listTargets(port)
      return
    } catch {
      await sleep(1000)
    }
  }
  throw new Error(`CDP 端口 ${port} 在 ${Math.round(timeoutMs / 1000)}s 内没起来（客户端可能没带 --remote-debugging-port 启动）`)
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
 * 确保调试端口在监听；需要时重启客户端。
 * @param {string} exe - 客户端路径。
 * @param {number} port - 端口。
 * @param {boolean} relaunch - 是否允许重启客户端。
 * @param {(msg: string) => void} [log] - 可选日志回调。
 * @returns {Promise<{reused: boolean, restarted: boolean}>} 端口来源。
 */
export async function ensurePort(exe, port, relaunch, log) {
  try {
    await listTargets(port)
    return { reused: true, restarted: false }
  } catch {
    if (!relaunch) {
      throw new Error(`CDP 端口 ${port} 没开，且未允许重启客户端。请手动带 --remote-debugging-port=${port} 启动，或打开 relaunchClient。`)
    }
  }

  const { spawn } = await import('node:child_process')
  log?.(`重启客户端以开启调试端口 ${port}`)
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/IM', path.basename(exe), '/F'], { timeout: 20_000 }).catch(() => {})
  } else {
    await execFileAsync('pkill', ['-f', path.basename(exe)], { timeout: 20_000 }).catch(() => {})
  }
  await sleep(2000)
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  await waitForCdp(port, 40_000)
  return { reused: false, restarted: true }
}

/**
 * 执行一次签到。
 * @param {object} opts - 运行参数。
 * @param {number} [opts.port] - CDP 端口。
 * @param {string} [opts.exePath] - 客户端路径。
 * @param {boolean} [opts.dryRun] - 只判定状态不点击。
 * @param {boolean} [opts.relaunchClient] - 允许重启客户端。
 * @param {number} [opts.timeoutMs] - 等待页面就绪的总时长。
 * @returns {Promise<object>} 结构化结果。
 */
export async function runCheckin(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT
  const timeoutMs = opts.timeoutMs ?? 25_000
  const dryRun = opts.dryRun === true

  let exe
  try {
    exe = await findClient(opts.exePath)
  } catch (error) {
    return { ok: false, state: 'no_client', message: error.message, before: null, after: null }
  }

  let porteInfo
  try {
    porteInfo = await ensurePort(exe, port, opts.relaunchClient === true)
  } catch (error) {
    return { ok: false, state: 'error', message: error.message, before: null, after: null, client: exe }
  }

  const targets = await listTargets(port)
  let target = targets.find(t => t.type === 'page' && (t.url ?? '').includes('agent-explore'))
  const client = new CdpClient()
  try {
    if (!target) {
      const page = targets.find(t => t.type === 'page')
      if (!page) return { ok: false, state: 'error', message: '客户端没有可用的页面目标', before: null, after: null, client: exe }
      await client.connect()
      await client.call('Page.enable')
      await client.call('Page.navigate', { url: CHECKIN_PAGE })
      await sleep(4000)
      const again = await listTargets(port)
      const nav = again.find(t => t.type === 'page' && (t.url ?? '').includes('agent-explore'))
      if (nav && nav.webSocketDebuggerUrl !== page.webSocketDebuggerUrl) {
        client.close()
        const fresh = new CdpClient(nav.webSocketDebuggerUrl)
        await fresh.connect()
        return await drive(fresh, { dryRun, timeoutMs, exe, port })
      }
      return await drive(client, { dryRun, timeoutMs, exe, port })
    }

    const conn = new CdpClient(target.webSocketDebuggerUrl)
    await conn.connect()
    try {
      return await drive(conn, { dryRun, timeoutMs, exe, port })
    } finally {
      conn.close()
    }
  } finally {
    client.close()
  }
}

/**
 * 在已连接的页面上走完判定 → 点击 → 复核。
 * @param {CdpClient} cdp - 已连接的客户端。
 * @param {object} ctx - { dryRun, timeoutMs, exe, port }。
 * @returns {Promise<object>} 结构化结果。
 */
async function drive(cdp, ctx) {
  const deadline = Date.now() + ctx.timeoutMs
  let probe = {}
  while (Date.now() < deadline) {
    probe = (await cdp.evaluate(probeExpression())) ?? {}
    if (probe.loginWall || (probe.hasCard && (probe.rewarded || probe.canSign))) break
    await sleep(1000)
  }

  const verdict = decideState(probe)
  const base = { client: ctx.exe, port: ctx.port, before: probe }

  if (!verdict.ok) return { ...verdict, ...base, after: null }
  if (verdict.state === 'already') return { ...verdict, ...base, after: probe }
  if (ctx.dryRun) {
    return { ok: true, state: 'dry_run', message: 'dry-run：定位到可点的签到按钮，未点击', ...base, after: probe }
  }

  const clicked = (await cdp.evaluate(clickExpression())) ?? {}
  let after = probe
  const settleDeadline = Date.now() + 12_000
  while (clicked.clicked && Date.now() < settleDeadline) {
    await sleep(1500)
    after = (await cdp.evaluate(probeExpression())) ?? after
    if (decideState(after).state === 'already') break
  }

  if (clicked.clicked && decideState(after).state === 'already') {
    return { ok: true, state: 'signed', message: '签到成功', ...base, after, clicked }
  }
  return {
    ok: false,
    state: 'error',
    message: '客户端未显示签到成功，暂时无法确认此次签到结果',
    ...base,
    after,
    clicked,
  }
}
