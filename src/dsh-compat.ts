import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown>

interface CompatibleHostConnectionRpc {
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: { readonly authority: 'loopback' },
  ): unknown
}

export function registerLoopbackRpc(
  connection: HostConnectionHandle,
  channel: string,
  handler: ConnectionRpcHandler,
): void {
  // 旧RC通过第三参数执行Loopback信任校验；alpha1的JavaScript实现会忽略多余实参，并继续由统一BrowserAuth执行认证。
  const rpc = connection.rpc as unknown as CompatibleHostConnectionRpc
  rpc.handle(channel, handler, { authority: 'loopback' })
}
