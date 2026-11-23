/**
 * hardening.js 的离线测试：审核识别、清洗、预算、速率锁、熔断。
 *
 * @module test/hardening.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Circuit,
  FailureKind,
  MAX_PROMPT_CHARS,
  Pacer,
  RISK_CODE,
  applyPromptBudget,
  classifyFailure,
  cleanForWire,
  createRefusalTracker,
  isRefusal,
} from '../src/hardening.js'

/* ===== 审核识别 ===== */

test('isRefusal 认得审核通知的开头', () => {
  assert.equal(isRefusal('该内容涉嫌违反[豆包使用规范](https://www.doubao.com/legal/community_guidelines)，若有误判…'), true)
})

test('isRefusal 认得社区规范链接锚点', () => {
  assert.equal(isRefusal('根据 https://www.doubao.com/legal/community_guidelines 的规定…'), true)
})

test('isRefusal 不误伤普通回答', () => {
  assert.equal(isRefusal('KV cache 是一种缓存键值对的技术…'), false)
  assert.equal(isRefusal('该内存池的实现如下…'), false)
  assert.equal(isRefusal(''), false)
})

test('createRefusalTracker 在流式前缀阶段缓冲、补齐后判出审核', () => {
  const t = createRefusalTracker()
  const first = t.push('该内容涉嫌') // 还差"违反"两个字，先缓冲
  assert.equal(first.refusal, null)
  assert.equal(first.text, '')
  const second = t.push('违反…')
  assert.equal(second.refusal, true)
})

test('createRefusalTracker 正常回答第一个字就放行', () => {
  const t = createRefusalTracker()
  const first = t.push('好的')
  assert.equal(first.refusal, false)
  assert.equal(first.text, '好的')
  const second = t.push('，KV cache 是…')
  assert.equal(second.refusal, false)
  assert.equal(second.text, '，KV cache 是…')
})

test('createRefusalTracker 不确定的前缀继续缓冲', () => {
  const t = createRefusalTracker()
  const first = t.push('该内')
  assert.equal(first.refusal, null)
  const second = t.push('容涉嫌违反')
  assert.equal(second.refusal, true)
})

test('createRefusalTracker 流结束时补判定', () => {
  const t = createRefusalTracker()
  t.push('该内容涉嫌违反链接')
  const final = t.done()
  assert.equal(final.refusal, true)
})

/* ===== cleanForWire ===== */

test('cleanForWire 剥掉 system-reminder 块', () => {
  const s = cleanForWire('真实问题 <system-reminder>AGENTS.md 全文…数千字符</system-reminder> 请回答')
  assert.equal(s, '真实问题  请回答')
})

test('cleanForWire 丢弃宿主 system 前言（长块）', () => {
  const long = '系统前言。'.repeat(500) // > 2000
  assert.equal(cleanForWire(long, 'system'), '')
})

test('cleanForWire 丢弃带宿主标记的 system 块（短块也丢）', () => {
  assert.equal(cleanForWire('Instructions from: AGENTS.md', 'system'), '')
})

test('cleanForWire 保留用户内容即使很长', () => {
  const doc = '用户粘贴的文档。'.repeat(500)
  assert.equal(cleanForWire(doc, 'user'), doc.trim())
})

test('cleanForWire 丢弃带宿主标记的长 assistant 块', () => {
  const s = '<compacted-summary>'.padEnd(2200, 'x')
  assert.equal(cleanForWire(s, 'assistant'), '')
})

/* ===== prompt 预算 ===== */

test('applyPromptBudget 短文本原样通过', () => {
  const r = applyPromptBudget('短问题')
  assert.equal(r.truncated, false)
  assert.equal(r.text, '短问题')
})

test('applyPromptBudget 超长文本截断到预算内且保尾', () => {
  const huge = '旧轮次填充。'.repeat(20000) + '\n最后一条指令：解出 x'
  const r = applyPromptBudget(huge)
  assert.equal(r.truncated, true)
  assert.ok(r.text.length <= MAX_PROMPT_CHARS)
  assert.ok(r.text.includes('最后一条指令：解出 x'), '保尾失败')
  assert.ok(r.text.includes('较早的轮次已省略'))
})

test('applyPromptBudget 自定义上限', () => {
  const r = applyPromptBudget('a'.repeat(5000), 1000)
  assert.equal(r.truncated, true)
  assert.ok(r.text.length <= 1000)
})

/* ===== Pacer ===== */

test('Pacer 整轮持锁：第二轮等第一轮 release', async () => {
  const p = new Pacer({ minIntervalMs: 0 })
  const order = []
  const r1 = await p.begin()
  const second = p.begin().then(() => order.push('second'))
  setTimeout(() => { order.push('release'); r1() }, 50)
  await second
  assert.deepEqual(order, ['release', 'second'])
})

test('Pacer release 只生效一次', async () => {
  const p = new Pacer({ minIntervalMs: 0 })
  const r = await p.begin()
  r(); r(); r() // 多余的调用无害
  await p.begin()
})

test('Pacer 前一轮抛错不阻塞下一轮', async () => {
  const p = new Pacer({ minIntervalMs: 0 })
  const r = await p.begin()
  // 模拟 tail 里的错误：tail 在 release 后抛
  p.tail = p.tail.then(() => { throw new Error('boom') }).catch(() => {})
  r()
  const r2 = await p.begin()
  r2()
})

/* ===== Circuit ===== */

test('Circuit trip 后 open，冷却后自动恢复', async () => {
  const c = new Circuit({ cooldownMs: 30 })
  assert.equal(c.open, false)
  c.trip()
  assert.equal(c.open, true)
  assert.ok(c.remainingMs > 0)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(c.open, false)
})

test('Circuit reset 手动解除', () => {
  const c = new Circuit({ cooldownMs: 60_000 })
  c.trip()
  assert.equal(c.open, true)
  c.reset()
  assert.equal(c.open, false)
})

/* ===== classifyFailure ===== */

test('classifyFailure 识别风控码 710022004', () => {
  const r = classifyFailure('STREAM_ERROR {"error_code": 710022004, "error_msg": "rate limit"}')
  assert.equal(r.kind, FailureKind.RISK)
  assert.equal(r.code, RISK_CODE)
})

test('classifyFailure 识别审核通知', () => {
  const r = classifyFailure('该内容涉嫌违反[豆包使用规范](https://www.doubao.com/legal/community_guidelines)')
  assert.equal(r.kind, FailureKind.MODERATED)
})

test('classifyFailure 识别 invalid param', () => {
  const r = classifyFailure('event: error\ndata: {"message": "common invalid param"}')
  assert.equal(r.kind, FailureKind.UPSTREAM)
  assert.ok(r.message.includes('invalid param'))
})

test('classifyFailure 兜底', () => {
  const r = classifyFailure('')
  assert.equal(r.kind, FailureKind.UPSTREAM)
})
