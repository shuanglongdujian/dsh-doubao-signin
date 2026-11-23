/**
 * quota.js 的离线测试。
 *
 * @module test/quota.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QUOTA_PATH, parseQuotaSummary, renderQuota } from '../src/quota.js'

test('QUOTA_PATH 与 connect-doubao 实测端点一致', () => {
  assert.equal(QUOTA_PATH, '/alice/commerce/sale/subscription/quota/summary/')
})

test('解析标准双窗口响应（套餐积分 + 活动赠送）', () => {
  const payload = {
    window_limit_groups: [
      {
        section: '标准套餐',
        window_limits: [
          { window_type: 4, total_amount: 9000, used_amount: 449, start_time: 1764000000, end_time: 1766592000 },
        ],
      },
      {
        section: 'incentive_quota_section',
        window_limits: [
          { window_type: 3, total_amount: 8800, used_amount: 400, end_time: 1765000000 },
        ],
      },
    ],
  }
  const r = parseQuotaSummary(payload)
  assert.ok(r)
  assert.equal(r.windows.length, 2)
  assert.equal(r.windows[0].name, '套餐积分')
  assert.equal(r.windows[0].remaining, 8551)
  assert.equal(r.windows[0].usedPercent, 5)
  assert.equal(r.windows[1].name, '活动赠送额度')
  assert.equal(r.windows[1].remaining, 8400)
  // 秒级时间戳归一成毫秒
  assert.equal(r.windows[0].resetsAt, 1766592000 * 1000)
  assert.equal(r.total, 8551 + 8400)
})

test('负 remaining 钳到 0', () => {
  const r = parseQuotaSummary({
    window_limit_groups: [{ window_limits: [{ window_type: 4, total_amount: 100, used_amount: 250 }] }],
  })
  assert.equal(r.windows[0].remaining, 0)
})

test('字符串数字也能解析', () => {
  const r = parseQuotaSummary({
    window_limit_groups: [{ window_limits: [{ window_type: 4, total_amount: '9000', used_amount: '449' }] }],
  })
  assert.equal(r.windows[0].remaining, 8551)
})

test('旧窗口类型（1/2）保留映射', () => {
  const r = parseQuotaSummary({
    window_limit_groups: [{ window_limits: [{ window_type: 1, total_amount: 10, used_amount: 2 }] }],
  })
  assert.equal(r.windows[0].name, '5小时窗口')
})

test('结构不对返回 undefined（读不出 ≠ 没有）', () => {
  assert.equal(parseQuotaSummary(null), undefined)
  assert.equal(parseQuotaSummary({}), undefined)
  assert.equal(parseQuotaSummary('html'), undefined)
  assert.equal(parseQuotaSummary({ window_limit_groups: 'nope' }), undefined)
})

test('data 包裹层也能解析', () => {
  const r = parseQuotaSummary({
    data: { window_limit_groups: [{ window_limits: [{ window_type: 4, total_amount: 100, used_amount: 50 }] }] },
  })
  assert.equal(r.windows[0].remaining, 50)
})

test('renderQuota 输出人类可读多行', () => {
  const r = parseQuotaSummary({
    window_limit_groups: [
      { window_limits: [{ window_type: 4, total_amount: 9000, used_amount: 449, end_time: Date.now() + 3600_000 }] },
    ],
  })
  const text = renderQuota(r.windows, r.total)
  assert.ok(text.includes('剩余额度合计'))
  assert.ok(text.includes('套餐积分'))
  assert.ok(text.includes('重置'))
})
