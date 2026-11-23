/**
 * client/doubao-card.js 的离线测试：加载契约与 CJS 形态钉住。
 *
 * 宿主把本文件内容当脚本执行，文件必须自己调 window.__ModuleLoader__.load({id, factory})
 * 注册 factory。执行失败会让整个 web boot 只报 "1 entry did not activate"，无其它日志
 * —— 所以这里把形态钉死，回归时第一时间看到。
 *
 * @module test/client-bundle.test.js
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = readFileSync(path.join(ROOT, 'client', 'doubao-card.js'), 'utf8')

test('client bundle 是一次 ModuleLoader.load 注册（宿主契约）', () => {
  assert.ok(SRC.includes('window.__ModuleLoader__.load('), '必须自己调用 __ModuleLoader__.load')
  assert.ok(SRC.includes("id: 'dsh-doubao-signin'"), 'load 的 id 必须是 plugin-doubao')
  assert.ok(SRC.includes('factory: (require)'), '必须导出 factory(require)')
})

test('client bundle 无 ESM 语法（桌面壳 <script> 加载，CJS only）', () => {
  assert.ok(!/\bimport\s+[\w{*]/.test(SRC), '有 import 语句——ESM 会让 web boot 失败')
  assert.ok(!/\bexport\s+(default|const|function|class)\b/.test(SRC), '有顶层 export——CJS 文件不允许')
  assert.ok(SRC.includes('exports.apply'), '必须把 apply 挂到 exports')
})

test('factory 里 require react（baseline external）', () => {
  assert.ok(SRC.includes("require('react')"), 'React 应从宿主 baseline require')
})

test('卡片只读：没有写操作痕迹', () => {
  assert.ok(!/method:\s*['"]POST['"]/.test(SRC), '卡片不应发 POST')
  assert.ok(!/document\.cookie/.test(SRC), '卡片不应碰 cookie')
  assert.ok(SRC.includes('same-origin'), 'fetch 必须同源')
})

test('额度路由路径与 Host 侧 routes.js 一致', () => {
  const routes = readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8')
  const hostPath = /QUOTA_ROUTE_PATH\s*=\s*'([^']+)'/.exec(routes)?.[1]
  const clientPath = /QUOTA_PATH\s*=\s*'([^']+)'/.exec(SRC)?.[1]
  assert.ok(hostPath, 'Host 侧应声明路由路径')
  assert.equal(clientPath, hostPath, 'client 与 host 的路径必须一致')
})

test('带 rev 自检：用虚拟 DOM 跑一遍卡片逻辑', async () => {
  // 最小 React 替身：createElement 返回描述对象，useState/useEffect 桩
  const calls = []
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: fn => { calls.push(fn) },
  }
  // 在沙箱里执行 factory：提供 window 与 require
  const sandboxWindow = { __ModuleLoader__: { load: reg => { sandboxWindow.__registered = reg } } }
  const vm = await import('node:vm')
  const context = vm.createContext({ window: sandboxWindow, require: name => (name === 'react' ? ReactStub : undefined), exports: {}, console })
  vm.runInContext(SRC, context)
  const reg = sandboxWindow.__registered
  assert.ok(reg, 'load 应被调用并记录注册对象')
  assert.equal(reg.id, 'dsh-doubao-signin')

  // 执行 factory 拿 exports
  const exportsObj = {}
  reg.factory(name => (name === 'react' ? ReactStub : undefined))
  void exportsObj
  // factory 内部闭包直接写 exports——上面 require 只返回 stub，exports 由 vm context 的 exports 承载
  assert.equal(context.exports?.name, 'dsh-doubao-signin', 'factory 应设置 exports.name')

  // apply 在无 slots 时不炸
  const effects = []
  const ctx = {
    get: () => undefined,
    effect: fn => effects.push(fn),
  }
  context.exports.apply(ctx)
  assert.equal(effects.length, 0, '缺 slots 时应静默返回，不注册')
})
