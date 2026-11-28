import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenAIGateway } from '../src/openai-gateway.js'

const key = 'test-gateway-key'
const arkKey = 'offline-ark-key'
const baseArk = 'https://ark.cn-beijing.volces.com/api/v3'
const prompt = { model: 'demo', messages: [{ role: 'user', content: '离线自检' }] }

async function start(t, options) {
  const server = createOpenAIGateway({ key, arkKey, ...options })
  t.after(() => { server.close(); server.closeAllConnections() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/v1'
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' }
  const chat = body => fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })
  return { base, headers, chat }
}

test('本机网关按方舟可见模型生成目录、缓存结果，并仅向方舟发送聊天请求', async t => {
  const calls = []
  const answer = { choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } }
  const { base, headers, chat } = await start(t, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url === baseArk + '/models') return Response.json({ data: [
        { id: 'demo', created: 123, task_type: ['TextGeneration'] },
        { id: 'image', task_type: ['TextToImage'] },
        { id: 'audio', task_type: ['Chat'], modalities: { output_modalities: ['audio'] } },
      ] })
      assert.equal(url, baseArk + '/chat/completions')
      return Response.json(answer)
    },
  })

  assert.equal((await fetch(base + '/models')).status, 401)
  assert.equal((await fetch(base + '/models', { headers: { ...headers, origin: 'https://example.org' } })).status, 403)
  assert.equal(calls.length, 0)
  const listing = await fetch(base + '/models', { headers })
  assert.deepEqual((await listing.json()).data, [{ id: 'demo', created: 123, object: 'model', owned_by: 'volcengine' }])
  assert.equal((await chat({ ...prompt, model: 'unknown' })).status, 404)
  assert.equal((await chat({ ...prompt, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).status, 400)
  assert.equal(calls.length, 1)

  const completion = await chat({ ...prompt, max_tokens: 20 })
  assert.equal(completion.status, 200)
  assert.deepEqual(await completion.json(), answer)
  assert.deepEqual(calls.map(call => call.url), [baseArk + '/models', baseArk + '/chat/completions'])
  assert.ok(calls.every(call => call.init.headers.authorization === 'Bearer ' + arkKey && call.init.redirect === 'error'))
  assert.deepEqual(JSON.parse(calls[1].init.body), { ...prompt, max_tokens: 20, stream: false })
})

test('上游仍在生成时转发首块 SSE，保留用量和结束帧', { timeout: 4000 }, async t => {
  const first = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
  const rest = [
    'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"total_tokens":12}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  const encoder = new TextEncoder()
  let upstream
  const { chat } = await start(t, {
    modelIds: ['demo'],
    fetchImpl: async (url, init) => {
      assert.equal(url, baseArk + '/chat/completions')
      assert.deepEqual(JSON.parse(init.body).stream_options, { include_usage: true })
      const body = new ReadableStream({
        start(controller) {
          upstream = controller
          controller.enqueue(encoder.encode(first))
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    },
  })
  const stream = await chat({ ...prompt, stream: true, stream_options: { include_usage: true } })
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/)
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
  let received = ''
  while (!received.includes('\n\n')) {
    const { done, value } = await reader.read()
    assert.equal(done, false)
    received += value
  }
  assert.equal(received, first)
  upstream.enqueue(encoder.encode(rest))
  upstream.close()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value
  }
  assert.equal(received, first + rest)
})

test('方舟权限、限流及错误的流式响应返回结构化错误，且不切换后端', async t => {
  const upstreamStatuses = [403, 429, 200]
  const endpoints = []
  const { chat } = await start(t, {
    modelIds: ['demo'],
    fetchImpl: async url => {
      endpoints.push(url)
      return Response.json({ error: { message: 'upstream private detail' } }, { status: upstreamStatuses.shift() })
    },
  })
  for (const [status, code] of [[502, 'ark_access_denied'], [429, 'ark_rate_limit'], [502, 'ark_invalid_stream']]) {
    const response = await chat({ ...prompt, stream: true })
    assert.equal(response.status, status)
    const result = await response.json()
    assert.equal(result.error.code, code)
    assert.doesNotMatch(result.error.message, /private detail/)
  }
  assert.deepEqual(endpoints, Array(3).fill(baseArk + '/chat/completions'))
})
