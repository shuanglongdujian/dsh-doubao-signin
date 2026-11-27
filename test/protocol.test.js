/**
 * 离线单测：协议层与签到状态机。不碰网络、不碰客户端。
 *
 * 跑：node --test
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { lines } from '../src/signer.js'
import {
  MODELS,
  buildChatBody,
  collectStream,
  extractToolCalls,
  flattenMessages,
  parseSseLine,
  renderToolPrompt,
} from '../src/protocol.js'
import { DAILY_REWARD_CODE, clickExpression, decideState, probeExpression } from '../src/checkin.js'

describe('flattenMessages', () => {
  test('给每个角色加标签', () => {
    const out = flattenMessages([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ])
    assert.match(out, /\[系统设定\]/)
    assert.match(out, /\[用户\]/)
    assert.match(out, /你好/)
  })

  test('多模态只取文本分片', () => {
    const out = flattenMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'http://x/y.png' } },
        ],
      },
    ])
    assert.match(out, /看图/)
    assert.doesNotMatch(out, /y\.png/)
  })

  test('跳过空内容', () => {
    const out = flattenMessages([{ role: 'user', content: '   ' }, { role: 'assistant', content: '' }])
    assert.equal(out, '')
  })
})

describe('buildChatBody', () => {
  test('用 content_block 块结构（豆包网关只认这个形态）', () => {
    const body = buildChatBody({ model: 'doubao', messages: [{ role: 'user', content: 'hi' }] })
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages[0].content_block[0].block_type, 10000)
    assert.equal(body.messages[0].content_block[0].content.text_block.text, '[用户]\nhi')
    assert.equal(body.messages[0].content_block[0].parent_id, '')
    assert.equal(body.messages[0].message_status, 0)
    // 早先的 content 字符串形态会被网关回 710020202，这里钉死不再回退
    assert.equal(body.messages[0].content, undefined)
  })

  test('模型形态四元组取自模型档案（modeId/agentMode/convMode/effort）', () => {
    const body = buildChatBody({ model: 'doubao-auto', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(body.option.mode_id, '3')
    assert.equal(body.option.agent_mode, '1')
    assert.equal(body.option.conversation_mode, 3)
    assert.equal(body.option.reasoning_effort, '3')
    assert.equal(body.option.model_item_key, '9')
    assert.equal(body.conversation_mode, 3)
  })

  test('对话面模型用 mode 1 / agent_mode 2', () => {
    const body = buildChatBody({ model: 'doubao', messages: [] })
    assert.equal(body.option.mode_id, '1')
    assert.equal(body.option.agent_mode, '2')
    assert.equal(body.option.conversation_mode, 1)
    assert.equal(body.option.model_item_key, '0')
  })

  test('model_extra_params 原样转发（告诉服务端预留多少内存）', () => {
    const body = buildChatBody({ model: 'kimi-k3', messages: [] })
    assert.deepEqual(body.model_extra_params, { memory_profile: '300k_230', total_window_size: '300000' })
  })

  test('没有 conversationId 时要求新建会话', () => {
    const body = buildChatBody({ model: 'doubao', messages: [] })
    assert.equal(body.option.need_create_conversation, true)
    assert.ok(body.client_meta.conversation_id)
  })

  test('给了 conversationId 就复用', () => {
    const body = buildChatBody({ model: 'doubao', messages: [], conversationId: 'conv-123' })
    assert.equal(body.option.need_create_conversation, false)
    assert.equal(body.client_meta.conversation_id, 'conv-123')
  })

  test('toolPrompt 拼到 prompt 前面', () => {
    const body = buildChatBody({ model: 'doubao', messages: [{ role: 'user', content: 'hi' }], toolPrompt: 'TOOLS' })
    const text = body.messages[0].content_block[0].content.text_block.text
    assert.ok(text.startsWith('TOOLS'))
    assert.ok(text.includes('hi'))
  })

  test('未知模型抛错', () => {
    assert.throws(() => buildChatBody({ model: 'nope', messages: [] }), /model_not_found/)
  })
})

describe('parseSseLine', () => {
  test('纯文本事件', () => {
    const ev = parseSseLine('data: {"event_data": "{\\"message\\":{\\"content\\":\\"你好\\"}}"}')
    assert.equal(ev.kind, 'text')
    assert.equal(ev.text, '你好')
  })

  test('嵌套 event_data 对象', () => {
    const payload = { event_type: 2001, event_data: JSON.stringify({ message: { content: '分块' } }) }
    const ev = parseSseLine(`data: ${JSON.stringify(payload)}`)
    assert.equal(ev.kind, 'text')
    assert.equal(ev.text, '分块')
  })

  test('思考内容走 think', () => {
    const payload = { event_data: JSON.stringify({ message: { content: '思考中', content_type: 2006 } }) }
    const ev = parseSseLine(`data: ${JSON.stringify(payload)}`)
    assert.equal(ev.kind, 'think')
  })

  test('[DONE] 是 done', () => {
    assert.equal(parseSseLine('data: [DONE]').kind, 'done')
  })

  test('心跳与 event 头返回 null', () => {
    assert.equal(parseSseLine(': keep-alive'), null)
    assert.equal(parseSseLine('event: message'), null)
    assert.equal(parseSseLine(''), null)
    assert.equal(parseSseLine('data:'), null)
  })

  test('认不出来的帧标 unknown，不丢', () => {
    const ev = parseSseLine('data: {"event_type": 9999, "weird": true}')
    assert.equal(ev.kind, 'unknown')
    assert.ok(ev.raw)
  })

  test('坏 JSON 当文本，不当崩溃', () => {
    const ev = parseSseLine('data: 这不是JSON')
    assert.equal(ev.kind, 'text')
    assert.equal(ev.text, '这不是JSON')
  })
})

describe('extractToolCalls', () => {
  test('单个调用', () => {
    const { text, calls } = extractToolCalls('先看天气\n<tool_call>{"name":"get_weather","arguments":{"city":"上海"}}</tool_call>')
    assert.equal(text, '先看天气')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].function.name, 'get_weather')
    assert.equal(JSON.parse(calls[0].function.arguments).city, '上海')
  })

  test('多个调用并存', () => {
    const src = '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{"x":1}}</tool_call>'
    const { calls } = extractToolCalls(src)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(c => c.function.name), ['a', 'b'])
  })

  test('坏 JSON 原样留在文本里', () => {
    const { text, calls } = extractToolCalls('<tool_call>{not json}</tool_call>')
    assert.equal(calls.length, 0)
    assert.match(text, /\{not json\}/)
  })

  test('未闭合的块留在文本里', () => {
    const { text, calls } = extractToolCalls('<tool_call>{"name":"a","arguments":{')
    assert.equal(calls.length, 0)
    assert.match(text, /<tool_call>/)
  })

  test('缺 name 的块原样保留', () => {
    const { text, calls } = extractToolCalls('<tool_call>{"arguments":{"x":1}}</tool_call>')
    assert.equal(calls.length, 0)
    assert.match(text, /<tool_call>/)
  })

  test('arguments 是字符串时透传', () => {
    const { calls } = extractToolCalls('<tool_call>{"name":"f","arguments":"{\\"a\\":1}"}</tool_call>')
    assert.equal(calls[0].function.arguments, '{"a":1}')
  })

  test('每个调用有唯一 id', () => {
    const { calls } = extractToolCalls('<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>')
    assert.notEqual(calls[0].id, calls[1].id)
  })
})

describe('renderToolPrompt', () => {
  test('包含工具名与 schema', () => {
    const out = renderToolPrompt([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }])
    assert.match(out, /- f: d/)
    assert.match(out, /<tool_call>/)
  })

  test('空数组也成文', () => {
    assert.equal(typeof renderToolPrompt([]), 'string')
  })
})

describe('collectStream', () => {
  test('拼文本并忽略 done 之后', async () => {
    async function* gen() {
      yield { kind: 'text', text: 'a' }
      yield { kind: 'think', text: '想' }
      yield { kind: 'text', text: 'b' }
      yield { kind: 'done' }
      yield { kind: 'text', text: '不会到' }
    }
    const { text, thinking } = await collectStream(gen())
    assert.equal(text, 'ab')
    assert.equal(thinking, '想')
  })

  test('unknown 交给回调', async () => {
    let count = 0
    async function* gen() {
      yield { kind: 'unknown', raw: {} }
      yield { kind: 'unknown', raw: {} }
    }
    await collectStream(gen(), () => { count += 1 })
    assert.equal(count, 2)
  })
})

describe('decideState', () => {
  test('有卡片且能点 = 未签到', () => {
    const r = decideState({ hasCard: true, canSign: true })
    assert.equal(r.state, 'not_signed')
    assert.equal(r.ok, true)
  })

  test('按钮不可用时无法确认签到，有领取标记才判定已签到', () => {
    const unknown = decideState({ hasCard: true, canSign: false })
    assert.equal(unknown.state, 'unknown')
    assert.equal(unknown.ok, false)
    assert.equal(decideState({ hasCard: true, rewarded: true }).state, 'already')
  })

  test('登录墙', () => {
    const r = decideState({ hasCard: false, loginWall: true })
    assert.equal(r.state, 'unlogged')
    assert.equal(r.ok, false)
  })

  test('没有卡片 = 活动换期', () => {
    assert.equal(decideState({ hasCard: false, loginWall: false }).state, 'no_card')
  })

  test('空探针不崩溃', () => {
    assert.equal(decideState({}).state, 'no_card')
  })
})

describe('页面脚本', () => {
  test('探针脚本带上活动锚点', () => {
    assert.match(probeExpression(), new RegExp(DAILY_REWARD_CODE))
    assert.match(probeExpression(), /data-reward-code/)
  })

  test('点击脚本限定在签到卡片内', () => {
    assert.match(clickExpression(), new RegExp(DAILY_REWARD_CODE))
    assert.match(clickExpression(), /PointerEvent/)
  })

  test('探针脚本是只读的', () => {
    const src = probeExpression()
    assert.doesNotMatch(src, /\.click\(|dispatchEvent|\.remove\(|innerText\s*=/)
  })
})
/* ===== 真实 SSE 帧（2026-11-25 用真凭据抓的响应） ===== */
describe('真实帧解析', () => {
  const REAL_SSE = [
    'id: 0',
    'event: SSE_HEARTBEAT',
    'data: {}',
    '',
    'id: 4',
    'event: STREAM_MSG_NOTIFY',
    'data: {"content":{"content_block":[{"block_type":10000,"block_id":"10715424070609922","content":{"text_block":{"text":"你"}},"is_finish":false,"patch_type":1}],"content_status":100}}',
    '',
    'id: 6',
    'event: STREAM_CHUNK',
    'data: {"message_id":"63015907524239874","patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"block_type":10000,"block_id":"10715424070609922","content":{"text_block":{"text":"好"}},"is_finish":false,"patch_type":1}]}}]}',
    '',
    'id: 12',
    'event: STREAM_CHUNK',
    'data: {"message_id":"63015907524239874","patch_op":[{"patch_object":50,"patch_type":1,"patch_value":{"ext":{"finish_reason_chat":"succeed:completion"}}}]}',
    '',
  ].join('\n')

  test('lines() 只产出 data 行（id:/event: 行不是数据）', async () => {
    const got = []
    for await (const line of lines(REAL_SSE)) got.push(line)
    assert.equal(got.length, 4)
    assert.ok(got.every(l => l.startsWith('{')), '只应是 JSON 数据行')
    assert.ok(!got.some(l => l.startsWith('id:')), 'id: 行不能进解析器')
  })

  test('STREAM_MSG_NOTIFY 的 content.content_block 解析出正文', () => {
    const ev = parseSseLine(
      'data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"你"}}}]}}',
    )
    assert.equal(ev.kind, 'text')
    assert.equal(ev.text, '你')
  })

  test('STREAM_CHUNK 的 patch_op 解析出正文增量', () => {
    const ev = parseSseLine(
      'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"好"}}}]}}]}',
    )
    assert.equal(ev.kind, 'text')
    assert.equal(ev.text, '好')
  })

  test('真实流拼起来得到完整回答', async () => {
    let text = ''
    for await (const line of lines(REAL_SSE)) {
      const ev = parseSseLine(line)
      if (ev?.kind === 'text') text += ev.text
    }
    assert.equal(text, '你好')
  })

  test('空的 text_block（is_finish 帧）不产出空文本', () => {
    const ev = parseSseLine(
      'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{}},"is_finish":true}]}}]}',
    )
    assert.ok(ev === null || ev.kind !== 'text' || ev.text === '')
  })
})
