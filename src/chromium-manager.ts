import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { open } from 'yauzl-promise'
import type { ChromiumDownloadSource } from './types.ts'

const require = createRequire(import.meta.url)
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 20000
const MAX_REDIRECTS = 5
const KNOWN_ARCHIVES = new Map([
  ['149.0.7827.55/win64', { bytes: 192511857, md5: '9e81f0a217403ab3d8f2db6c42fd86c1' }],
])

interface ChromiumDescriptor {
  revision: string
  browserVersion: string
  platform: string
  archiveName: string
  executableRelativePath: string
  directoryName: string
  archiveBytes: number
  archiveMd5: string
}

interface DownloadAttempt {
  source: Exclude<ChromiumDownloadSource, 'auto'>
  url: string
  allowedHosts: readonly string[]
}

interface ChromiumManagerOptions {
  source: ChromiumDownloadSource
  timeoutMs: number
  attempts?: (descriptor: ChromiumDescriptor) => DownloadAttempt[]
  descriptor?: () => Promise<ChromiumDescriptor>
}

interface PlaywrightBrowsersManifest {
  browsers?: Array<{ name?: string; revision?: string; browserVersion?: string }>
}

async function descriptor(): Promise<ChromiumDescriptor> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error(`managed Chromium installation is not supported on ${process.platform}/${process.arch}`)
  const packagePath = require.resolve('playwright-core/package.json')
  const manifest = JSON.parse(await readFile(join(dirname(packagePath), 'browsers.json'), 'utf8')) as PlaywrightBrowsersManifest
  const chromium = manifest.browsers?.find(item => item.name === 'chromium')
  if (chromium?.revision === undefined || chromium.browserVersion === undefined) throw new Error('playwright-core Chromium metadata is unavailable')
  const platform = 'win64'
  const integrity = KNOWN_ARCHIVES.get(`${chromium.browserVersion}/${platform}`)
  if (integrity === undefined) throw new Error(`Chromium ${chromium.browserVersion} does not have verified archive metadata`)
  return {
    revision: chromium.revision,
    browserVersion: chromium.browserVersion,
    platform,
    archiveName: 'chrome-win64.zip',
    executableRelativePath: join('chrome-win64', 'chrome.exe'),
    directoryName: `chromium-${chromium.revision}`,
    archiveBytes: integrity.bytes,
    archiveMd5: integrity.md5,
  }
}

function defaultAttempts(source: ChromiumDownloadSource, value: ChromiumDescriptor): DownloadAttempt[] {
  const mirror: DownloadAttempt = {
    source: 'npmmirror',
    url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${value.browserVersion}/${value.platform}/${value.archiveName}`,
    allowedHosts: ['cdn.npmmirror.com'],
  }
  const official: DownloadAttempt = {
    source: 'official',
    url: `https://cdn.playwright.dev/builds/cft/${value.browserVersion}/${value.platform}/${value.archiveName}`,
    allowedHosts: ['cdn.playwright.dev', 'storage.googleapis.com'],
  }
  if (source === 'npmmirror') return [mirror]
  if (source === 'official') return [official]
  return [mirror, official]
}

async function findExecutable(root: string, directoryName?: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined
  const directories = await readdir(root, { withFileTypes: true })
  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith('chromium-')) continue
    if (directoryName !== undefined && directory.name !== directoryName) continue
    const candidates = [
      join(root, directory.name, 'chrome-win64', 'chrome.exe'),
      join(root, directory.name, 'chrome-win', 'chrome.exe'),
    ]
    const executable = candidates.find(existsSync)
    if (executable !== undefined) return executable
  }
  return undefined
}

async function removeIncompleteChromium(root: string): Promise<void> {
  if (!existsSync(root)) return
  const directories = await readdir(root, { withFileTypes: true })
  await Promise.all(directories.map(async directory => {
    if (!directory.isDirectory() || (!directory.name.startsWith('chromium-') && !directory.name.startsWith('.install-'))) return
    const path = join(root, directory.name)
    if (directory.name.startsWith('.install-')) {
      await rm(path, { recursive: true, force: true })
      return
    }
    const executable = await findExecutable(root, directory.name)
    if (executable === undefined) await rm(path, { recursive: true, force: true })
  }))
  const files = await readdir(root, { withFileTypes: true })
  await Promise.all(files.map(async file => {
    if (file.isFile() && file.name.startsWith('.download-') && file.name.endsWith('.zip')) await rm(join(root, file.name), { force: true })
  }))
}

async function downloadArchive(attempt: DownloadAttempt, target: string, value: ChromiumDescriptor, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Chromium download timed out after ${timeoutMs}ms`)), timeoutMs)
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    let url = attempt.url
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      // 下载地址只能来自内置来源模板；每次重定向重新校验主机，避免受信 CDN 把插件带到任意第三方地址。
      const parsedUrl = new URL(url)
      if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1') throw new Error(`Chromium download from ${attempt.source} requires HTTPS`)
      if (!attempt.allowedHosts.includes(parsedUrl.hostname)) throw new Error(`Chromium download from ${attempt.source} redirected to an untrusted host`)
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || redirect === MAX_REDIRECTS) throw new Error(`Chromium download redirect limit exceeded for ${attempt.source}`)
        url = new URL(location, url).href
        continue
      }
      if (!response.ok || response.body === null) throw new Error(`Chromium download from ${attempt.source} failed with HTTP ${response.status}`)
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new Error(`Chromium archive from ${attempt.source} exceeds the download limit`)
      const hash = createHash('md5')
      let bytes = 0
      // 同时限制流式下载大小并计算官方归档响应头确认的固定摘要；ZIP 条目在解压阶段还会独立执行 CRC32 校验。
      const meter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, transformController) {
          bytes += chunk.byteLength
          if (bytes > MAX_ARCHIVE_BYTES) throw new Error(`Chromium archive from ${attempt.source} exceeds the download limit`)
          hash.update(chunk)
          transformController.enqueue(chunk)
        },
      })
      await pipeline(response.body.pipeThrough(meter), createWriteStream(target, { flags: 'wx' }))
      if (bytes !== value.archiveBytes) throw new Error(`Chromium archive from ${attempt.source} has unexpected size ${bytes}`)
      const digest = hash.digest('hex')
      if (digest !== value.archiveMd5) throw new Error(`Chromium archive from ${attempt.source} failed integrity verification`)
      return
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function entryMode(externalFileAttributes: number): number {
  return (externalFileAttributes >>> 16) & 0xffff
}

async function extractArchive(archive: string, target: string, value: ChromiumDescriptor): Promise<void> {
  const zip = await open(archive, { strictFilenames: true, validateEntrySizes: true, validateFilenames: true, supportMacArchive: false })
  let entries = 0
  let extractedBytes = 0
  try {
    for await (const entry of zip) {
      entries += 1
      if (entries > MAX_ENTRIES) throw new Error('Chromium archive contains too many entries')
      if (entry.isEncrypted()) throw new Error(`Chromium archive entry ${entry.filename} is encrypted`)
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Chromium archive entry ${entry.filename} exceeds the file limit`)
      extractedBytes += entry.uncompressedSize
      if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Chromium archive exceeds the extracted size limit')
      const mode = entryMode(entry.externalFileAttributes)
      const fileType = mode & 0xf000
      // Chrome for Testing 归档只应包含普通文件和目录；拒绝符号链接与设备文件，防止解压后越过受管目录。
      if (fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000) throw new Error(`Chromium archive entry ${entry.filename} has an unsupported file type`)
      const output = resolve(target, ...entry.filename.split('/').filter(Boolean))
      const child = relative(target, output)
      if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error(`Chromium archive entry ${entry.filename} escapes the install directory`)
      if (entry.filename.endsWith('/')) {
        await mkdir(output, { recursive: true })
        continue
      }
      await mkdir(dirname(output), { recursive: true })
      await pipeline(await entry.openReadStream(), createWriteStream(output, { flags: 'wx' }))
    }
  } finally {
    await zip.close()
  }
  const executable = join(target, value.executableRelativePath)
  const info = await stat(executable).catch(() => undefined)
  if (info?.isFile() !== true || info.size === 0) throw new Error('Chromium archive does not contain a usable executable')
}

export class ChromiumManager {
  private installation?: Promise<string>
  private readonly lifecycle = new AbortController()
  private disposed = false
  private readonly root: string
  private readonly options: ChromiumManagerOptions

  constructor(root: string, options: ChromiumManagerOptions) {
    this.root = root
    this.options = options
  }

  async status(): Promise<{ installed: boolean; executablePath?: string }> {
    // 状态查询不能因为当前平台不支持自动安装而破坏 Provider 面板；真正触发安装时再返回明确的不支持错误。
    const value = await (this.options.descriptor?.() ?? descriptor()).catch(() => undefined)
    if (value === undefined) return { installed: false }
    const executablePath = await findExecutable(this.root, value.directoryName)
    return executablePath === undefined ? { installed: false } : { installed: true, executablePath }
  }

  async ensureInstalled(): Promise<string> {
    if (this.disposed) throw new Error('Chromium manager is disposed')
    const value = await (this.options.descriptor?.() ?? descriptor())
    const existing = await findExecutable(this.root, value.directoryName)
    if (existing !== undefined) return existing
    if (this.installation !== undefined) return this.installation
    this.installation = this.install(value).finally(() => {
      this.installation = undefined
    })
    return this.installation
  }

  private async install(value: ChromiumDescriptor): Promise<string> {
    await mkdir(this.root, { recursive: true })
    await removeIncompleteChromium(this.root)
    const attempts = this.options.attempts?.(value) ?? defaultAttempts(this.options.source, value)
    const nonce = `${process.pid}-${Date.now().toString(36)}`
    const archive = join(this.root, `.download-${nonce}.zip`)
    const staging = join(this.root, `.install-${nonce}`)
    const destination = join(this.root, value.directoryName)
    const errors: string[] = []
    try {
      for (const attempt of attempts) {
        try {
          await rm(archive, { force: true })
          await downloadArchive(attempt, archive, value, this.options.timeoutMs, this.lifecycle.signal)
          await extractArchive(archive, staging, value)
          await rm(destination, { recursive: true, force: true })
          await rename(staging, destination)
          const executable = join(destination, value.executableRelativePath)
          if (!existsSync(executable)) throw new Error('Chromium installation completed without an executable')
          return executable
        } catch (error) {
          errors.push(`${attempt.source}: ${error instanceof Error ? error.message : String(error)}`)
          await rm(archive, { force: true })
          await rm(staging, { recursive: true, force: true })
        }
      }
      throw new Error(`Chromium installation failed: ${errors.join('; ')}`)
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
      await removeIncompleteChromium(this.root)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    // 生命周期信号在管理器创建时就存在，确保卸载发生在安装任务任何阶段都能阻止后续网络请求并触发统一清理。
    this.lifecycle.abort(new Error('Chromium download was cancelled because the plugin is stopping'))
    await this.installation?.catch(() => {})
  }
}
