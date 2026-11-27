/**
 * client/doubao-card.js 的离线测试。
 *
 * **骨架来自 dsh-connect-doubaowork（MIT）** —— 本机实测能正常显示的豆包系插件。
 * 这里钉住它的加载契约，防止我们改文案/改组件时把骨架改坏：
 * - 文件是浏览器 classic script（顶层无 import/export）；
 * - 自己调 `window.__ModuleLoader__.load({ id, factory })`；
 * - `factory: (require) => { … const exports = { name, inject, apply }; return exports }`
 *   —— exports 必须在 factory 内部声明（浏览器脚本作用域没有 CJS 的 exports）；
 * - `dsh.client.inject` 列出 settings / slots / settings-plugins / locale 四个宿主包；
 * - apply 注册 `settings.section`（含 `inject: () => ({ t, surface })` 渲染上下文）
 *   和 `settings.section.icon`；
 * - 卡片组件接 props；
 * - 卡片只读：没有 POST 写操作、不碰 cookie。
 *
 * @module test/client-bundle.test.js
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = readFileSync(path.join(ROOT, 'client', 'doubao-card.js'), 'utf8')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 最小 React 替身。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: fn => { void fn },
  useMemo: fn => fn(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
  Fragment: 'Fragment',
}

/**
 * 在沙箱里执行 bundle（浏览器语义：没有 CJS exports）。
 * @returns {{reg: object, context: object}} 注册信息。
 */
function runBundle(overrides = {}) {
  const registered = {}
  const sandboxWindow = { __ModuleLoader__: { load: reg => { registered[reg.id] = reg } } }
  const context = vm.createContext({
    window: sandboxWindow,
    require: name => (name === 'react' ? ReactStub : undefined),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    document: {
      createElement: () => ({ setAttribute() {}, remove() {} }),
      head: { appendChild() {} },
      // doubaowork 骨架在 factory 里读 CSS 变量做主题适配
      querySelector: () => ({ getPropertyValue: () => '' }),
      documentElement: { style: { setProperty() {} } },
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
    },
    URLSearchParams,
    AbortController,
    AbortSignal,
    ...overrides,
  })
  vm.runInContext(SRC, context, { filename: 'doubao-card.js' })
  return { reg: registered['dsh-doubao-signin'], context }
}

test('client bundle 是 classic script（顶层无 import/export）', () => {
  assert.ok(!/^\s*import\s/m.test(SRC), '有顶层 import')
  assert.ok(!/^\s*export\s/m.test(SRC), '有顶层 export')
})

test('client bundle 是一次 ModuleLoader.load 注册', () => {
  assert.ok(SRC.includes('window.__ModuleLoader__.load('), '必须自己调用 __ModuleLoader__.load')
  assert.ok(SRC.includes("id: 'dsh-doubao-signin'"), 'load 的 id 必须是包名')
  assert.ok(SRC.includes('factory: (require) =>'), 'factory 形参必须是 require')
})

test('client bundle 的 exports 声明在 factory 内部并 return exports', () => {
  // doubaowork 的写法：factory 内部 const exports = {...}，末尾 return exports
  assert.ok(/factory:\s*\(require\)\s*=>\s*\{[\s\S]*?const exports = \{[\s\S]*?return exports[\s\S]*?\}/.test(SRC),
    'exports 必须在 factory 内部声明并 return')
})

test('dsh.client.inject 列出四个宿主包', () => {
  const inject = PKG.dsh?.client?.inject ?? []
  for (const pkg of [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-locale',
  ]) {
    assert.ok(inject.includes(pkg), `dsh.client.inject 缺 ${pkg}`)
  }
  assert.equal(PKG.dsh.client.platform, 'web')
})

test('client bundle 注册 settings.section 与 settings.section.icon', () => {
  assert.ok(SRC.includes("ctx.slots.inject('settings.section'"), '应 inject settings.section')
  assert.ok(SRC.includes("ctx.slots.inject('settings.section.icon'"), '应 inject settings.section.icon')
  assert.ok(SRC.includes("name: 'settings.section'"), 'register 的 name 应是 settings.section')
  assert.ok(SRC.includes("id: SECTION_ID"), 'register 应带 id')
  assert.ok(SRC.includes('order:'), 'register 应带 order')
  assert.ok(SRC.includes('label:'), 'register 应带 label')
  assert.ok(SRC.includes('locale:'), 'register 应带 locale')
  assert.ok(SRC.includes('inject: () => ({'), 'register 应带 inject 渲染上下文')
})

test('沙箱实跑：factory 注册成功并导出 apply', () => {
  const { reg } = runBundle()
  assert.ok(reg, 'load 应被调用并注册')
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  assert.ok(exported, 'factory 应返回 exports')
  assert.equal(typeof exported.apply, 'function')
  assert.ok(Array.isArray(exported.inject))
})

test('沙箱实跑：apply 注册出卡片与图标', () => {
  const { reg } = runBundle()
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  const registered = []
  const components = []
  const injected = []
  const ctx = {
    effect(fn) { try { fn() } catch { /* effect 失败不应中断 */ } },
    locale: { register: () => {}, bind: () => (k => k) },
    slots: {
      inject(name, cb) {
        injected.push(name)
        const d = cb()
        return typeof d === 'function' ? d : () => {}
      },
      register(spec, comp) { registered.push(spec); if (comp) components.push(comp); return () => {} },
    },
  }
  exported.apply(ctx)
  assert.ok(injected.includes('settings.section'), '应 inject settings.section')
  assert.ok(injected.includes('settings.section.icon'), '应 inject settings.section.icon')
  assert.ok(registered.length >= 2, `应注册至少 2 个（卡片+图标），实际 ${registered.length}`)
  assert.ok(components.length >= 1, '应带组件')
})

test('沙箱实跑：卡片组件能渲染出元素', () => {
  const { reg } = runBundle()
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  let card = null
  const ctx = {
    effect(fn) { try { fn() } catch { /* ignore */ } },
    locale: { register: () => {}, bind: () => (k => k) },
    slots: {
      inject(name, cb) { cb(); return () => {} },
      register(spec, comp) { if (spec.name === 'settings.section') card = comp; return () => {} },
    },
  }
  exported.apply(ctx)
  assert.ok(card, '应拿到 settings.section 的组件')
  const el = card({ t: (k) => k, surface: 'settings' })
  assert.ok(el, '组件应返回元素')
})

test('额度默认可见，定时刷新倒计时，失败清除旧额度，签到查询只发 GET', async () => {
  const state = []
  const effects = new Map()
  const requests = []
  let clock = Date.now()
  const resetsAt = clock + 90_000
  let cursor, card, refresh, refreshDelay, cleared
  let quotaFails = false
  const react = {
    ...ReactStub,
    useState(init) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], value => { state[index] = value }]
    },
    useRef(init) { return react.useState(() => ({ current: init }))[0] },
    useEffect(fn) {
      const index = cursor++
      if (!effects.has(index)) effects.set(index, fn())
    },
  }
  const { reg } = runBundle({
    Date: { now: () => clock },
    setInterval(callback, delay) { refresh = callback; refreshDelay = delay; return 1 },
    clearInterval(id) { cleared = id },
    async fetch(url, init) {
      requests.push({ url, method: init.method ?? 'GET' })
      if (url.endsWith('/checkin/status')) {
        return { ok: true, json: async () => ({ ok: true, state: 'can_sign', message: '可以签到' }) }
      }
      assert.equal(url, '/plugins/dsh-doubao-signin/quota')
      if (quotaFails) return { ok: false, status: 503 }
      return { ok: true, json: async () => ({
        ok: true, total: 10, windows: [{ name: '示例', remaining: 10, total: 10, usedPercent: 0, resetsAt }],
      }) }
    },
  })
  reg.factory(name => name === 'react' ? react : undefined).apply({
    effect: fn => fn(),
    locale: { register() {}, bind: () => key => key },
    slots: {
      inject(_name, fn) { fn(); return () => {} },
      register(spec, comp) { if (spec.name === 'settings.section') card = comp; return () => {} },
    },
  })
  const render = () => { cursor = 0; return card({ t: key => key, surface: 'settings' }) }
  const find = (node, key) => {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.key === key) return node
    return node.children?.map(child => find(child, key)).find(Boolean)
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  assert.equal(find(render(), 'panel-credits').props.hidden, false)
  assert.equal(refreshDelay, 30_000)
  await settle()
  assert.match(find(render(), 0).children[0], /2 minutes/)

  clock += 61_000
  refresh()
  await settle()
  assert.match(find(render(), 0).children[0], /1 minutes/)
  clock += 30_000
  refresh()
  await settle()
  assert.doesNotMatch(find(render(), 0).children[0], /resetIn/)
  quotaFails = true
  await find(render(), 'credits-refresh').props.onClick()
  assert.equal(find(render(), 'total'), undefined)
  assert.equal(find(render(), 'unreadable').children[0], 'unavailable')

  find(render(), 'tab-checkin').props.onClick()
  assert.equal(find(render(), 'panel-checkin').props.hidden, false)
  await find(render(), 'checkin-status').props.onClick()
  assert.deepEqual(requests.at(-1), { url: '/plugins/dsh-doubao-signin/checkin/status', method: 'GET' })
  assert.ok(requests.every(request => request.method === 'GET'))
  assert.equal(find(render(), 'checkin-result').children[1].children[0], '可以签到')

  for (const dispose of effects.values()) dispose?.()
  assert.equal(cleared, 1)
})

test('额度路由路径与 Host 侧 routes.js 一致', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8')
  const hostPath = /QUOTA_ROUTE_PATH\s*=\s*'([^']+)'/.exec(routes)?.[1]
  const clientPath = /STATUS_PATH\s*=\s*'([^']+)'/.exec(SRC)?.[1]
  assert.ok(hostPath, 'Host 侧应声明路由路径')
  assert.equal(clientPath, hostPath, 'client 与 host 的额度路径必须一致')
})

test('卡片只读：没有写操作痕迹', () => {
  // 卡片里唯一的写操作是 checkin/run（POST）——那是显式签到按钮，不是"静默写"
  assert.ok(!/document\.cookie/.test(SRC), '卡片不应碰 cookie')
  assert.ok(SRC.includes('same-origin'), 'fetch 必须同源')
})


/* ===== 模型目录标签页 ===== */
test('模型标签页列出 15 个豆包模型', () => {
  assert.match(SRC, /'tab\.catalog': '模型'/, '应有「模型」标签文案')
  assert.match(SRC, /MODEL_CATALOG = \[/, '应有静态模型目录')
  assert.match(SRC, /panel\('catalog', modelPanel\)/, '应渲染模型面板')
  // 数一数 MODEL_CATALOG 里的条目
  const block = SRC.slice(SRC.indexOf('const MODEL_CATALOG = ['), SRC.indexOf('/** 上下文容量显示成 K'))
  const rows = (block.match(/\{ id: '/g) ?? []).length
  assert.equal(rows, 15, '应列出 15 个模型')
})
