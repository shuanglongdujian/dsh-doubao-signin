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
assert.equal(registered.size, 4, '应该注册四个工具')
for (const n of ['doubao_chat', 'doubao_checkin', 'doubao_status', 'doubao_quota']) {
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

// checkin 缺客户端时给结构化错误
const checkin = registered.get('doubao_checkin')
const ck = await checkin.execute({ dryRun: true }, { signal: new AbortController().signal })
assert.equal(ck.ok, false)
assert.equal(ck.state, 'no_client')
console.log(`\ncheckin 实跑状态: [${ck.state}] ${ck.message}`)

// chat 缺客户端时抛清晰错误
const chat = registered.get('doubao_chat')
await assert.rejects(() => chat.execute({ prompt: 'hi' }, { signal: new AbortController().signal }), /客户端/)

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
  assert.equal(t.registered.size, 4)
}

console.log('\n✅ 真 cordis Context 挂载通过：4 个工具、schema 合规、降级路径正常、两种 logger 形态兼容')
void DSH_ROOT