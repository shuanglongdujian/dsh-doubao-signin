/**
 * 标题本地化 + 工作模型默认隐藏的测试。
 *
 * 核心保证：DSH 的自动标题请求**永不发往豆包**（零对话记录、零额度），
 * 且普通对话不受影响。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localSessionTitle } from '../src/session-title.js'
import { createDoubaoAdapter } from '../src/doubao-adapter.js'

/** 造一个 adapter，记录所有网络调用。 */
function makeAdapter() {
  const calls = []
  const adapter = createDoubaoAdapter({
    config: { defaultModel: 'doubao', directFirst: false, includeWorkModels: false },
    getIdentity: () => ({ found: false }),
    cookieSource: async () => ({ header: '' }),
    ensureSigner: async () => {
      calls.push('signer')
      return { postChat: async () => 'data: {"patch_op":[]}' }
    },
    log: () => {},
  })
  return { adapter, calls }
}

const TITLE_PROMPT = (msgs) =>
  'Generate the session title from this JSON array of human messages:\n' + JSON.stringify(msgs)

test('localSessionTitle 识别首轮标题模板并产出标题', () => {
  const r = localSessionTitle({
    messages: [{ role: 'user', content: TITLE_PROMPT(['帮我写一个 Python 爬虫脚本', '第二句']) }],
  })
  assert.equal(r, '帮我写一个 Python 爬虫脚本')
})

test('localSessionTitle 识别更新标题模板', () => {
  const r = localSessionTitle({
    messages: [{
      role: 'user',
      content: 'Update the session title from this JSON object:\n' + JSON.stringify({
        currentTitle: '旧标题',
        messages: ['新的话题内容'],
      }),
    }],
  })
  assert.equal(r, '新的话题内容')
})

test('localSessionTitle 不误伤普通对话', () => {
  assert.equal(localSessionTitle({ messages: [{ role: 'user', content: '你好' }] }), undefined)
  assert.equal(localSessionTitle({ messages: [{ role: 'user', content: TITLE_PROMPT(['x']) }, { role: 'user', content: '另一条' }] }), undefined)
  assert.equal(localSessionTitle({ messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\nnot-json' }] }), undefined)
})

test('标题请求本地返回 StreamChunk，且零网络调用', async () => {
  const { adapter, calls } = makeAdapter()
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'doubao',
    messages: [{ role: 'user', content: TITLE_PROMPT(['测试标题内容']) }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(calls.length, 0, '标题请求绝不能发往豆包')
  assert.equal(chunks.at(-1).type, 'finish')
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, '测试标题内容')
})

test('普通对话仍走网络', async () => {
  const { adapter, calls } = makeAdapter()
  for await (const _ of adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: '你好' }] })) { /* drain */ }
  assert.ok(calls.length > 0, '普通对话应走网络')
})

test('includeWorkModels 默认 false 时只列 2 个对话面模型', async () => {
  const { adapter } = makeAdapter()
  const models = await adapter.listModels('doubao')
  assert.equal(models.length, 2)
  assert.deepEqual(models.map(m => m.id), ['doubao', 'doubao-expert'])
})
