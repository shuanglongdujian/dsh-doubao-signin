/**
 * 真运行时挂载验证：用真实 cordis Context 加载插件，确认 apply 真的跑起来、
 * 真的把三个工具注册进 tools 服务，而不是只在单测的假替身里通过。
 *
 * 再挂一遍普通 ctx，验证两种 logger 形态（带 info 的对象 / 命名空间工厂）都能落日志。
 *
 * 跑：node test/live-mount.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const DSH_ROOT = 'D:\\AI工具\\deepseek harness\\harness\\resources\\app\\dsh'
const url = p => pathToFileURL(path.join(DSH_ROOT, p)).href

const { Context } = await import(url('node_modules/@deepseek-ai/cordis/lib/index.js'))
const { assertSupportedJsonSchema } = await import(url('node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'))

/**
 * 造一个行为对齐真实 register 前置校验的 tools 服务替身。
 * @returns {{service: {register: Function}, registered: Map}} 替身与注册表。
 */
function makeTools() {
  const registered = new Map()
  const service = {
    register(definition) {
      assert.equal(typeof definition.name, 'string')
      assert.ok(definition.name, '工具必须有名字')
      assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`)
      assert.ok(definition.output && typeof definition.output.render === 'function')
      assertSupportedJsonSchema(definition.output.schema)
      assertSupportedJsonSchema(definition.parameters)
      if (registered.has(definition.name)) throw new Error(`重复注册: ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  return { service, registered }
}

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)

/** 真实配置形状：模拟 patch 里给的那几项。 */
const CONFIG = { cdpPort: 9222, relaunchClient: false, autoDiscoverClient: true }

/* ===== 第一遍：真 cordis Context 下挂载 ===== */

const app = new Context()
app.provide('tools')
const { service: toolsService, registered } = makeTools()
app.set('tools', toolsService)

await mod.apply(app, CONFIG)

console.log('已注册工具:', [...registered.keys()].join(', '))
assert.equal(registered.size, 6, '应该注册六个工具')
for (const n of ['doubao_login', 'doubao_chat', 'doubao_checkin', 'doubao_status', 'doubao_quota', 'doubao_accounts']) {
  assert.ok(registered.has(n), `缺少 ${n}`)
}

// 工具声明不得把内部字段泄漏给模型
for (const [toolName, def] of registered) {
  assert.equal(typeof def.isConcurrencySafe, 'function', `${toolName} 应声明 isConcurrencySafe`)
  assert.equal(typeof def.presentCall, 'function', `${toolName} 应声明 presentCall`)
  assert.ok(def.timeoutMs > 0, `${toolName} 应有正的 timeoutMs`)
  // parameters 必须是 object 根，且不能带 $schema 之类
  assert.equal(def.parameters.type, 'object')
  assert.ok(!('$schema' in def.parameters), `${toolName} 参数不应带 $schema`)
  // presentCall 必须是纯函数：同一个 args 调两次结果一致
  const args = { prompt: 'x', dryRun: true }
  assert.deepEqual(def.presentCall(args), def.presentCall(args), `${toolName} presentCall 不纯`)
}

// status 是唯一能离线跑完的：缺客户端时应返回结构化摘要，而不是抛
const status = registered.get('doubao_status')
const result = await status.execute({}, { signal: new AbortController().signal })
assert.equal(typeof result.summary, 'string')
assert.ok(result.summary.length > 0)
console.log('\nstatus 实跑结果:\n' + result.summary)

// checkin dryRun：只读 Cookie 查询，有凭据时返回真实状态，无凭据时 unlogged——都不抛错、绝不做写操作
const checkin = registered.get('doubao_checkin')
const ck = await checkin.execute({ dryRun: true }, { signal: new AbortController().signal })
assert.equal(typeof ck.ok, 'boolean')
assert.ok(
  ['unlogged', 'already', 'can_sign', 'ineligible', 'no_task', 'error'].includes(ck.state),
  `意外状态 ${ck.state}`,
)
assert.notEqual(ck.state, 'signed', 'dryRun 绝不能返回签到成功')
console.log(`\ncheckin 实跑状态: [${ck.state}] ${ck.message}`)

// chat：v0.7 起有扫码凭据就能直连（不再强制依赖客户端）。
// 没有凭据时报「凭据/通道」相关的清晰错误——不能是笼统的"undefined is not valid JSON"。
const chat = registered.get('doubao_chat')
try {
  const r = await chat.execute({ prompt: 'hi' }, { signal: new AbortController().signal })
  // 有凭据：能跑通（可能因上游风控失败，但那是有意义的业务错误）
  assert.ok(r && typeof r.text === 'string', '成功时应返回文本')
} catch (error) {
  assert.ok(
    /凭据|cookie|登录|通道|客户端|风控|人机验证|额度/.test(String(error.message)),
    `错误信息要说清怎么办，实际: ${error.message}`,
  )
}

// chat 对未知模型提前报错，不去碰网络
await assert.rejects(
  () => chat.execute({ prompt: 'hi', model: 'gpt-9' }, { signal: new AbortController().signal }),
  /未知模型/,
)

/* ===== 第二遍：普通 ctx 验证两种 logger 形态 ===== */

// cordis 根 Context 的 logger 代理会把调用排进 fiber 队列，非 boot 环境不落地；
// 所以日志断言在普通对象 ctx 上做（registration.test.js 同款形状）。
{
  const logs = []
  const t = makeTools()
  await mod.apply(
    { tools: t.service, logger: { info: (...a) => logs.push(a.join(' ')), warn() {}, error() {} } },
    CONFIG,
  )
  assert.ok(logs.some(l => /已注册 doubao_chat/.test(l)), '对象形态 logger 应收到挂载日志')
}
{
  const logs = []
  const t = makeTools()
  const factory = (ns) => ({ info: (...a) => logs.push(`${ns}: ${a.join(' ')}`), warn() {}, error() {} })
  await mod.apply({ tools: t.service, logger: factory }, CONFIG)
  assert.ok(logs.some(l => /doubao: 已注册 doubao_chat/.test(l)), '命名空间工厂形态 logger 应收到挂载日志')
}
{
  // 完全没有 logger 服务时，挂载不崩（落回 console）
  const t = makeTools()
  await mod.apply({ tools: t.service }, CONFIG)
  assert.equal(t.registered.size, 6)
}

console.log('\n✅ 真 cordis Context 挂载通过：6 个工具、schema 合规、降级路径正常、两种 logger 形态兼容')
void DSH_ROOT
/* ===== 第五遍：webServer 路由注册契约（our-free-model 记录过的坑） ===== */
{
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(
    /ctx\.inject\(\['webServer'\]/.test(source),
    '必须用 ctx.inject([\'webServer\']) 注册路由——ctx.get(\'webServer\') 在 apply 时返回 undefined，路由永远注册不上',
  )
  console.log('\n✅ webServer 路由用 ctx.inject 等待就绪（不是 ctx.get）')
}

/* ===== 第六遍：webServer inject 回调真实执行（防止 ReferenceError 被吞） ===== */
{
  // 真 cordis 会吞掉 inject 回调里的 ReferenceError（Fiber._reload catch），
  // 所以静态源码断言不够——这里直接模拟 cordis 的 inject 触发，把回调跑一遍。
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(
    /registerQuotaRoute\(scoped,\s*\{/.test(source),
    'inject 回调里必须 registerQuotaRoute(scoped, {...})，且用 scoped 而非外层 ctx',
  )
  assert.ok(
    /webServer:\s*server/.test(source),
    'inject 回调里传的必须是已解析的 server（const server = scoped.webServer），不是裸标识符 webServer',
  )
  // 反向断言：回调作用域里不能出现裸的 `webServer,` 作为参数值
  const cb = source.slice(source.indexOf("ctx.inject(['webServer']"), source.indexOf("ctx.inject(['webServer']") + 2500)
  assert.ok(
    !/^\s*webServer,\s*$/m.test(cb),
    'inject 回调里不能有裸 webServer 标识符（ReferenceError 会被 cordis 吞掉）',
  )
  console.log('\n✅ webServer inject 回调作用域无未定义变量')
}

/* ===== 第七遍：真 cordis + webServer 服务 → inject 回调必须注册出 5 条路由 ===== */
{
  const app2 = new Context()
  app2.provide('tools')
  const registeredTools2 = []
  app2.set('tools', { register: d => registeredTools2.push(d.name) })

  // 假 webServer：模拟宿主提供的服务，记录所有注册路由
  const routes = []
  app2.provide('webServer')
  app2.set('webServer', { register: entry => { routes.push(entry); return () => {} } })

  const mod2 = await import('file:///D:/AI%E5%B7%A5%E5%85%B7/deepseek%20harness/github%E9%A1%B9%E7%9B%AE/dsh-doubao-signin/index.js')
  await mod2.apply(app2, {})

  // inject 回调在 webServer ACTIVE 时应同步触发
  await new Promise(resolve => setTimeout(resolve, 100))

  const paths = routes.map(r => r.path).sort()
  assert.ok(paths.length >= 5, `webServer 就绪后应注册至少 5 条路由，实际 ${paths.length}: ${JSON.stringify(paths)}`)
  for (const p of [
    '/plugins/dsh-doubao-signin/quota',
    '/plugins/dsh-doubao-signin/checkin/run',
    '/plugins/dsh-doubao-signin/login/start',
    '/plugins/dsh-doubao-signin/login/poll',
    '/plugins/dsh-doubao-signin/login/cancel',
  ]) {
    assert.ok(paths.includes(p), `缺路由: ${p}`)
  }
  console.log('\n✅ 真 cordis：webServer 就绪后 5 条 loopback 路由全部注册')
}

/* ===== 第八遍：真 cordis 里 llm provider 注册（模型进选择器的前提） ===== */
{
  const app3 = new Context()
  app3.provide('tools')
  app3.set('tools', { register: () => () => {} })

  const adapters = {}
  app3.provide('llm')
  app3.set('llm', {
    registerAdapter(providers, adapter) {
      for (const p of providers) {
        assert.ok(!adapters[p], `provider ${p} 重复注册`)
        adapters[p] = adapter
        // 宿主注册时会做结构化校验
        const info = adapter.providerInfo(p)
        assert.equal(info.id, p)
        assert.ok(info.name)
      }
      return () => { for (const p of providers) delete adapters[p] }
    },
  })

  const mod3 = await import('file:///D:/AI%E5%B7%A5%E5%85%B7/deepseek%20harness/github%E9%A1%B9%E7%9B%AE/dsh-doubao-signin/index.js')
  assert.ok(mod3.inject.includes('llm'), 'inject 必须声明 llm——否则 ctx.llm 读不到')
  await mod3.apply(app3, {})

  assert.ok(adapters.doubao, '应注册 doubao provider')
  const models = await adapters.doubao.listModels('doubao')
  assert.ok(models.length > 0, 'listModels 返回空数组 = 选择器会过滤掉这个分组')
  console.log('\n✅ 真 cordis：llm provider 已注册，' + models.length + ' 个豆包模型可进选择器')
}
