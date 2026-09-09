import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Config, ResolvedConfig } from './types.ts'
import { fail } from './errors.ts'

const DEFAULT_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_DOWNLOAD_BYTES = 100 * 1024 * 1024
const DEFAULT_ARTIFACT_BYTES = 256 * 1024 * 1024

export function resolveConfig(config: Config): ResolvedConfig {
  // 长期浏览器 Profile 必须锚定稳定的 DSH Home；启动工作目录可能随 Workspace 改变，不能作为持久化缓存根目录。
  const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const artifactRoot = resolve(config.artifactRoot ?? join(dshHome, 'browser-tools'))
  return {
    ...(config.executablePath === undefined ? {} : { executablePath: resolve(config.executablePath) }),
    headless: config.headless ?? true,
    allowedOrigins: new Set((config.allowedOrigins ?? []).map(value => new URL(value).origin)),
    // 完整 V2 按用户决策允许公网、本机与局域网导航；配置项仍可显式关闭对应范围。
    allowLoopback: config.allowLoopback ?? true,
    allowPrivateNetwork: config.allowPrivateNetwork ?? true,
    uploadRoots: (config.uploadRoots ?? [process.cwd()]).map(value => resolve(value)),
    artifactRoot,
    maxUploadBytes: config.maxUploadBytes ?? DEFAULT_UPLOAD_BYTES,
    maxDownloadBytes: config.maxDownloadBytes ?? DEFAULT_DOWNLOAD_BYTES,
    maxArtifactBytes: config.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES,
    maxOutputChars: config.maxOutputChars ?? 12000,
    interceptionTimeoutMs: config.interceptionTimeoutMs ?? 15000,
    externalCdpTimeoutMs: config.externalCdpTimeoutMs ?? 15000,
    chromiumDownloadSource: config.chromiumDownloadSource ?? 'auto',
    chromiumDownloadTimeoutMs: config.chromiumDownloadTimeoutMs ?? 300000,
    subagentInteractive: config.subagentInteractive ?? false,
    toolRegistrationMode: config.toolRegistrationMode ?? 'global',
    sessionController: {
      defaultMode: config.sessionController?.defaultMode ?? 'other',
      conflictingToolPatterns: config.sessionController?.conflictingToolPatterns ?? [
        '^browser_',
        '^chrome_',
        '^pilot_',
        '^mcp__playwright__',
        '^mcp__chrome_devtools__',
      ],
      excludeTools: [...(config.sessionController?.excludeTools ?? [])],
      includeTools: [...(config.sessionController?.includeTools ?? [])],
    },
    controllerStorageRoot: join(dshHome, 'browser-tools', 'controller', 'sessions'),
    ...(config.sharedProfileSeedSessionId?.trim()
      ? { sharedProfileSeedSessionId: config.sharedProfileSeedSessionId.trim() }
      : {}),
  }
}

export function assertCdpEndpoint(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    fail('POLICY_DENIED', 'external CDP endpoint is invalid', error)
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) fail('POLICY_DENIED', `external CDP protocol ${url.protocol} is not allowed`)
  if (url.username !== '' || url.password !== '') fail('POLICY_DENIED', 'credentials in external CDP endpoints are not allowed')
  return url
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value))) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function assertUrlAllowed(config: ResolvedConfig, value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    fail('POLICY_DENIED', 'browser URL is invalid', error)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('POLICY_DENIED', `browser protocol ${url.protocol} is not allowed`)
  if (url.username !== '' || url.password !== '') fail('POLICY_DENIED', 'credentials in browser URLs are not allowed')
  if (config.allowedOrigins.size > 0 && !config.allowedOrigins.has(url.origin)) fail('POLICY_DENIED', `browser origin ${url.origin} is not allowed`)
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.')
  if (loopback && !config.allowLoopback) fail('POLICY_DENIED', 'loopback browser targets are disabled')
  if (!loopback && isIP(host) !== 0 && isPrivateIpv4(host) && !config.allowPrivateNetwork) fail('POLICY_DENIED', 'private-network browser targets are disabled')
  return url
}

export function assertUploadPath(config: ResolvedConfig, value: string): string {
  const target = resolve(value)
  if (!isAbsolute(target)) fail('POLICY_DENIED', 'upload path must resolve to an absolute path')
  const allowed = config.uploadRoots.some(root => {
    const child = relative(root, target)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  })
  if (!allowed) fail('POLICY_DENIED', 'upload path is outside configured roots')
  return target
}

export function redactUrl(value: string): string {
  const url = new URL(value)
  for (const key of url.searchParams.keys()) {
    if (/token|key|code|auth|session|secret|password/i.test(key)) url.searchParams.set(key, '[REDACTED]')
  }
  return url.href
}
