/**
 * Host 侧 loopback 路由：给 client 卡片读额度、跑签到、扫码登录。
 *
 * 路由清单（client/doubao-card.js 顶部常量与此对齐）：
 * - GET  /plugins/dsh-doubao-signin/quota          额度看板数据
 * - GET  /plugins/dsh-doubao-signin/checkin/status 当日签到状态
 * - POST /plugins/dsh-doubao-signin/checkin/run   执行一次每日签到
 * - POST /plugins/dsh-doubao-signin/login/start   拉起浏览器扫码登录
 * - GET  /plugins/dsh-doubao-signin/login/poll    查扫码进度
 * - POST /plugins/dsh-doubao-signin/login/cancel 取消扫码
 *
 * 安全模型（对齐 dsh-connect-workbuddy / dsh-connect-doubaowork 的做法）：
 * - 只注册 exact 路径；
 * - Host 头必须是监听器自己（防 DNS rebinding），带 Origin 时必须是本机回环；
 * - 响应按显式允许清单构造，不透传上游任何字段；`Cache-Control: no-store`。
 *
 * @module src/routes.js
 */

/** 额度路由路径。 */
export const QUOTA_ROUTE_PATH = '/plugins/dsh-doubao-signin/quota'

/** 签到执行路由。 */
export const CHECKIN_ROUTE_PATH = '/plugins/dsh-doubao-signin/checkin/run'
export const CHECKIN_STATUS_ROUTE_PATH = '/plugins/dsh-doubao-signin/checkin/status'

/** 扫码登录启动路由。 */
export const LOGIN_START_ROUTE_PATH = '/plugins/dsh-doubao-signin/login/start'

/** 扫码登录轮询路由。 */
export const LOGIN_POLL_ROUTE_PATH = '/plugins/dsh-doubao-signin/login/poll'

/** 扫码登录取消路由。 */
export const LOGIN_CANCEL_ROUTE_PATH = '/plugins/dsh-doubao-signin/login/cancel'

/**
 * Host 头是否指向本机监听器。
 * @param {string|undefined} host - 请求 Host 头。
 * @param {string|undefined} localAddress - socket 本地地址。
 * @returns {boolean} 可信。
 */
export function hostMatchesListener(host, localAddress) {
  if (typeof host !== 'string' || host.trim() === '') return false
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  const name = (bare ?? '').trim().toLowerCase()
  if (name === 'localhost' || name === '::1' || name === '127.0.0.1') return true
  if (name === '0.0.0.0' || name === '::') return false
  return typeof localAddress === 'string' && name === localAddress.trim().toLowerCase()
}

/**
 * Origin 是否本机回环（缺失视为放行——同源 fetch 在部分内核不带）。
 * @param {string|undefined} origin - 请求 Origin 头。
 * @param {string|undefined} localAddress - socket 本地地址。
 * @returns {boolean} 可信。
 */
export function originIsLoopback(origin, localAddress) {
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    return hostMatchesListener(new URL(origin).host, localAddress)
  } catch {
    return false
  }
}

/**
 * 判断请求是否通过 loopback 闸门。
 * @param {object} req - 请求。
 * @param {object} res - 响应。
 * @param {object} res - 响应。
 * @returns {boolean} 通过则 true。
 */
function passLoopback(req, res) {
  if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'host-not-trusted' }))
    return false
  }
  if (!originIsLoopback(req.headers.origin, req.socket?.localAddress)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'origin-not-trusted' }))
    return false
  }
  return true
}

/**
 * 注册全部 loopback 路由。
 * @param {object} ctx - cordis 上下文（需要 webServer 服务）。
 * @param {object} deps - 依赖。
 * @param {() => Promise<object>} deps.readQuota - 读额度。
 * @param {() => Promise<object>} [deps.readCheckinStatus] - 只读签到状态。
 * @param {(opts: object) => Promise<object>} [deps.runCheckin] - 跑签到。
 * @param {() => Promise<object>} [deps.startLogin] - 拉起扫码登录。
 * @param {() => object} [deps.pollLogin] - 查扫码进度。
 * @param {() => void} [deps.cancelLogin] - 取消扫码。
 * @param {{info?: Function, error?: Function}} [deps.log] - 日志。
 * @returns {void}
 */
export function registerQuotaRoute(ctx, {
  readQuota,
  readCheckinStatus,
  runCheckin,
  startLogin,
  pollLogin,
  cancelLogin,
  webServer,
  log = {},
}) {
  ctx.effect(() => {
    const server = webServer ?? ctx.webServer
    if (!server || typeof server.register !== 'function') return
    const disposers = []
    const route = entry => disposers.push(server.register(entry))

    /**
     * 发 JSON 响应。
     * @param {object} res - 响应。
     * @param {number} code - 状态码。
     * @param {object} body - body。
     * @returns {void}
     */
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    // —— 额度（GET，只读）——
    route({
      kind: 'exact',
      path: QUOTA_ROUTE_PATH,
      handler: async (req, res) => {
        if (!passLoopback(req, res)) return
        if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
        try {
          const data = await readQuota()
          json(res, 200, {
            ok: data.ok === true,
            ...(data.ok === true ? { total: data.total, windows: data.windows ?? [] } : {}),
            ...(['pool', 'saved', 'client'].includes(data.source) ? { source: data.source } : {}),
            ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
          })
        } catch (error) {
          log.error?.(`quota route 失败: ${error.message}`)
          json(res, 500, { ok: false, error: 'quota-read-failed' })
        }
      },
    })

    if (typeof readCheckinStatus === 'function') {
      route({
        kind: 'exact',
        path: CHECKIN_STATUS_ROUTE_PATH,
        handler: async (req, res) => {
          if (!passLoopback(req, res)) return
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const result = await readCheckinStatus()
            json(res, 200, { ok: result.ok === true, state: result.state, message: result.message })
          } catch (error) {
            log.error?.(`checkin status route 失败: ${error.message}`)
            json(res, 500, { ok: false, state: 'error', message: '暂时无法查询签到状态' })
          }
        },
      })
    }

    // —— 签到（POST，会动客户端）——
    if (typeof runCheckin === 'function') {
      route({
        kind: 'exact',
        path: CHECKIN_ROUTE_PATH,
        handler: async (req, res) => {
          if (!passLoopback(req, res)) return
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const result = await runCheckin({})
            json(res, 200, {
              ok: result.ok === true,
              state: result.state ?? 'unknown',
              message: result.message ?? '',
            })
          } catch (error) {
            log.error?.(`checkin route 失败: ${error.message}`)
            json(res, 500, { ok: false, state: 'error', message: 'checkin failed' })
          }
        },
      })
    }

    // —— 扫码登录：start / poll / cancel ——
    if (typeof startLogin === 'function') {
      route({
        kind: 'exact',
        path: LOGIN_START_ROUTE_PATH,
        handler: async (req, res) => {
          if (!passLoopback(req, res)) return
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            const result = await startLogin()
            json(res, 200, result)
          } catch (error) {
            log.error?.(`login start 失败: ${error.message}`)
            json(res, 500, { ok: false, phase: 'error', message: 'login start failed' })
          }
        },
      })
    }
    if (typeof pollLogin === 'function') {
      route({
        kind: 'exact',
        path: LOGIN_POLL_ROUTE_PATH,
        handler: async (req, res) => {
          if (!passLoopback(req, res)) return
          if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            json(res, 200, pollLogin())
          } catch (error) {
            json(res, 500, { phase: 'error', message: 'poll failed' })
          }
        },
      })
    }
    if (typeof cancelLogin === 'function') {
      route({
        kind: 'exact',
        path: LOGIN_CANCEL_ROUTE_PATH,
        handler: async (req, res) => {
          if (!passLoopback(req, res)) return
          if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
          try {
            cancelLogin()
            json(res, 200, { ok: true, phase: 'idle' })
          } catch (error) {
            json(res, 500, { ok: false, phase: 'error', message: 'cancel failed' })
          }
        },
      })
    }

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 热重载竞态下可能已卸载 */ }
      }
    }
  }, 'plugin-doubao: loopback routes')
}
