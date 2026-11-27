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

/* ===== 豆包 2026-11 改版后的真实响应结构（实测抓包） ===== */
const REAL_2026_11 = {
  data: {
    current_subscription: { product_name: '个人订阅', status: 3 },
    quota_remaining_amount: '3,921',
    quota_blance_usage: [
      { category: 1, title: '套餐', total_amount: '9,000', used_amount: '5,079', used_percent: 56 },
    ],
    window_limit_section: {
      entitlement_count: 0,
      usage_exhausted: false,
      window_limit_groups: [
        {
          feature_group: 'monthly_quota',
          window_limits: [
            {
              end_time: 1795793522669,
              item_type: 1,
              start_time: 0,
              total_amount: '9,000',
              used_amount: '5,079',
              used_percent: 56,
              window_type: 4,
            },
          ],
        },
      ],
    },
  },
}

test('2026-11 新结构：从 window_limit_section 里解析出月度套餐', () => {
  const r = parseQuotaSummary(REAL_2026_11)
  assert.ok(r, '新结构必须能解析（不能因为顶层没有 window_limit_groups 就 undefined）')
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].name, '套餐积分')
  assert.equal(r.windows[0].total, 9000, '"9,000" 必须去千分位')
  assert.equal(r.windows[0].used, 5079)
  assert.equal(r.windows[0].remaining, 3921)
  assert.equal(r.windows[0].resetsAt, 1795793522669)
})

test('2026-11 新结构：total 用上游 quota_remaining_amount（权威，带千分位）', () => {
  const r = parseQuotaSummary(REAL_2026_11)
  assert.equal(r.total, 3921, '"3,921" 必须解析成 3921')
})

test('2026-11 新结构：只有 quota_blance_usage 时也能兜底解析', () => {
  const r = parseQuotaSummary({ data: {
    quota_blance_usage: [{ title: '活动赠送', total_amount: '880', used_amount: '200' }],
  } })
  assert.ok(r)
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].name, '活动赠送')
  assert.equal(r.windows[0].remaining, 680)
  assert.equal(r.total, 680)
})

test('千分位字符串不产生 NaN', () => {
  const r = parseQuotaSummary({ data: {
    quota_blance_usage: [{ title: 'A', total_amount: '1,234,567', used_amount: '1,000' }],
  } })
  assert.equal(r.windows[0].total, 1234567)
  assert.ok(Number.isFinite(r.windows[0].remaining))
})

test('有套餐窗口时仍补齐活动额度，同时避免重复计算同一个套餐', () => {
  const data = {
    ...REAL_2026_11.data,
    quota_remaining_amount: undefined,
    window_limit_groups: [],
    quota_blance_usage: [
      ...REAL_2026_11.data.quota_blance_usage,
      { title: '活动赠送', total_amount: '880', used_amount: '200' },
    ],
  }
  const { windows, total } = parseQuotaSummary({ data })
  assert.deepEqual(windows.map(w => w.remaining), [3921, 680])
  assert.equal(windows[0].resetsAt, 1795793522669)
  assert.equal(windows[1].resetsAt, undefined)
  assert.equal(total, 4601)
})

test('单独有效的总额可以展示，无法解析的窗口不会变成余额 0', () => {
  assert.deepEqual(parseQuotaSummary({ data: { quota_remaining_amount: '3,921' } }), { total: 3921, windows: [] })
  assert.deepEqual(parseQuotaSummary({ data: { quota_remaining_amount: '0' } }), { total: 0, windows: [] })
  assert.equal(parseQuotaSummary({ window_limit_groups: [{ window_limits: [{}] }] }), undefined)
  assert.equal(parseQuotaSummary({ quota_blance_usage: [null] }), undefined)
})
