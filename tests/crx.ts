import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { chromeWebStoreExtensionId, installChromeWebStorePackage } from '../src/crx.ts'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let current = value
  do {
    let byte = current & 0x7f
    current = Math.floor(current / 128)
    if (current > 0) byte |= 0x80
    bytes.push(byte)
  } while (current > 0)
  return Buffer.from(bytes)
}

function field(number: number, data: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data])
}

function extensionId(bytes: Buffer): string {
  return [...bytes.subarray(0, 16)]
    .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join('')
}

function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x800, 6)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    local.push(localHeader, nameBytes, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x800, 8)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + data.length
  }
  const localData = Buffer.concat(local)
  const centralData = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralData.length, 12)
  end.writeUInt32LE(localData.length, 16)
  return Buffer.concat([localData, centralData, end])
}

function crx3(files: Record<string, string>): { packageData: Buffer; extensionId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  const crxId = createHash('sha256').update(publicDer).digest().subarray(0, 16)
  const signedHeader = field(1, crxId)
  const zipData = zip(files)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedHeader.length)
  const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'ascii'), length, signedHeader, zipData])
  const proof = Buffer.concat([field(1, publicDer), field(2, sign('sha256', signedData, privateKey))])
  const header = Buffer.concat([field(2, proof), field(10000, signedHeader)])
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'ascii')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return { packageData: Buffer.concat([prefix, header, zipData]), extensionId: extensionId(crxId) }
}

async function rejects(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation()
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), `unexpected rejection: ${String(error)}`)
    return
  }
  throw new Error(`operation did not reject with ${String(pattern)}`)
}

const root = resolve('.crx-test')
await rm(root, { recursive: true, force: true })
try {
  const valid = crx3({
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'DSH CRX Fixture', version: '1.0.0', background: { service_worker: 'worker.js' } }),
    'worker.js': 'globalThis.dshCrxFixture = true',
  })
  const installed = await installChromeWebStorePackage(valid.packageData, valid.extensionId, join(root, 'valid'), 'https://chromewebstore.google.com/detail/fixture')
  assert(installed.extensionId === valid.extensionId && installed.name === 'DSH CRX Fixture', 'valid CRX3 metadata was not installed')
  assert(JSON.parse(await readFile(join(root, 'valid', 'manifest.json'), 'utf8')).manifest_version === 3, 'valid CRX3 manifest was not extracted')
  const chromiumPath = resolve('.chromium-acceptance/chromium-1228/chrome-win64/chrome.exe')
  if (existsSync(chromiumPath)) {
    const profile = join(root, 'profile')
    const extensionPath = join(root, 'valid')
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: chromiumPath,
      headless: true,
      serviceWorkers: 'allow',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    try {
      let workers = context.serviceWorkers()
      if (workers.length === 0) workers = [await context.waitForEvent('serviceworker', { timeout: 15000 })]
      assert(workers[0]?.url().startsWith(`chrome-extension://${valid.extensionId}/`) === true, 'unpacked extension runtime ID did not match the signed CRX ID')
    } finally {
      await context.close()
    }
  }

  await rejects(() => installChromeWebStorePackage(valid.packageData, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', join(root, 'wrong-id'), 'https://chromewebstore.google.com/'), /does not match/)

  const traversal = crx3({
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Traversal', version: '1.0.0' }),
    '../escape.txt': 'escape',
  })
  await rejects(() => installChromeWebStorePackage(traversal.packageData, traversal.extensionId, join(root, 'traversal'), 'https://chromewebstore.google.com/'), /path traversal/)
  assert(!existsSync(resolve(root, '..', 'escape.txt')), 'path traversal created a file outside the target')

  const manifestV2 = crx3({ 'manifest.json': JSON.stringify({ manifest_version: 2, name: 'Legacy', version: '1.0.0' }) })
  await rejects(() => installChromeWebStorePackage(manifestV2.packageData, manifestV2.extensionId, join(root, 'manifest-v2'), 'https://chromewebstore.google.com/'), /Manifest V3/)

  assert(chromeWebStoreExtensionId(`https://chromewebstore.google.com/detail/fixture/${valid.extensionId}`) === valid.extensionId, 'Chrome Web Store URL did not resolve the extension ID')
  assert(chromeWebStoreExtensionId(valid.extensionId) === valid.extensionId, 'literal extension ID did not parse')
  try {
    chromeWebStoreExtensionId(`https://example.com/${valid.extensionId}`)
    throw new Error('non-store URL was accepted')
  } catch (error) {
    assert(/Chrome Web Store/.test(error instanceof Error ? error.message : String(error)), 'non-store URL failed with an unexpected error')
  }
  process.stdout.write(`${JSON.stringify({ ok: true, extensionId: valid.extensionId })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
