/**
 * 真 dsh-llm 注册测试：直接用宿主的 ctx.llm.registerAdapter 验证 adapter 被接受。
 *
 * 为什么必须有这个测试：假 llm 替身比宿主宽松（只调 providerInfo），
 * 于是「缺 providerRetryPolicy」这种缺口在假测试里是绿的、在真实宿主里却是炸的。
 * 这里用真 dsh-llm 的 LlmService 注册一次，让缺口当场暴露。
 *
 * @module test/llm-registration.test.js
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const DSH_ROOT = 'D:\\AI工具\\deepseek harness\\harness\\resources\\app\\dsh'
const url = p => pathToFileURL(path.join(DSH_ROOT, p)).href

const { Context } = await import(url('node_modules/@deepseek-ai/cordis/lib/index.js'))
const { createDoubaoAdapter } = await import('../src/doubao-adapter.js')

/**
 * 构造使用模拟上游的适配器。
 * @param {Function} [postChat] 模拟聊天响应。
 * @returns {object} adapter。
 */
function makeAdapter(postChat = async () => '') {
  return createDoubaoAdapter({
    config: { defaultModel: 'doubao', directFirst: false },
    getIdentity: () => ({ found: false }),
    cookieSource: async () => ({ header: '', source: 'none', ready: false }),
    ensureSigner: async () => ({ postChat, cookieHeader: async () => '' }),
    log: () => {},
  })
}

test('adapter 提供宿主注册、上下文估算和模型调用所需的方法', () => {
  const a = makeAdapter()
  // dsh-llm 的 prepareRoutes 会调用这两个（src/index.ts）
  assert.equal(typeof a.providerInfo, 'function', '缺 providerInfo')
  assert.equal(typeof a.providerRetryPolicy, 'function', '缺 providerRetryPolicy——注册会抛 TypeError')
  assert.equal(typeof a.imageRequestPricing, 'function', '缺 imageRequestPricing')
  assert.equal(typeof a.imageRequestTarget, 'function', '缺 imageRequestTarget')
  assert.equal(typeof a.listModels, 'function', '缺 listModels')
  assert.equal(typeof a.resolveModel, 'function', '缺 resolveModel')
  assert.equal(typeof a.prepareCall, 'function', '缺 prepareCall')
  assert.equal(typeof a.stream, 'function', '缺 stream')
})

test('providerRetryPolicy 返回已解析策略（字段摊平在顶层）', () => {
  const p = makeAdapter().providerRetryPolicy('doubao')
  assert.ok(p, '必须返回策略，不能是 undefined')
  assert.equal(p.mode, 'normal')
  assert.equal(typeof p.maxRetries, 'number')
  assert.ok(Array.isArray(p.retryableCodes) && p.retryableCodes.length > 0, 'retryableCodes 不能为空')
  // 关键：延迟字段必须在顶层，嵌套进 backoff 会让调度器读到 NaN
  assert.equal(typeof p.initialDelayMs, 'number', 'initialDelayMs 必须在顶层')
  assert.equal(typeof p.maxDelayMs, 'number', 'maxDelayMs 必须在顶层')
  assert.equal(typeof p.jitterRatio, 'number', 'jitterRatio 必须在顶层')
  assert.ok(!('backoff' in p), '已解析策略不应再有 backoff 嵌套层')
})

test('providerRetryPolicy 不含 RATE_LIMIT（重试会加深豆包风控）', () => {
  const p = makeAdapter().providerRetryPolicy('doubao')
  assert.ok(!p.retryableCodes.includes('RATE_LIMIT'), 'RATE_LIMIT 必须在重试集之外')
})

test('providerInfo 保留 provider id 且 name 非空', () => {
  const info = makeAdapter().providerInfo('doubao')
  assert.equal(info.id, 'doubao')
  assert.ok(typeof info.name === 'string' && info.name.length > 0)
})

test('listModels 返回的每一项都带 provider（宿主按它分组）', async () => {
  const models = await makeAdapter().listModels('doubao')
  assert.ok(models.length > 0, '空数组会被 buildModelCatalog 整个过滤')
  for (const m of models) {
    assert.equal(m.provider, 'doubao')
    assert.ok(typeof m.id === 'string' && m.id.length > 0)
    assert.ok(typeof m.name === 'string' && m.name.length > 0)
  }
  assert.equal(new Set(models.map(m => m.id)).size, models.length, 'id 不能重复')
})

/* ===== 真 dsh-llm LlmRuntime：验证 adapter 被真实注册流程接受 ===== */
test('真 LlmRuntime 能注册豆包 adapter（宿主真实路径）', async () => {
  const { LlmRuntime } = await import(url('node_modules/@deepseek-ai/dsh-llm/lib/index.js'))
  const app = new Context()
  // LlmRuntime 构造时已通过 TypertRemoteService 注册 'llm' 服务，不要重复 provide
  const runtime = new LlmRuntime(app)

  const adapter = makeAdapter()
  const release = runtime.registerAdapter(['doubao'], adapter)
  assert.equal(typeof release, 'function', 'registerAdapter 应返回 disposer')

  // 宿主注册后会发 llm/adapters-updated；这里直接查 registry 的结果
  const providers = runtime.listProviders()
  const ids = providers.map(p => (typeof p === 'string' ? p : p.id))
  assert.ok(ids.includes('doubao'), `listProviders 应含 doubao，实际 ${JSON.stringify(providers)}`)
  const info = providers.find(p => (typeof p === 'string' ? p : p.id) === 'doubao')
  assert.equal(info.name, '豆包 Doubao', 'provider 显示名应透传')

  // listModels / resolveModel 走 Typert 远端协议，本地 runtime 不直接暴露；
  // 它们的形状由上面的 adapter 级测试覆盖（宿主侧同样按这些字段读）。
  const models = await adapter.listModels('doubao')
  assert.ok(models.length > 0, 'listModels 返回空数组 = 选择器会过滤掉这个分组')
  for (const m of models) assert.equal(m.provider, 'doubao')
  const resolved = await adapter.resolveModel('doubao', models[0].id)
  assert.equal(resolved.provider, 'doubao')
  assert.ok(resolved.id)

  release()
  const after = runtime.listProviders().map(p => (typeof p === 'string' ? p : p.id))
  assert.ok(!after.includes('doubao'), 'disposer 应释放路由')
})

test('Harness 按中档准备豆包自动，转发工作任务请求并收到模拟回复', async t => {
  const { LlmRuntime } = await import(url('node_modules/@deepseek-ai/dsh-llm/lib/index.js'))
  const runtime = new LlmRuntime(new Context())
  const signal = new AbortController().signal
  let requests = 0
  const adapter = makeAdapter(async (body, requestSignal) => {
    assert.equal(requestSignal, signal)
    assert.equal(body.option.conversation_init_ext.model_item_key, '9')
    assert.equal(body.option.model_config.model_item_key, '9')
    assert.equal(body.option.aggregate_params.model_item_key, '9')
    assert.equal(body.option.agent_mode, 1)
    assert.equal(body.option.conversation_init_ext.reasoning_effort, '8')
    assert.equal(body.option.aggregate_params.reasoning_effort, '8')
    requests++
    return 'data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"模拟回复"}}}]}}\n'
  })
  t.after(runtime.registerAdapter(['doubao'], adapter))

  const prepared = await runtime.prepareCall({ provider: 'doubao', model: 'doubao-auto', reasoningEffort: 'medium' }, signal)
  assert.equal(prepared.config.model, 'doubao-auto')
  assert.deepEqual(prepared.inputModalities, ['text'])
  assert.equal(requests, 0)

  const chunks = []
  for await (const chunk of prepared.stream({
    ...prepared.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: '离线测试' }] }],
    signal,
  })) chunks.push(chunk)
  assert.equal(requests, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '模拟回复')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Harness 将已有会话切换到豆包自动时可以计算上下文用量', async t => {
  const [{ LlmRuntime }, { TokenMeter }, { BasicCompactionEngine }] = await Promise.all([
    import(url('node_modules/@deepseek-ai/dsh-llm/lib/index.js')),
    import(url('node_modules/@deepseek-ai/dsh-token-meter/lib/index.js')),
    import(url('node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')),
  ])
  const app = new Context()
  const runtime = new LlmRuntime(app)
  const meter = new TokenMeter(app)
  t.after(runtime.registerAdapter(['doubao'], makeAdapter(async () => {
    assert.fail('上下文预算检查不应发起聊天请求')
  })))
  assert.equal(typeof app.get('llm')?.imageRequestPricing, 'function')
  assert.equal(typeof app.get('tokenMeter')?.measure, 'function')
  new BasicCompactionEngine(app)

  const previous = { config: { provider: 'previous', model: 'previous-model' } }
  const session = {
    seq: 1,
    requestHeader: () => previous,
    eventAt: () => ({ type: 'request/header', seq: 0, data: { header: previous } }),
  }
  const target = { provider: 'doubao', model: 'doubao-auto' }
  const signal = new AbortController().signal
  const route = await app.waterfall('agent/request', { agent: { session }, signal }, () => target)
  assert.deepEqual(route, target)
  assert.equal(meter.measure(session, { config: target }).totalTokens, 0)

  const image = { width: 640, height: 480, bytes: 1024 }
  assert.deepEqual(runtime.imageRequestTarget(target.provider, target.model, image), {
    width: 640, height: 480, maxBytes: 1024,
  })
})

test('Harness 将豆包上游的通用失败提示记录为失败，不显示成模型回复', async t => {
  const { LlmRuntime } = await import(url('node_modules/@deepseek-ai/dsh-llm/lib/index.js'))
  const runtime = new LlmRuntime(new Context())
  const adapter = makeAdapter(async () => [
    'data: {"event_data":"出了点问题，"}',
    'data: {"event_data":"请稍后重试。"}',
    'data: [DONE]',
  ].join('\n'))
  t.after(runtime.registerAdapter(['doubao'], adapter))

  const chunks = []
  for await (const chunk of runtime.stream({ provider: 'doubao', model: 'doubao', messages: [] })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: 'DOUBAO_UPSTREAM_ERROR', message: '豆包上游只返回了通用失败提示，未提供具体错误码。' },
    },
  })
})
