/**
 * doubao-adapter.js 的离线测试：StreamChunk 序列必须符合 dsh-llm 契约。
 *
 * 契约要点（dsh-llm/src/index.ts + llm-adapter.zh.md）：
 * - block-start / block-end 成对，index 递增；
 * - usage 必须在 finish 之前；
 * - finish 必须是最后一个 chunk；
 * - 工具调用要产出 tool-call 块并以 finish tool-calls 收尾。
 *
 * @module test/doubao-adapter.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDoubaoAdapter, PROVIDER } from '../src/doubao-adapter.js'

/**
 * 造一个 adapter，注入固定 SSE。
 * @param {string} sse - SSE 原文。
 * @param {object} [opts] - 覆盖。
 * @returns {{adapter: object, calls: object[]}} adapter 与调用记录。
 */
function makeAdapter(sse, opts = {}) {
  const calls = []
  const adapter = createDoubaoAdapter({
    config: { defaultModel: 'doubao', directFirst: false, ...opts.config },
    getIdentity: () => ({ found: false }),
    cookieSource: async () => ({ header: '', source: 'none', ready: false }),
    ensureSigner: async () => ({
      postChat: async (body, signal) => { calls.push({ body, signal }); return sse },
      cookieHeader: async () => '',
    }),
    log: () => {},
  })
  return { adapter, calls }
}

/**
 * 把异步流收集成数组。
 * @param {AsyncIterable<object>} it - 流。
 * @returns {Promise<object[]>} 事件数组。
 */
async function collect(it) {
  const out = []
  for await (const chunk of it) out.push(chunk)
  return out
}

test('PROVIDER id 正确', () => {
  assert.equal(PROVIDER, 'doubao')
})

test('providerInfo 返回合法的 id/name', () => {
  const { adapter } = makeAdapter('')
  const info = adapter.providerInfo('doubao')
  assert.equal(info.id, 'doubao')
  assert.ok(info.name.length > 0)
})

test('listModels 非空且 provider 匹配（空数组会被选择器过滤）', async () => {
  const { adapter } = makeAdapter('')
  const models = await adapter.listModels('doubao')
  assert.ok(models.length >= 2)
  for (const m of models) {
    assert.equal(m.provider, 'doubao')
    assert.ok(m.id && m.name)
  }
  // 默认只列对话面模型（免费可用），工作模式模型（需会员额度）默认隐藏
  assert.ok(models.some(m => m.id === 'doubao'))
  assert.ok(!models.some(m => m.id === 'doubao-auto'), '工作模式模型默认不该出现在选择器里')
})

test('includeWorkModels: true 时才注册工作模式模型', async () => {
  const { adapter } = makeAdapter('', { config: { includeWorkModels: true } })
  const models = await adapter.listModels('doubao')
  assert.ok(models.some(m => m.id === 'doubao-auto'), '开启后应包含工作模式模型')
  assert.ok(models.length >= 15)
})

test('resolveModel 给上下文窗口', async () => {
  const { adapter } = makeAdapter('')
  const r = await adapter.resolveModel('doubao', 'doubao')
  assert.equal(r.provider, 'doubao')
  assert.equal(r.id, 'doubao')
  assert.ok(r.context.contextWindow >= 32768)
})

test('stream：普通对话产出 text 块，usage 在 finish 前，finish 最后', async () => {
  const sse = [
    'data: {"message_id":"63015907524239874","patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"block_type":10000,"block_id":"10715424070609922","content":{"text_block":{"text":"好"}},"is_finish":false,"patch_type":1}]}}]}',
    '',
  ].join('\n')
  const { adapter } = makeAdapter(sse)
  const chunks = await collect(adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: 'hi' }] }))

  assert.ok(chunks.length >= 4)
  assert.equal(chunks[chunks.length - 1].type, 'finish')
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
  const usageIdx = chunks.findIndex(c => c.type === 'usage')
  const finishIdx = chunks.findIndex(c => c.type === 'finish')
  assert.ok(usageIdx >= 0 && usageIdx < finishIdx, 'usage 必须在 finish 之前')

  // block-start / block-end 成对
  const starts = chunks.filter(c => c.type === 'block-start').map(c => c.index)
  const ends = chunks.filter(c => c.type === 'block-end').map(c => c.index)
  assert.deepEqual(starts, ends, 'block-start 与 block-end 的 index 必须成对')
  // 文本内容完整
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, '好')
})

test('stream：思考内容产出 reasoning 块', async () => {
  const sse = [
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10040,"content":{"text_block":{"text":"想一下"}}}]}}]}',
    '',
    'data: {"message_id":"63015907524239874","patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"block_type":10000,"block_id":"10715424070609922","content":{"text_block":{"text":"好"}},"is_finish":false,"patch_type":1}]}}]}',
    '',
  ].join('\n')
  const { adapter } = makeAdapter(sse)
  const chunks = await collect(adapter.stream({ model: 'doubao', messages: [] }))
  assert.ok(chunks.some(c => c.type === 'reasoning-delta'))
  assert.ok(chunks.some(c => c.type === 'block-start' && c.blockType === 'reasoning'))
})

test('stream：工具调用产出 tool-call 块并以 tool-calls 收尾', async () => {
  // 真实帧形态：补丁里的 text_block.text 带 <tool_call> 标记
  const marker = '<tool_call>{"name":"shell","arguments":{"cmd":"ls"}}</tool_call>'
  const sse = [
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":' + JSON.stringify(marker) + '}}}]}}]}',
    '',
  ].join('\n')
  const { adapter } = makeAdapter(sse)
  const chunks = await collect(adapter.stream({
    model: 'doubao',
    messages: [{ role: 'user', content: '列文件' }],
    tools: [{ name: 'shell', description: 'run', parameters: { type: 'object', properties: {} } }],
  }))
  assert.ok(chunks.some(c => c.type === 'tool-call-delta'))
  const last = chunks[chunks.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'tool-calls')
  const starts = chunks.filter(c => c.type === 'block-start').map(c => c.index)
  const ends = chunks.filter(c => c.type === 'block-end').map(c => c.index)
  assert.deepEqual(starts, ends)
})

test('stream：风控错误 710022004 抛出可读异常', async () => {
  const sse = 'event: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"rate limited"}\n'
  const { adapter } = makeAdapter(sse)
  await assert.rejects(
    () => collect(adapter.stream({ model: 'doubao', messages: [] })),
    /710022004|人机验证/,
  )
})

test('stream：保留后续上游帧里的错误码，不回显内部响应内容', async () => {
  const { adapter } = makeAdapter([
    'data: {"meta":"initial"}',
    'data: {"data":{"error_code":710099999,"error_msg":"internal fixture detail"}}',
    'data: [DONE]',
  ].join('\n'))
  await assert.rejects(
    () => collect(adapter.stream({ model: 'doubao', messages: [] })),
    { code: 'DOUBAO_UPSTREAM_ERROR', message: '豆包上游返回错误码 710099999。' },
  )
})

test('stream：system 消息被前置进 messages', async () => {
  const { adapter, calls } = makeAdapter('data: [DONE]\n')
  await collect(adapter.stream({
    model: 'doubao',
    system: '你是助手',
    messages: [{ role: 'user', content: 'hi' }],
  }))
  const sent = calls[0].body.messages[0].content_block[0].content.text_block.text
  assert.ok(sent.includes('你是助手'), 'system 应进入请求体')
  assert.ok(sent.includes('hi'))
})

test('stream：未知模型回落到默认模型', async () => {
  const { adapter, calls } = makeAdapter('data: [DONE]\n')
  await collect(adapter.stream({ model: 'not-a-model', messages: [] }))
  assert.ok(calls[0].body, '应仍然发出请求')
})
