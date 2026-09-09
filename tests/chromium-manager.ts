import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromiumManager } from '../src/chromium-manager.ts'

const validArchive = Buffer.from('UEsDBBQAAAAIABFqIV3HmaB6DwAAAA0AAAAXAAAAY2hyb21lLXdpbjY0L2Nocm9tZS5leGUrSS0u0U3OKMrPzSzNBQBQSwECFAAUAAAACAARaiFdx5mgeg8AAAANAAAAFwAAAAAAAAAAAAAAgAEAAAAAY2hyb21lLXdpbjY0L2Nocm9tZS5leGVQSwUGAAAAAAEAAQBFAAAARAAAAAAA', 'base64')
const escapeArchive = Buffer.from('UEsDBBQAAAAIABFqIV2OsOglCAAAAAYAAAANAAAALi4vZXNjYXBlLnR4dEstTk4sSAUAUEsBAhQAFAAAAAgAEWohXY6w6CUIAAAABgAAAA0AAAAAAAAAAAAAAIABAAAAAC4uL2VzY2FwZS50eHRQSwUGAAAAAAEAAQA7AAAAMwAAAAAA', 'base64')

interface FixtureResponse {
  status?: number
  body?: Buffer
  delayMs?: number
}

async function fixture(responses: Map<string, FixtureResponse>): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const item = responses.get(request.url ?? '') ?? { status: 404 }
    const send = () => {
      response.writeHead(item.status ?? 200, item.body === undefined ? {} : {
        'content-length': String(item.body.length),
        'content-type': 'application/zip',
      })
      response.end(item.body)
    }
    if ((item.delayMs ?? 0) > 0) setTimeout(send, item.delayMs)
    else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not expose a port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

function descriptor(bytes: number, md5: string) {
  return async () => ({
    revision: 'test',
    browserVersion: 'test',
    platform: 'win64',
    archiveName: 'chrome-win64.zip',
    executableRelativePath: join('chrome-win64', 'chrome.exe'),
    directoryName: 'chromium-test',
    archiveBytes: bytes,
    archiveMd5: md5,
  })
}

async function empty(root: string): Promise<boolean> {
  return !existsSync(root) || (await readdir(root)).length === 0
}

const root = await mkdtemp(join(tmpdir(), 'dsh-browser-tools-chromium-'))
const result = {
  ok: false,
  mirrorInstalled: false,
  staleRevisionIgnored: false,
  fallbackInstalled: false,
  timeoutCleaned: false,
  disposeCancelled: false,
  traversalRejected: false,
}

try {
  const server = await fixture(new Map([
    ['/mirror.zip', { body: validArchive }],
    ['/missing.zip', { status: 404 }],
    ['/official.zip', { body: validArchive }],
    ['/slow.zip', { body: validArchive, delayMs: 1500 }],
    ['/escape.zip', { body: escapeArchive }],
  ]))
  try {
    const mirrorRoot = join(root, 'mirror')
    const staleExecutable = join(mirrorRoot, 'chromium-old', 'chrome-win64', 'chrome.exe')
    await mkdir(join(staleExecutable, '..'), { recursive: true })
    await writeFile(staleExecutable, 'old')
    const mirror = new ChromiumManager(mirrorRoot, {
      source: 'auto',
      timeoutMs: 1000,
      descriptor: descriptor(159, '5bbfa6ef9f45cf0250e81dec1ea65b49'),
      attempts: () => [{ source: 'npmmirror', url: `${server.origin}/mirror.zip`, allowedHosts: ['127.0.0.1'] }],
    })
    assert.deepEqual(await mirror.status(), { installed: false })
    const mirrorExecutable = await mirror.ensureInstalled()
    assert(existsSync(mirrorExecutable))
    assert(mirrorExecutable.includes('chromium-test'))
    assert(existsSync(staleExecutable))
    assert.deepEqual(await mirror.status(), { installed: true, executablePath: mirrorExecutable })
    result.mirrorInstalled = true
    result.staleRevisionIgnored = true

    const fallbackRoot = join(root, 'fallback')
    const fallback = new ChromiumManager(fallbackRoot, {
      source: 'auto',
      timeoutMs: 1000,
      descriptor: descriptor(159, '5bbfa6ef9f45cf0250e81dec1ea65b49'),
      attempts: () => [
        { source: 'npmmirror', url: `${server.origin}/missing.zip`, allowedHosts: ['127.0.0.1'] },
        { source: 'official', url: `${server.origin}/official.zip`, allowedHosts: ['127.0.0.1'] },
      ],
    })
    const fallbackExecutable = await fallback.ensureInstalled()
    assert(existsSync(fallbackExecutable))
    result.fallbackInstalled = true

    const timeoutRoot = join(root, 'timeout')
    const timeout = new ChromiumManager(timeoutRoot, {
      source: 'npmmirror',
      timeoutMs: 1000,
      descriptor: descriptor(159, '5bbfa6ef9f45cf0250e81dec1ea65b49'),
      attempts: () => [{ source: 'npmmirror', url: `${server.origin}/slow.zip`, allowedHosts: ['127.0.0.1'] }],
    })
    await assert.rejects(timeout.ensureInstalled(), /timed out|aborted|installation failed/i)
    assert(await empty(timeoutRoot))
    result.timeoutCleaned = true

    const disposeRoot = join(root, 'dispose')
    const disposable = new ChromiumManager(disposeRoot, {
      source: 'npmmirror',
      timeoutMs: 10000,
      descriptor: descriptor(159, '5bbfa6ef9f45cf0250e81dec1ea65b49'),
      attempts: () => [{ source: 'npmmirror', url: `${server.origin}/slow.zip`, allowedHosts: ['127.0.0.1'] }],
    })
    const pendingInstall = disposable.ensureInstalled()
    await new Promise(resolve => setTimeout(resolve, 50))
    await disposable.dispose()
    await assert.rejects(pendingInstall, /cancelled|aborted|installation failed/i)
    assert(await empty(disposeRoot))
    result.disposeCancelled = true

    const traversalRoot = join(root, 'traversal')
    const traversal = new ChromiumManager(traversalRoot, {
      source: 'npmmirror',
      timeoutMs: 1000,
      descriptor: descriptor(132, 'ccd3d86d60c19a65b4f070d38cd21e65'),
      attempts: () => [{ source: 'npmmirror', url: `${server.origin}/escape.zip`, allowedHosts: ['127.0.0.1'] }],
    })
    await assert.rejects(traversal.ensureInstalled(), /relative path|escapes|installation failed/i)
    assert(await empty(traversalRoot))
    assert(!existsSync(join(root, 'escape.txt')))
    result.traversalRejected = true
    result.ok = true
  } finally {
    await server.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (!result.ok) process.exitCode = 1
