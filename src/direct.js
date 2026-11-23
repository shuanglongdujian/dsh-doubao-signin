/**
 * 无签名直连聊天。
 *
 * 逆向结论（两款同类插件 2026-11 实测交叉验证）：
 *
 * 1. 账号健康时，`/chat/completion` **不验 a_bogus**——带着客户端自己的
 *    device_id/fp/web_id + 有效会话 cookie，纯 Node fetch 就能流式拿到回答。
 *    签名只在账号被风控标记后才成为硬要求。
 * 2. 风控比对的是「会话属于谁」vs「请求自称是谁」。cookie 来自客户端登录态
 *    （桌面身份），所以请求头/ query 也必须自称桌面客户端（client_platform=
 *    pc_client + 客户端版本），不能伪装成浏览器——错配正是触发 710022004 的
 *    典型原因。
 * 3. `fp` 是字面量 `verify_` + device_id，不是 cookie 里的 s_v_web_id。
 *
 * 直连失败（710022004）时调用方走已有的 CDP 签名桥降级，见 index.js。
 *
 * @module src/direct.js
 */
import { CHAT_PATH, DEFAULT_BOT_ID } from './protocol.js'

/** 聊天车道的 aid（connect-doubao 抓包值）。 */
export const CHAT_AID = '582478'

/** 必需的会话 cookie（缺任何一个都不能直连）。 */
export const REQUIRED_COOKIE_NAMES = [
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'sid_guard',
  'uid_tt',
  'ttwid',
  'odin_tt',
  'passport_csrf_token',
  's_v_web_id',
]

/** 核心 cookie：缺了就算未登录。 */
export const CORE_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']

/** 直连请求的桌面客户端 UA（与身份里的 chromiumVersion 对齐时最稳）。 */
const DIRECT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.35.12'

/**
 * 判断 cookie 头是否具备直连条件。
 * @param {string} cookieHeader - `k=v; k2=v2` 形式。
 * @returns {{ok: boolean, missing: string[], hasCore: boolean}} 评估结果。
 */
export function cookieReadiness(cookieHeader) {
  const have = new Set(
    String(cookieHeader ?? '')
      .split(';')
      .map(part => part.trim().split('=')[0]?.trim())
      .filter(Boolean),
  )
  const missing = REQUIRED_COOKIE_NAMES.filter(n => !have.has(n))
  const hasCore = CORE_COOKIE_NAMES.every(n => have.has(n))
  return { ok: hasCore && missing.length === 0, missing, hasCore }
}

/**
 * 构造直连的 query（woc-jpg 实测流式可用的完整形状）。
 * @param {object} identity - toIdentity 的产物。
 * @param {object} [env] - 环境变量（测试可注入）。
 * @returns {string} query string。
 */
export function buildDirectQuery(identity, env = process.env) {
  const params = new URLSearchParams({
    aid: CHAT_AID,
    channel: env.DOUBAO_CHANNEL ?? 'win',
    client_platform: 'pc_client',
    device_platform: 'web',
    doubao_device_platform: 'web',
    pc_version: identity.clientVersion ?? '2.35.12',
    runtime: 'web',
    runtime_version: '3.41.0',
    web_platform: 'web',
    language: 'zh',
    pkg_type: 'release_version',
    real_aid: CHAT_AID,
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    'use-olympus-account': '1',
    version_code: '20800',
    device_id: identity.deviceId,
    fp: identity.fp,
    web_id: identity.webId ?? identity.deviceId,
    web_tab_id: globalThis.crypto.randomUUID(),
    tz_name: env.DOUBAO_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Etc/GMT-8',
    chromium_version: identity.chromiumVersion ?? '147.0.7727.149',
    tea_uuid: identity.deviceId,
  })
  return params.toString()
}

/**
 * 构造直连请求头。
 * @param {string} cookieHeader - 完整 cookie。
 * @returns {object} headers。
 */
export function buildDirectHeaders(cookieHeader) {
  return {
    'content-type': 'application/json',
    'user-agent': DIRECT_UA,
    accept: 'text/event-stream, application/json;q=0.9, */*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/chat/',
    cookie: cookieHeader,
  }
}

/**
 * 直连聊天：发一次 POST，返回 SSE 原文。
 *
 * cookie 从哪来？优先用调用方注入的（测试），否则借 CDP 从客户端页面读
 * `document.cookie` —— 客户端在运行时这是唯一不会被锁的 cookie 来源
 * （Cookies SQLite 运行中独占锁，Local State 明文可读但没有会话）。
 *
 * 注意：直连**不带** a_bogus / msToken —— 健康账号不需要它们；
 * 被风控标记的账号带了也没用（签名绑定请求体），这种情况下调用方应降级签名桥。
 *
 * @param {object} opts - 参数。
 * @param {object} opts.body - buildChatBody 的请求体。
 * @param {object} opts.identity - toIdentity 的产物。
 * @param {() => Promise<string>} opts.getCookie - 取 cookie 头的回调。
 * @param {AbortSignal} [opts.signal] - 取消信号。
 * @param {object} [opts.env] - 环境变量（测试可注入）。
 * @param {typeof fetch} [opts.fetchImpl] - fetch 注入（测试用）。
 * @returns {Promise<{ok: true, sse: string}|{ok: false, kind: 'risk'|'auth'|'http', message: string, status?: number}>} 结果。
 */
export async function directChat(opts) {
  const { body, identity, getCookie, signal, env = process.env, fetchImpl = fetch } = opts
  const cookie = await getCookie()
  const ready = cookieReadiness(cookie)
  if (!ready.ok) {
    return {
      ok: false,
      kind: ready.hasCore ? 'risk' : 'auth',
      message: ready.hasCore
        ? `会话 cookie 缺辅助字段（${ready.missing.join(', ')}），直连风险高`
        : `会话 cookie 缺核心字段（${ready.missing.join(', ')}），客户端未登录或 cookie 未同步`,
    }
  }

  const query = buildDirectQuery(identity, env)
  const url = `https://www.doubao.com${CHAT_PATH}?${query}`

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: buildDirectHeaders(cookie),
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    return { ok: false, kind: 'http', message: `直连请求失败: ${error.message}` }
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    return { ok: false, kind: 'http', message: `直连 HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }
  if (text.includes('710022004')) {
    return { ok: false, kind: 'risk', message: '直连被风控拒绝（710022004，滑块验证）', status: res.status }
  }
  if (text.includes('710012001')) {
    return { ok: false, kind: 'auth', message: '直连被上游判为未登录（710012001）', status: res.status }
  }
  return { ok: true, sse: text }
}

/** 与 protocol.js 的 bot id 对齐导出（直连 body 构造复用主路径）。 */
export { DEFAULT_BOT_ID }
