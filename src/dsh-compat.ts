import {
  clientRequestSchema,
  type ConnectionRpcHandler,
  type HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'

interface BrowserRpcPayload {
  readonly endpoint: string
  readonly payload: unknown
}

function isBrowserRpcPayload(value: unknown): value is BrowserRpcPayload {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { endpoint?: unknown }).endpoint === 'string'
    && (value as { endpoint: string }).endpoint.trim() !== ''
    && Object.hasOwn(value, 'payload')
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function registerAuthenticatedRpc(
  connection: HostConnectionHandle,
  path: string,
  method: string,
  handler: ConnectionRpcHandler,
): () => Promise<void> {
  // DSH 0.1.5-rc.1 的自定义 rpc.handle() 会在 Connection 服务的 owner 上访问
  // webServer，第三方插件无法通过自身注入声明满足该内部访问。这里改用公开的精确
  // Fetch Route，把协议挂载到 Connection 已认证的 /api Carrier 下；Host/Origin 与
  // BrowserAuth 仍由 DSH 统一执行，插件不会自行复制或绕过安全门禁。
  const dispose = connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const parsed = clientRequestSchema.safeParse(body)
      if (!parsed.success) return new Response('invalid Connection RPC envelope', { status: 400 })
      const message = parsed.data
      if (message.method !== method || !isBrowserRpcPayload(message.payload)) {
        return jsonResponse({
          type: 'server-response',
          rpcId: message.rpcId,
          result: {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: 'invalid BrowserScope RPC request',
              details: {},
            },
          },
        })
      }

      const result = await handler(
        message.payload.endpoint,
        message.payload.payload,
        request.signal,
      )
      return jsonResponse({
        type: 'server-response',
        rpcId: message.rpcId,
        result,
      })
    },
  })
  return dispose
}
