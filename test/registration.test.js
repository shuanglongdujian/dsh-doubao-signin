/**
 * 装载测试：用真 `ctx.tools.register` 的校验规则跑一遍三个工具声明。
 *
 * 不连 DSH、不连网络、不碰客户端 —— 只验证：
 * - 参数/输出 schema 能过 `assertSupportedJsonSchema`
 * - register 不抛
 * - render 对典型值给出非空内容
 * - execute 在缺客户端时给结构化错误而不是崩溃
 *
 * 跑：node --test test/registration.test.js
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DSH_ROOT = 'D:\\AI工具\\deepseek harness\\harness\\resources\\app\\dsh'

// 核心包只在 DSH 安装目录里，装载测试从那里借校验器；插件自身不依赖它们。
const schemaModuleUrl = pathToFileURL(
  path.join(DSH_ROOT, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'),
).href
const { assertSupportedJsonSchema } = await import(schemaModuleUrl)

/**
 * 最小的 tools 服务替身：调用真实 schema 校验器，记录注册结果。
 * @returns {{register: Function, registered: Array<object>}} 假服务与注册表。
 */
function makeTools() {
  const registered = []
  return {
    registered,
    register(definition, options = {}) {
      assert.equal(typeof definition.name, 'string')
      assert.ok(definition.name.length > 0, '工具必须有名字')
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${definition.name} 的描述太短`)
      assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`)

      const output = definition.output
      assert.ok(output && typeof output === 'object', `${definition.name} 缺 output`)
      assert.equal(typeof output.render, 'function', `${definition.name} 缺 output.render`)
      assertSupportedJsonSchema(output.schema)

      const parameters = definition.parameters
      assert.ok(parameters && typeof parameters === 'object', `${definition.name} 缺 parameters`)
      assert.equal(parameters.type, 'object', `${definition.name} 的参数根必须是 object`)
      assertSupportedJsonSchema(parameters)

      registered.push({ definition, options })
      return () => {}
    },
  }
}

/**
 * 装载插件并拿到注册表。
 * @param {object} [config] - 覆盖默认配置。
 * @returns {Promise<Array<object>>} 注册的工具。
 */
async function load(config = {}) {
  const mod = await import('../index.js')
  assert.equal(typeof mod.apply, 'function', '插件必须导出 apply')
  const tools = makeTools()
  const ctx = {
    tools,
    logger: { info() {}, warn() {}, error() {} },
  }
  await mod.apply(ctx, { exePath: path.join(here, 'nope', 'Doubao.exe'), ...config })
  return tools.registered
}

describe('插件装载', () => {
  test('导出 name 与 inject', async () => {
    const mod = await import('../index.js')
    assert.equal(mod.name, 'plugin-doubao')
    assert.deepEqual(mod.inject, ['tools'])
  })

  test('注册三个工具，schema 全部通过核心校验', async () => {
    const tools = await load()
    const names = tools.map(t => t.definition.name)
    assert.deepEqual(names.sort(), ['doubao_chat', 'doubao_checkin', 'doubao_status'])
  })

  test('工具名不重复', async () => {
    const tools = await load()
    const names = tools.map(t => t.definition.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('没有 timeoutMs 之外的裸字段泄漏给模型', async () => {
    const tools = await load()
    for (const { definition } of tools) {
      assert.equal(definition.parameters.type, 'object')
      for (const key of ['name', 'description', 'parameters', 'output', 'timeoutMs', 'execute']) {
        assert.ok(key in definition, `${definition.name} 缺 ${key}`)
      }
    }
  })

  test('核心 loader 源码里没有引用 @deepseek-ai 包', () => {
    const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
    assert.doesNotMatch(src, /from\s+['"]@deepseek-ai\//, 'index.js 不能 import 核心包')
    for (const f of ['protocol.js', 'checkin.js', 'signer.js']) {
      const sub = fs.readFileSync(path.join(here, '..', 'src', f), 'utf8')
      assert.doesNotMatch(sub, /from\s+['"]@deepseek-ai\//, `src/${f} 不能 import 核心包`)
    }
  })
})

describe('render 投影', () => {
  test('chat 正常文本', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    const blocks = chat.output.render({}, { text: '你好', model: 'doubao-pro-chat', notes: [] })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text, '你好')
  })

  test('chat 空回复不渲染成空白', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    const blocks = chat.output.render({}, { text: '', model: 'm', notes: ['协议可能改版'] })
    assert.match(blocks[0].text, /上游没有返回文本/)
    assert.match(blocks.at(-1).text, /协议可能改版/)
  })

  test('chat 带工具调用时标出名字', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    const blocks = chat.output.render({}, {
      text: 'ok',
      model: 'm',
      notes: [],
      toolCalls: [{ function: { name: 'get_weather' } }],
    })
    assert.ok(blocks.some(b => /get_weather/.test(b.text)))
  })

  test('checkin 成功与失败都是非空文本', async () => {
    const tools = await load()
    const ck = tools.find(t => t.definition.name === 'doubao_checkin').definition
    const ok = ck.output.render({}, { ok: true, state: 'signed', message: '签到成功' })
    assert.match(ok[0].text, /✓/)
    const bad = ck.output.render({}, { ok: false, state: 'no_client', message: '没找到客户端' })
    assert.match(bad[0].text, /✗/)
    assert.match(bad[0].text, /没找到客户端/)
  })

  test('status 直接吐 summary', async () => {
    const tools = await load()
    const st = tools.find(t => t.definition.name === 'doubao_status').definition
    const blocks = st.output.render({}, { clientFound: false, summary: '客户端: 未找到' })
    assert.equal(blocks[0].text, '客户端: 未找到')
  })
})

describe('execute 的降级行为', () => {
  test('checkin 在客户端不存在时返回结构化错误', async () => {
    const tools = await load()
    const ck = tools.find(t => t.definition.name === 'doubao_checkin').definition
    const result = await ck.execute({ dryRun: true }, { signal: undefined })
    assert.equal(result.ok, false)
    assert.equal(result.state, 'no_client')
    assert.match(result.message, /客户端/)
  })

  test('chat 在客户端不存在时抛清晰错误', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    await assert.rejects(
      () => chat.execute({ prompt: 'hi' }, { signal: undefined }),
      /客户端/,
    )
  })

  test('显式路径不存在时点名那个路径，而不是笼统说没装', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    await assert.rejects(
      () => chat.execute({ prompt: 'hi' }, { signal: undefined }),
      /指定的豆包客户端不存在/,
    )
  })

  test('chat 对未知模型提前报错，不去碰网络', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    await assert.rejects(
      () => chat.execute({ prompt: 'hi', model: 'gpt-9' }, { signal: undefined }),
      /未知模型/,
    )
  })

  test('status 在缺客户端时仍给出摘要', async () => {
    const tools = await load()
    const st = tools.find(t => t.definition.name === 'doubao_status').definition
    const result = await st.execute({}, { signal: undefined })
    assert.equal(result.clientFound, false)
    assert.match(result.summary, /未找到/)
  })
})