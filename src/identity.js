/**
 * 从已安装的豆包客户端读取设备身份。
 *
 * 逆向结论（来源：dsh-doubao-signin@woc-jpg 与 dsh-connect-doubao@Wahwayhale 的实测）：
 *
 * - 聊天端点的风控按「设备指纹」聚合。带着账号没见过的 device_id 发请求，
 *   无论会话多有效都吃 710022004；全新造的 id 必被拒。唯一可用的 id 是客户端
 *   自己注册的那份，没有 API 能拿到，只能读客户端的数据文件。
 * - `Local State`（Chromium 用户目录旁的明文 JSON）带 `aha.device.device_id`，
 *   永不锁定、客户端运行中也可读 —— 这是主来源。
 * - leveldb（Local Storage）带 `client_device_info`（deviceId + 客户端版本 +
 *   Chromium 版本）和 `__tea_cache_tokens_582478`（web_id），是补充来源；
 *   leveldb 块有前缀压缩，客户端压缩后按 key 扫描会落空，所以只作兜底。
 * - `fp` 不是 cookie 里的 s_v_web_id —— 桌面客户端发的是字面量 `verify_` + device_id。
 *
 * 本模块只读文件，不启动、不停止客户端。
 *
 * @module src/identity.js
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir } from 'node:os'

/**
 * 客户端用户数据目录候选（按平台）。
 * @param {object} [env] - 环境变量（测试可注入）。
 * @param {string} [platform] - 平台（测试可注入）。
 * @returns {string[]} 候选目录。
 */
export function candidateUserDataDirs(env = process.env, platform = process.platform) {
  const home = homedir()
  if (platform === 'darwin') {
    const support = posix.join(home, 'Library', 'Application Support')
    return [
      posix.join(support, 'Doubao', 'User Data'),
      posix.join(support, 'doubao', 'User Data'),
      posix.join(support, 'Doubao'),
      posix.join(support, 'doubao'),
    ]
  }
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME ?? posix.join(home, '.config')
    return [
      posix.join(config, 'doubao'),
      posix.join(config, 'Doubao'),
      posix.join(home, '.doubao'),
      posix.join(config, 'doubao', 'User Data'),
    ]
  }
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return [
    join(local, 'Doubao', 'User Data'),
    join(roaming, 'Doubao', 'User Data'),
    join(local, 'Doubao'),
    join(roaming, 'Doubao'),
  ]
}

/**
 * 读 `Local State` 里的设备 id。
 * @param {string} userDataDir - 用户数据目录。
 * @returns {{deviceId: string, source: string}|undefined} 命中时返回。
 */
export function readLocalStateIdentity(userDataDir) {
  const path = join(userDataDir, 'Local State')
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  const deviceId = parsed?.aha?.device?.device_id
  if (typeof deviceId !== 'string' || !deviceId) return undefined
  return { deviceId, source: path }
}

/**
 * 扫一个 leveldb 目录找补充身份字段。
 * @param {string} dir - leveldb 目录。
 * @returns {object} 零散命中的字段。
 */
export function scanLocalStorage(dir) {
  const info = {}
  if (!existsSync(dir)) return info
  for (const { name } of leveldbFiles(dir)) {
    let buf
    try {
      buf = readFileSync(join(dir, name))
    } catch {
      continue // 客户端压缩中或被锁；换下一个文件
    }
    if (!info.deviceId) {
      const dev = valueAfter(buf, 'client_device_info')
      if (dev && typeof dev === 'object' && dev.deviceId) {
        info.deviceId = String(dev.deviceId)
        if (dev.chromiumVersion) info.chromiumVersion = String(dev.chromiumVersion)
        if (dev.clientVersion) info.clientVersion = String(dev.clientVersion)
        info.source = join(dir, name)
      }
    }
    if (!info.webId) {
      const tea = valueAfter(buf, '__tea_cache_tokens_582478')
      if (tea && typeof tea === 'object') {
        const web = tea.web_id ?? tea.webId
        if (web) info.webId = String(web)
      }
    }
    if (info.deviceId && info.webId) break
  }
  return info
}

/**
 * 探测所有已知目录，返回第一份命中的身份。
 * @param {object} [env] - 环境变量。
 * @param {string} [platform] - 平台。
 * @returns {{found: boolean, info: object, dir?: string, tried: string[]}} 结果与尝试过的路径。
 */
export function findClientIdentity(env = process.env, platform = process.platform) {
  const tried = []
  for (const root of candidateUserDataDirs(env, platform)) {
    const fromState = readLocalStateIdentity(root)
    if (fromState) {
      const extra = scanLocalStorage(join(root, 'Default', 'Local Storage', 'leveldb'))
      const info = { ...extra, ...fromState }
      if (!info.chromiumVersion) info.chromiumVersion = extra.chromiumVersion
      if (!info.clientVersion) info.clientVersion = extra.clientVersion
      return { found: true, info, dir: root, tried }
    }
    tried.push(join(root, 'Local State'))
  }
  for (const dir of localStorageDirs(env, ['Default'], platform)) {
    const info = scanLocalStorage(dir)
    if (info.deviceId) return { found: true, info, dir, tried }
    tried.push(dir)
  }
  return { found: false, info: {}, tried }
}

/**
 * 归一成请求要用的身份三元组。
 * @param {object} info - findClientIdentity 的 info。
 * @returns {{deviceId: string, fp: string, webId: string, chromiumVersion: string, clientVersion: string}|undefined} 缺 deviceId 返回 undefined。
 */
export function toIdentity(info) {
  const deviceId = info?.deviceId ?? info?.deviceIdCustom
  if (!deviceId) return undefined
  return {
    deviceId,
    fp: `verify_${deviceId}`,
    webId: info?.webId ?? deviceId,
    chromiumVersion: info?.chromiumVersion ?? '147.0.7727.149',
    clientVersion: info?.clientVersion ?? '2.35.12',
  }
}

/* ===== 内部 ===== */

/**
 * leveldb 文件列表：.log 优先于 .ldb，其余按 mtime 新到旧。
 * @param {string} dir - leveldb 目录。
 * @returns {Array<{name: string, stat: object}>} 排好序的文件。
 */
function leveldbFiles(dir) {
  let names
  try {
    names = readdirSync(dir).filter(f => /\.(ldb|log)$/i.test(f))
  } catch {
    return []
  }
  const withStat = []
  for (const name of names) {
    try {
      withStat.push({ name, stat: statSync(join(dir, name)) })
    } catch {
      // 压缩期间文件可能消失
    }
  }
  withStat.sort((a, b) => {
    const aLog = a.name.endsWith('.log')
    const bLog = b.name.endsWith('.log')
    if (aLog !== bLog) return aLog ? -1 : 1
    return b.stat.mtimeMs - a.stat.mtimeMs
  })
  return withStat
}

/**
 * 从缓冲区里 key 之后的值：JSON 对象、带引号字符串或裸字符串。
 * @param {Buffer} buf - leveldb 块。
 * @param {string} key - latin1 关键字。
 * @returns {unknown} 解析出的值；没找到返回 undefined。
 */
function valueAfter(buf, key) {
  const at = buf.indexOf(key, 0, 'latin1')
  if (at < 0) return undefined
  const from = at + key.length
  // leveldb 在 payload 前垫了类型字节和 varint 长度，目标字符在几个字节之后
  const window = Math.min(buf.length, from + 16)
  for (let i = from; i < window; i += 1) {
    if (buf[i] === 0x7b) return jsonAt(buf, i) // '{'
    if (buf[i] === 0x22) { // '"'
      const end = buf.indexOf(0x22, i + 1)
      if (end < 0) return undefined
      return buf.toString('utf8', i + 1, end)
    }
  }
  // 有些值（s_v_web_id）是不带引号的裸字符串
  let i = from
  while (i < buf.length && (buf[i] < 0x20 || buf[i] === 0x7f)) i += 1
  let end = i
  while (end < buf.length && buf[end] >= 0x20 && end - i < 128) end += 1
  if (end <= i) return undefined
  const bare = buf.toString('utf8', i, end)
  if (/^[}\]),;]/.test(bare)) return undefined // 邻居记录的尾巴，不是本 key 的值
  return bare
}

/**
 * 从 `at` 开始读第一个完整 JSON 对象（尊重嵌套与字符串转义）。
 * @param {Buffer} buf - 缓冲区。
 * @param {number} at - 起始偏移。
 * @returns {object|undefined} 解析失败返回 undefined。
 */
function jsonAt(buf, at) {
  const open = buf.indexOf(0x7b, at) // '{'
  if (open < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  const limit = Math.min(buf.length, open + 200_000)
  for (let i = open; i < limit; i += 1) {
    const c = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) depth += 1
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(buf.toString('utf8', open, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * 列出 leveldb 目录候选。
 * @param {object} env - 环境变量。
 * @param {string[]} profiles - profile 名。
 * @param {string} [platform] - 平台。
 * @returns {string[]} 目录列表。
 */
function localStorageDirs(env, profiles, platform = process.platform) {
  const out = []
  for (const root of candidateUserDataDirs(env, platform)) {
    for (const profile of profiles) out.push(join(root, profile, 'Local Storage', 'leveldb'))
  }
  return out
}
