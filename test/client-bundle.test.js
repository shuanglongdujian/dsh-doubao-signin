/**
 * client/doubao-card.js 的离线测试：加载契约与 CJS 形态钉住。
 *
 * 宿主把本文件内容当**浏览器 classic script**执行，文件必须自己调
 * `window.__ModuleLoader__.load({id, factory})` 注册 factory。
 *
 * 关键点（woc-jpg 的 0.2.5 BOM 事故 + 我们自己的 ReferenceError 都栽在这里）：
 * - 浏览器脚本作用域里**没有 CJS 的 `exports`**——factory 内必须自建 `module/exports`，
 *   否则 `exports.apply = apply` 抛 ReferenceError，materialize 失败，
 *   宿主只会报一行 "1 entry did not activate"。
 * - factory 必须 `return module.exports`。
 * - 组件必须接 props（宿主把 slot props 传进来）。
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

/** 最小 React 替身。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: fn => { void fn },
}

/**
 * 在沙箱里执行 bundle，返回注册对象。
 * @returns {{reg: object, module: object}} 注册信息与 factory 的 module。
 */
function runBundle() {
  const registered = {}
  const sandboxWindow = { __ModuleLoader__: { load: reg => { registered[reg.id] = reg } } }
  const context = vm.createContext({
    window: sandboxWindow,
    require: name => (name === 'react' ? ReactStub : undefined),
    console,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
  })
  vm.runInContext(SRC, context, { filename: 'doubao-card.js' })
  return { reg: registered['dsh-doubao-signin'], context }
}

test('client bundle 是一次 ModuleLoader.load 注册（宿主契约）', () => {
  assert.ok(SRC.includes('window.__ModuleLoader__.load('), '必须自己调用 __ModuleLoader__.load')
  assert.ok(SRC.includes("id: 'dsh-doubao-signin'"), 'load 的 id 必须是包名')
  assert.ok(SRC.includes('factory: require =>'), 'factory 形参必须是 require')
})

test('client bundle 自建 module/exports（浏览器脚本没有 CJS exports）', () => {
  assert.ok(SRC.includes('const module = { exports: {} }'), 'factory 内必须自建 module')
  assert.ok(SRC.includes('const exports = module.exports'), '必须把 exports 指向 module.exports')
  assert.ok(SRC.includes('return module.exports'), 'factory 必须 return module.exports')
})

test('client bundle 无 ESM 语法（classic script）', () => {
  assert.ok(!/^\s*import\s/m.test(SRC), '有顶层 import——浏览器 classic script 不支持')
  assert.ok(!/^\s*export\s/m.test(SRC), '有顶层 export——浏览器 classic script 不支持')
})

test('沙箱实跑：factory 注册成功且导出 apply', () => {
  const { reg } = runBundle()
  assert.ok(reg, 'load 应被调用并注册')
  assert.equal(reg.id, 'dsh-doubao-signin')
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  assert.ok(exported, 'factory 应返回 module.exports')
  assert.equal(typeof exported.apply, 'function', 'apply 应导出')
  assert.equal(exported.name, 'dsh-doubao-signin')
})

test('沙箱实跑：apply 注册 settings.section 卡片', () => {
  const { reg } = runBundle()
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  const registered = []
  const components = []
  const injected = []
  const ctx = {
    effect(fn) { try { fn() } catch { /* effect 失败不应中断 */ } },
    locale: { register: () => {}, bind: () => (k => DICT_FALLBACK[k]) },
    slots: {
      inject(name, cb) { injected.push(name); const d = cb(); return typeof d === 'function' ? d : () => {} },
      register(spec, comp) { registered.push(spec); components.push(comp); return () => {} },
    },
  }
  exported.apply(ctx)
  assert.ok(injected.includes('settings.section'), '应 inject settings.section')
  assert.equal(registered.length, 1, '应注册一个卡片')
  assert.equal(registered[0].id, 'dsh-doubao-signin')
  assert.equal(typeof registered[0].label, 'function')
  assert.equal(components.length, 1, '应带组件')
  assert.equal(typeof components[0], 'function')
})

test('卡片组件接受 props 并能渲染', () => {
  const { reg } = runBundle()
  const exported = reg.factory(name => (name === 'react' ? ReactStub : undefined))
  let component = null
  const ctx = {
    effect(fn) { try { fn() } catch { /* ignore */ } },
    locale: { register: () => {}, bind: () => (k => DICT_FALLBACK[k]) },
    slots: {
      inject(name, cb) { cb(); return () => {} },
      register(spec, comp) { component = comp; return () => {} },
    },
  }
  exported.apply(ctx)
  assert.ok(component, '应拿到组件')
  // 组件是 props => h(Page, props)：先得到 Page 元素，再渲染成 div
  const pageElement = component({ t: (k) => DICT_FALLBACK[k] })
  assert.ok(pageElement, '组件应返回元素')
  assert.equal(typeof pageElement.type, 'function', '外层元素应是页面组件')
  const el = pageElement.type(pageElement.props)
  assert.equal(el.type, 'div', '页面组件渲染出 div')
})

test('额度路由路径与 Host 侧 routes.js 一致', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8')
  const hostPath = /QUOTA_ROUTE_PATH\s*=\s*'([^']+)'/.exec(routes)?.[1]
  const clientPath = /QUOTA_PATH\s*=\s*'([^']+)'/.exec(SRC)?.[1]
  assert.ok(hostPath, 'Host 侧应声明路由路径')
  assert.equal(clientPath, hostPath, 'client 与 host 的路径必须一致')
})

test('卡片只读：没有写操作痕迹', () => {
  assert.ok(!/method:\s*['"]POST['"]/.test(SRC), '卡片不应发 POST')
  assert.ok(!/document\.cookie/.test(SRC), '卡片不应碰 cookie')
  assert.ok(SRC.includes('same-origin'), 'fetch 必须同源')
})

/** 测试用的文案兜底表。 */
const DICT_FALLBACK = {
  nav: '豆包', title: '豆包额度', loading: '读取中…',
  unreadable: '额度读不出来', unreadableHost: '客户端可能没运行。',
  loggedOut: '尚未登录。', refreshHint: '自动刷新', signinHint: '签到用工具',
  total: '剩余额度 {n}',
}
