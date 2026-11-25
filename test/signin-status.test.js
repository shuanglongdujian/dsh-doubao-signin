/**
 * signin-status.js 的离线测试：只读状态解析，绝不能发领取请求。
 *
 * @module test/signin-status.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAMPAIGN_SCENE,
  DETAIL_PATH,
  LOGIN_INVALID,
  SIGNIN_TASK,
  detailUrl,
  querySigninStatus,
  readCheckin,
} from '../src/signin-status.js'

/** 真实的 detail 响应骨架。 */
function detail({ status = 2, checked = false, code = 'daily_signin', kinds } = {}) {
  const tasks = (kinds ?? [code]).map(k => ({
    task_kind: k,
    campaign_code: k,
    task_status: status,
    daily_checkin: {
      checked_in_today: checked,
      continuous_days: 7,
      reward: { reward_amount: 200 },
      last_checkin_date: '2026-11-24',
    },
  }))
  return { code: 0, data: { tasks } }
}

test('常量与开源实现一致', () => {
  assert.equal(DETAIL_PATH, '/alice/ug/campaign/v3/detail/')
  assert.equal(CAMPAIGN_SCENE, 'pc_incentive_task_mvp_v3')
  assert.equal(SIGNIN_TASK, 'daily_signin')
  assert.equal(LOGIN_INVALID, 710012001)
})

test('detailUrl 带桌面平台参数与 activity group', () => {
  const url = detailUrl({ webId: '76xxx', teaUuid: 'yyy' })
  assert.ok(url.startsWith('https://www.doubao.com' + DETAIL_PATH))
  assert.ok(url.includes('web_platform=desktop'))
  assert.ok(url.includes('aid=497858'))
  assert.ok(url.includes('web_id=76xxx'))
  assert.ok(!url.includes('checkin/landing')) // 绝不能带领取路径
})

test('readCheckin：可领取（status=2、今天未签）', () => {
  const r = readCheckin(detail())
  assert.equal(r.found, true)
  assert.equal(r.claimable, true)
  assert.equal(r.claimed, false)
  assert.equal(r.points, 200)
  assert.equal(r.streak, 7)
  assert.ok(r.message.includes('客户端'))
})

test('readCheckin：今天已签', () => {
  const r = readCheckin(detail({ checked: true }))
  assert.equal(r.claimed, true)
  assert.ok(r.message.includes('已签到'))
})

test('readCheckin：status=1 不可领（账号没被投放）', () => {
  const r = readCheckin(detail({ status: 1 }))
  assert.equal(r.claimable, false)
  assert.ok(r.message.includes('不可领'))
})

test('readCheckin：没有签到任务（工作版/企业账号）', () => {
  // 真实工作版：有任务面板，但任务没有 daily_checkin 字段
  const r = readCheckin({ code: 0, data: { tasks: [
    { task_kind: 'some_other_task', campaign_code: 'some_other_task', task_status: 2 },
  ] } })
  assert.equal(r.found, false)
  assert.ok(r.kinds.includes('some_other_task'))
  assert.ok(r.message.includes('没有每日签到任务'))
})

test('readCheckin：空响应安全', () => {
  const r = readCheckin({})
  assert.equal(r.found, false)
  assert.deepEqual(r.kinds, [])
})

test('querySigninStatus 用注入 fetch 只读查询（不发领取请求）', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, init })
    return { status: 200, json: async () => detail() }
  }
  const r = await querySigninStatus('sessionid=x', { fetchImpl: fakeFetch })
  assert.equal(r.state, 'can_sign')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes(DETAIL_PATH))
  assert.ok(!calls[0].url.includes('landing/checkin'))
  assert.equal(JSON.parse(calls[0].init.body).campaign_group_code, CAMPAIGN_SCENE)
})

test('querySigninStatus：登录失效', async () => {
  const fakeFetch = async () => ({ status: 200, json: async () => ({ code: LOGIN_INVALID }) })
  const r = await querySigninStatus('bad', { fetchImpl: fakeFetch })
  assert.equal(r.state, 'unlogged')
  assert.equal(r.ok, false)
})

test('querySigninStatus：非 JSON 安全降级', async () => {
  const fakeFetch = async () => ({ status: 503, json: async () => { throw new Error('not json') } })
  const r = await querySigninStatus('x', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'error')
})

test('querySigninStatus：网络异常安全降级', async () => {
  const fakeFetch = async () => { throw new Error('ECONNRESET') }
  const r = await querySigninStatus('x', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.match(r.message, /ECONNRESET/)
})
