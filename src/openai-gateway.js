import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_BODY_BYTES = 1024 * 1024
const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const CATALOG_TTL_MS = 60_000
const CHAT_OPTIONS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'stream_options', 'thinking']

class RequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readChatRequest(request) {
  let size = 0
  const parts = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'request_too_large', '请求体超过 1 MiB。')
    parts.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    throw new RequestError(400, 'invalid_json', '请求体必须是有效的 JSON。')
  }
  if (typeof body?.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError(400, 'invalid_request', '请提供模型 ID 和非空 messages 数组。')
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new RequestError(400, 'invalid_request', 'stream 必须是布尔值。')
  }
  if (body.tools?.length || body.functions?.length || (body.n !== undefined && body.n !== 1)) {
    throw new RequestError(400, 'unsupported_option', '当前接口支持单条纯文本回复。')
  }
  const messages = body.messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant'].includes(message?.role)) {
      throw new RequestError(400, 'unsupported_message', '当前接口支持 system、developer、user 和 assistant 文本消息。')
    }
    let content = message.content
    if (Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')) {
      content = content.map(part => part.text).join('')
    }
    if (typeof content !== 'string' || message.tool_calls?.length) {
      throw new RequestError(400, 'unsupported_content', '当前接口支持纯文本内容。')
    }
    return { role: message.role === 'developer' ? 'system' : message.role, content }
  })
  const input = { model: body.model, messages, stream: body.stream === true }
  for (const name of CHAT_OPTIONS) {
    if (Object.hasOwn(body, name) && (name !== 'stream_options' || input.stream)) input[name] = body[name]
  }
  return input
}

function arkRequestError(status) {
  if (status === 401 || status === 403) {
    return new RequestError(502, 'ark_access_denied', '方舟拒绝访问，请检查 ARK_API_KEY 和模型权限。')
  }
  if (status === 404) return new RequestError(404, 'ark_model_unavailable', '方舟模型或接入点不可用，请检查 ID 和开通状态。')
  if (status === 429) return new RequestError(429, 'ark_rate_limit', '方舟暂时限流或额度不足。')
  if (status === 400 || status === 422) {
    return new RequestError(400, 'ark_invalid_request', '方舟拒绝请求参数，请检查该模型支持的参数和输入长度。')
  }
  return new RequestError(502, 'ark_upstream_error', `方舟请求失败（HTTP ${status}）。`)
}

async function forwardChat(response, input, signal, requestArk) {
  const upstream = await requestArk('/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: input.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  })
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    throw arkRequestError(upstream.status)
  }
  if (input.stream) {
    const contentType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (!upstream.body || contentType !== 'text/event-stream') {
      await upstream.body?.cancel().catch(() => {})
      throw new RequestError(502, 'ark_invalid_stream', '方舟没有返回 SSE 响应。')
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    await pipeline(Readable.fromWeb(upstream.body), response, { signal })
    return
  }
  const payload = await upstream.json()
  if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
    throw new RequestError(502, 'ark_invalid_response', '方舟没有返回有效的聊天结果。')
  }
  json(response, 200, payload)
}

function modelEntry(id, created = 0) {
  return { id, object: 'model', created, owned_by: 'volcengine' }
}

async function discoverModels(requestArk, signal) {
  const upstream = await requestArk('/models', { signal })
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    throw arkRequestError(upstream.status)
  }
  const payload = await upstream.json()
  if (!Array.isArray(payload?.data)) {
    throw new RequestError(502, 'ark_invalid_catalog', '方舟没有返回有效的模型目录。')
  }
  const models = new Map()
  for (const model of payload.data) {
    if (typeof model?.id !== 'string' || !model.id.trim()) continue
    const tasks = Array.isArray(model.task_type) ? model.task_type : []
    if (!tasks.includes('Chat') && !tasks.includes('TextGeneration')) continue
    const output = model.modalities?.output_modalities
    if (Array.isArray(output) && output.length && !output.includes('text')) continue
    models.set(model.id, modelEntry(model.id, Number.isInteger(model.created) ? model.created : 0))
  }
  return models
}

export function createOpenAIGateway({ key, arkKey, modelIds = [], timeoutMs = 180_000, fetchImpl = fetch }) {
  if (!key?.trim()) throw new Error('DOUBAO_GATEWAY_KEY 未设置')
  if (!arkKey?.trim()) throw new Error('ARK_API_KEY 未设置')
  if (!Array.isArray(modelIds) || modelIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('openaiGatewayModelIds 必须是方舟模型或接入点 ID 的数组')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4_294_967_295) {
    throw new Error('timeoutMs 必须是有效的毫秒数')
  }
  const expected = Buffer.from('Bearer ' + key)
  const configuredModels = new Map(modelIds.map(id => [id.trim(), modelEntry(id.trim())]))
  const requestArk = (path, { headers, ...init }) => fetchImpl(ARK_BASE_URL + path, {
    ...init,
    redirect: 'error',
    headers: { authorization: 'Bearer ' + arkKey, ...headers },
  })
  let cachedModels, expiresAt = 0, pendingCatalog
  const getModels = () => {
    if (configuredModels.size) return configuredModels
    if (cachedModels && Date.now() < expiresAt) return cachedModels
    pendingCatalog ??= discoverModels(requestArk, AbortSignal.timeout(Math.min(timeoutMs, 10_000)))
      .then(models => {
        cachedModels = models
        expiresAt = Date.now() + CATALOG_TTL_MS
        return models
      })
      .finally(() => { pendingCatalog = undefined })
    return pendingCatalog
  }
  return createServer(async (request, response) => {
    const cancel = new AbortController()
    response.once('close', () => { if (!response.writableFinished) cancel.abort() })
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([cancel.signal, timeout])
    try {
      const port = request.socket.localPort
      const hosts = ['127.0.0.1:' + port, 'localhost:' + port]
      if (!hosts.includes(request.headers.host) || request.headers.origin) {
        throw new RequestError(403, 'invalid_origin', '此接口供本机 API 客户端使用。')
      }
      const authorization = Buffer.from(request.headers.authorization ?? '')
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        throw new RequestError(401, 'invalid_api_key', '请提供正确的网关 API Key。')
      }
      const pathname = request.url?.split('?', 1)[0]
      if (pathname === '/v1/models' && request.method === 'GET') {
        const models = await getModels()
        signal.throwIfAborted()
        json(response, 200, {
          object: 'list',
          data: [...models.values()],
        })
      } else if (pathname === '/v1/chat/completions' && request.method === 'POST') {
        const input = await readChatRequest(request)
        const models = await getModels()
        signal.throwIfAborted()
        if (!models.has(input.model)) {
          throw new RequestError(404, 'model_not_found', '模型不在本机网关的方舟目录中。')
        }
        await forwardChat(response, input, signal, requestArk)
      } else {
        throw new RequestError(404, 'not_found', '没有这个接口。')
      }
    } catch (error) {
      if (response.destroyed || cancel.signal.aborted) return
      const failure = error instanceof RequestError ? error : timeout.aborted
        ? new RequestError(504, 'upstream_timeout', '模型请求超时。')
        : new RequestError(502, 'ark_upstream_error', '无法完成方舟模型请求。')
      const body = {
        error: { code: failure.code, message: failure.message, type: failure.status >= 500 ? 'server_error' : 'invalid_request_error' },
      }
      if (!response.headersSent) json(response, failure.status, body)
      else response.destroy()
    }
  })
}
