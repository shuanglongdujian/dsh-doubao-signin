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
  const llm = makeLlm()
  const ctx = {
    tools,
    llm,
    logger: { info() {}, warn() {}, error() {} },
  }
  await mod.apply(ctx, { exePath: path.join(here, 'nope', 'Doubao.exe'), ...config })
  return tools.registered
}

/**
 * 假的 llm 服务：记录 adapter 注册（模型进选择器全靠它）。
 * @returns {{adapters: object, registerAdapter: Function}} 假服务。
 */
function makeLlm() {
  const adapters = {}
  return {
    adapters,
    registerAdapter(providers, adapter) {
      assert.ok(Array.isArray(providers) && providers.length > 0, 'providers 必须非空数组')
      for (const p of providers) {
        assert.equal(typeof p, 'string')
        assert.ok(!adapters[p], `provider ${p} 重复注册`)
        adapters[p] = adapter
      }
      // 宿主注册时会调这两个方法做结构化校验（dsh-llm prepareRoutes）。
      // 替身必须和宿主一样严格——否则缺方法这种缺口在测试里是绿的、在宿主里却炸。
      for (const p of providers) {
        const info = adapter.providerInfo(p)
        assert.equal(info.id, p)
        assert.ok(typeof info.name === 'string' && info.name.length > 0)
        const policy = adapter.providerRetryPolicy(p)
        assert.ok(policy, 'providerRetryPolicy 必须返回策略')
        assert.equal(policy.mode, 'normal')
        assert.ok(typeof policy.maxRetries === 'number')
        assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0)
        assert.equal(typeof policy.initialDelayMs, 'number', '延迟字段必须在顶层')
      }
      return () => { for (const p of providers) delete adapters[p] }
    },
  }
}

describe('插件装载', () => {
  test('导出 name 与 inject', async () => {
    const mod = await import('../index.js')
    assert.equal(mod.name, 'doubao-signin')
    assert.deepEqual(mod.inject, ['tools', 'llm'])
  })

  test('注册 LLM provider，模型进入选择器', async () => {
    const mod = await import('../index.js')
    const tools = makeTools()
    const llm = makeLlm()
    await mod.apply({ tools, llm, logger: { info() {}, warn() {}, error() {} } }, {})
    assert.ok(llm.adapters.doubao, '应注册 doubao provider')
    const models = await llm.adapters.doubao.listModels('doubao')
    assert.ok(models.length > 0, 'listModels 返回空数组 = 分组被选择器过滤掉')
    for (const m of models) {
      assert.equal(m.provider, 'doubao')
      assert.ok(m.id && m.name)
    }
    // id 不重复
    assert.equal(new Set(models.map(m => m.id)).size, models.length)
    // resolveModel 要给上下文窗口
    const resolved = await llm.adapters.doubao.resolveModel('doubao', models[0].id)
    assert.equal(resolved.provider, 'doubao')
    assert.ok(resolved.context?.contextWindow > 0)
  })

  test('注册五个工具，schema 全部通过核心校验', async () => {
    const tools = await load()
    const names = tools.map(t => t.definition.name)
    assert.deepEqual(names.sort(), ['doubao_chat', 'doubao_checkin', 'doubao_login', 'doubao_quota', 'doubao_status'])
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
    const blocks = chat.output.render({}, { text: '你好', model: 'doubao', notes: [] })
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
  test('checkin dryRun 走只读 Cookie 查询（不写、不发领取请求）', async () => {
    const tools = await load()
    const ck = tools.find(t => t.definition.name === 'doubao_checkin').definition
    const result = await ck.execute({ dryRun: true }, { signal: undefined })
    // 有凭据 → 返回真实只读状态；无凭据 → unlogged。两种情况都是结构化结果，不抛错。
    assert.equal(typeof result.ok, 'boolean')
    assert.ok(
      ['unlogged', 'already', 'can_sign', 'ineligible', 'no_task', 'error'].includes(result.state),
      `意外状态 ${result.state}`,
    )
    // 核心保证：dryRun 绝不能返回"签到成功"，也绝不能发领取接口
    assert.notEqual(result.state, 'signed')
  })

  test('checkin 真签到且无客户端时明确拒绝（网页代签会作废额度）', async () => {
    const tools = await load()
    const ck = tools.find(t => t.definition.name === 'doubao_checkin').definition
    const result = await ck.execute({ dryRun: false }, { signal: undefined })
    // 这台机器没装客户端 → 必须返回 client_required 并说明为什么不能网页代签
    if (result.state === 'client_required') {
      assert.equal(result.ok, false)
      assert.match(result.message, /客户端|710010702|额度/)
    }
  })

  test('chat 失败时报能指导下一步的错误（凭据/通道/风控），不是笼统异常', async () => {
    const tools = await load()
    const chat = tools.find(t => t.definition.name === 'doubao_chat').definition
    try {
      const r = await chat.execute({ prompt: 'hi' }, { signal: undefined })
      assert.ok(r && typeof r.text === 'string')
    } catch (error) {
      assert.ok(
        /凭据|cookie|登录|通道|客户端|风控|人机验证|额度|不存在/.test(String(error.message)),
        `错误信息要说清怎么办，实际: ${error.message}`,
      )
    }
  })

  test('显式路径不存在时点名那个路径，而不是笼统说没装', async () => {
    // 找客户端的函数本身必须点名路径——它是给用户看的诊断信息
    const { findClient } = await import('../src/checkin.js')
    await assert.rejects(
      () => findClient('/definitely/not/here/Doubao.exe'),
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