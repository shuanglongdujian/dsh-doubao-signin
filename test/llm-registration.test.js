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
 * 造一个 adapter（依赖全是桩，因为注册阶段不碰网络）。
 * @returns {object} adapter。
 */
function makeAdapter() {
  return createDoubaoAdapter({
    config: { defaultModel: 'doubao', directFirst: false },
    getIdentity: () => ({ found: false }),
    cookieSource: async () => ({ header: '', source: 'none', ready: false }),
    ensureSigner: async () => ({ postChat: async () => '', cookieHeader: async () => '' }),
    log: () => {},
  })
}

test('adapter 提供宿主注册时需要的全部方法', () => {
  const a = makeAdapter()
  // dsh-llm 的 prepareRoutes 会调用这两个（src/index.ts）
  assert.equal(typeof a.providerInfo, 'function', '缺 providerInfo')
  assert.equal(typeof a.providerRetryPolicy, 'function', '缺 providerRetryPolicy——注册会抛 TypeError')
  assert.equal(typeof a.listModels, 'function', '缺 listModels')
  assert.equal(typeof a.resolveModel, 'function', '缺 resolveModel')
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
