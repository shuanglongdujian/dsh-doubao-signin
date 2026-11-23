/**
 * Host 侧 loopback 路由：给 client 卡片与任何本机调用者读额度。
 *
 * 安全模型（对齐 dsh-connect-workbuddy 的做法）：
 * - 只注册 exact 路径，GET-only；
 * - Host 头必须是监听器自己（防 DNS rebinding），带 Origin 时必须是本机回环
 *   （浏览器 fetch 会带，curl 不带——不带也放行，与插件自身调用兼容）；
 * - 响应按显式允许清单构造，不透传上游任何字段；`Cache-Control: no-store`。
 *
 * @module src/routes.js
 */

/** 额度路由路径（client/doubao-card.js 顶部常量与此对齐）。 */
export const QUOTA_ROUTE_PATH = '/plugins/dsh-plugin-doubao/quota'

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
 * 注册额度路由。
 * @param {object} ctx - cordis 上下文（需要 webServer 服务）。
 * @param {object} deps - 依赖。
 * @param {() => Promise<{ok: boolean, total?: number, windows?: Array, summary?: string}>} deps.readQuota - 读额度（复用工具的执行体）。
 * @param {{info?: Function, error?: Function}} [deps.log] - 日志。
 * @returns {void}
 */
export function registerQuotaRoute(ctx, { readQuota, log = {}, webServer }) {
  ctx.effect(() => {
    const server = webServer ?? ctx.webServer
    if (!server || typeof server.register !== 'function') return
    const disposers = []
    const route = entry => disposers.push(server.register(entry))

    route({
      kind: 'exact',
      path: QUOTA_ROUTE_PATH,
      handler: async (req, res) => {
        // —— 闸 1：Host 必须是监听器自己 ——
        if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'host-not-trusted' }))
          return
        }
        // —— 闸 2：带 Origin 时必须本机回环 ——
        if (!originIsLoopback(req.headers.origin, req.socket?.localAddress)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'origin-not-trusted' }))
          return
        }
        // —— 闸 3：GET-only（读状态不进历史/日志/截图）——
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        try {
          const data = await readQuota()
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          // —— 显式允许清单，不透传上游字段 ——
          res.end(JSON.stringify({
            ok: data.ok === true,
            ...(data.ok === true ? { total: data.total ?? 0, windows: data.windows ?? [] } : {}),
            ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
          }))
        } catch (error) {
          log.error?.(`quota route 失败: ${error.message}`)
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'quota-read-failed' }))
        }
      },
    })

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 热重载竞态下可能已卸载 */ }
      }
    }
  }, 'plugin-doubao: quota route')
}
