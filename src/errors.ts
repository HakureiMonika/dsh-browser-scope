import { HarnessError } from '@deepseek-ai/dsh-llm'

export class BrowserError extends HarnessError {}

export function fail(code: string, message: string, cause?: unknown): never {
  throw new BrowserError(message, code, cause === undefined ? undefined : { cause })
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('browser operation aborted', 'AbortError')
}

export function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}
