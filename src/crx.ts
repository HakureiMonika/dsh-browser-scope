import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative } from 'node:path'
import { inflateRaw as inflateRawCallback } from 'node:zlib'
import { chromium } from 'playwright-core'

const MAX_CRX_BYTES = 64 * 1024 * 1024
const MAX_FILES = 4096
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const CRX3_CONTEXT = Buffer.from('CRX3 SignedData\0', 'ascii')

interface CrxPackage {
  extensionId: string
  publicKey: Buffer
  zip: Buffer
}

interface ProtoField {
  number: number
  wireType: number
  data?: Buffer
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  flags: number
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset++] as number
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: offset }
    shift += 7
  }
  throw new Error('CRX protobuf contains an invalid varint')
}

function protoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset)
    offset = key.next
    const number = Math.floor(key.value / 8)
    const wireType = key.value & 7
    if (wireType === 0) {
      const value = readVarint(buffer, offset)
      offset = value.next
      fields.push({ number, wireType })
      continue
    }
    if (wireType === 2) {
      const length = readVarint(buffer, offset)
      offset = length.next
      const end = offset + length.value
      if (end > buffer.length) throw new Error('CRX protobuf field exceeds its container')
      fields.push({ number, wireType, data: buffer.subarray(offset, end) })
      offset = end
      continue
    }
    if (wireType === 1) offset += 8
    else if (wireType === 5) offset += 4
    else throw new Error(`CRX protobuf wire type ${wireType} is not supported`)
    if (offset > buffer.length) throw new Error('CRX protobuf field exceeds its container')
    fields.push({ number, wireType })
  }
  return fields
}

function extensionIdFromBytes(bytes: Buffer): string {
  return [...bytes.subarray(0, 16)]
    .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join('')
}

function extensionIdFromPublicKey(publicKey: Buffer): string {
  return extensionIdFromBytes(createHash('sha256').update(publicKey).digest())
}

function parseCrx2(buffer: Buffer, expectedId: string): CrxPackage {
  if (buffer.length < 16) throw new Error('CRX2 header is incomplete')
  const publicKeyLength = buffer.readUInt32LE(8)
  const signatureLength = buffer.readUInt32LE(12)
  const zipOffset = 16 + publicKeyLength + signatureLength
  if (zipOffset >= buffer.length) throw new Error('CRX2 payload is incomplete')
  const publicKey = buffer.subarray(16, 16 + publicKeyLength)
  const signature = buffer.subarray(16 + publicKeyLength, zipOffset)
  const zip = buffer.subarray(zipOffset)
  const extensionId = extensionIdFromPublicKey(publicKey)
  if (extensionId !== expectedId) throw new Error('CRX2 public key does not match the requested extension ID')
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
  if (!verify('sha1', zip, key, signature)) throw new Error('CRX2 signature verification failed')
  return { extensionId, publicKey, zip }
}

function parseCrx3(buffer: Buffer, expectedId: string): CrxPackage {
  if (buffer.length < 12) throw new Error('CRX3 header is incomplete')
  const headerLength = buffer.readUInt32LE(8)
  const headerEnd = 12 + headerLength
  if (headerEnd >= buffer.length) throw new Error('CRX3 payload is incomplete')
  const header = buffer.subarray(12, headerEnd)
  const zip = buffer.subarray(headerEnd)
  const fields = protoFields(header)
  const signedHeader = fields.find(field => field.number === 10000 && field.data !== undefined)?.data
  if (signedHeader === undefined) throw new Error('CRX3 signed header is missing')
  const crxId = protoFields(signedHeader).find(field => field.number === 1 && field.data !== undefined)?.data
  if (crxId === undefined || crxId.length !== 16) throw new Error('CRX3 extension ID is invalid')
  const extensionId = extensionIdFromBytes(crxId)
  if (extensionId !== expectedId) throw new Error('CRX3 signed ID does not match the requested extension ID')
  const signedLength = Buffer.allocUnsafe(4)
  signedLength.writeUInt32LE(signedHeader.length)
  const signedData = Buffer.concat([CRX3_CONTEXT, signedLength, signedHeader, zip])
  const proofFields = fields.filter(field => (field.number === 2 || field.number === 3) && field.data !== undefined)
  let verifiedPublicKey: Buffer | undefined
  const valid = proofFields.some((proof) => {
    try {
      const nested = protoFields(proof.data as Buffer)
      const publicKey = nested.find(field => field.number === 1 && field.data !== undefined)?.data
      const signature = nested.find(field => field.number === 2 && field.data !== undefined)?.data
      if (publicKey === undefined || signature === undefined) return false
      if (extensionIdFromPublicKey(publicKey) !== extensionId) return false
      const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
      const validProof = verify('sha256', signedData, key, signature)
      if (validProof) verifiedPublicKey = publicKey
      return validProof
    } catch {
      return false
    }
  })
  if (!valid) throw new Error('CRX3 signature verification failed')
  if (verifiedPublicKey === undefined) throw new Error('CRX3 verified public key is missing')
  return { extensionId, publicKey: verifiedPublicKey, zip }
}

function parseCrx(buffer: Buffer, expectedId: string): CrxPackage {
  if (buffer.length > MAX_CRX_BYTES) throw new Error(`extension package exceeds ${MAX_CRX_BYTES} bytes`)
  if (buffer.subarray(0, 4).toString('ascii') !== 'Cr24') throw new Error('extension package is not a CRX file')
  const version = buffer.readUInt32LE(4)
  if (version === 2) return parseCrx2(buffer, expectedId)
  if (version === 3) return parseCrx3(buffer, expectedId)
  throw new Error(`CRX version ${version} is not supported`)
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimum = Math.max(0, zip.length - 65557)
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('ZIP central directory was not found')
}

function zipEntries(zip: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(zip)
  const count = zip.readUInt16LE(end + 10)
  const centralSize = zip.readUInt32LE(end + 12)
  const centralOffset = zip.readUInt32LE(end + 16)
  if (count > MAX_FILES) throw new Error(`extension archive contains more than ${MAX_FILES} files`)
  if (centralOffset + centralSize > zip.length) throw new Error('ZIP central directory exceeds the package')
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let offset = centralOffset
  let unpacked = 0
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid')
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const externalAttributes = zip.readUInt32LE(offset + 38)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString((flags & 0x800) === 0 ? 'latin1' : 'utf8').replaceAll('\\', '/')
    if ((flags & 1) !== 0) throw new Error('encrypted extension archives are not supported')
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not supported`)
    if (name === '' || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('extension archive contains an absolute path')
    const normalized = normalize(name).replaceAll('\\', '/')
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('extension archive contains a path traversal entry')
    if (names.has(normalized)) throw new Error('extension archive contains duplicate entries')
    names.add(normalized)
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0o170000) === 0o120000) throw new Error('extension archive contains a symbolic link')
    unpacked += uncompressedSize
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error(`extension archive exceeds ${MAX_UNPACKED_BYTES} unpacked bytes`)
    entries.push({ name: normalized, method, compressedSize, uncompressedSize, localOffset, externalAttributes, flags })
    offset += 46 + nameLength + extraLength + commentLength
    if (offset > centralOffset + centralSize) throw new Error('ZIP central directory entry exceeds its container')
  }
  return entries
}

async function inflateRaw(data: Buffer, maximumBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    inflateRawCallback(data, { maxOutputLength: Math.max(maximumBytes, 1) }, (error, result) => {
      if (error !== null) reject(error)
      else resolve(result)
    })
  })
}

async function extractZip(zip: Buffer, target: string): Promise<void> {
  const entries = zipEntries(zip)
  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    const destination = join(target, entry.name)
    const child = relative(target, destination)
    if (child.startsWith('..') || child === '') throw new Error('extension archive entry escapes the target directory')
    if (entry.name.endsWith('/')) {
      await mkdir(destination, { recursive: true })
      continue
    }
    if (zip.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('ZIP local file header is invalid')
    const localNameLength = zip.readUInt16LE(entry.localOffset + 26)
    const localExtraLength = zip.readUInt16LE(entry.localOffset + 28)
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + entry.compressedSize
    if (dataEnd > zip.length) throw new Error('ZIP file data exceeds the package')
    const compressed = zip.subarray(dataOffset, dataEnd)
    const data = entry.method === 0 ? compressed : await inflateRaw(compressed, entry.uncompressedSize)
    if (data.length !== entry.uncompressedSize) throw new Error('ZIP uncompressed size does not match the central directory')
    await mkdir(dirname(destination), { recursive: true })
    const handle = await open(destination, 'wx')
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
  }
}

export function chromeWebStoreExtensionId(value: string): string {
  const trimmed = value.trim()
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('extension input must be a Chrome Web Store URL or a 32-character extension ID')
  }
  if (url.protocol !== 'https:' || !/^(chromewebstore\.google\.com|chrome\.google\.com)$/.test(url.hostname)) throw new Error('extension URL must come from the Chrome Web Store')
  const extensionId = url.pathname.split('/').findLast(segment => /^[a-p]{32}$/.test(segment))
  if (extensionId === undefined) throw new Error('Chrome Web Store URL does not contain an extension ID')
  return extensionId
}

export async function installChromeWebStorePackage(packageData: Buffer, extensionId: string, target: string, sourceUrl: string): Promise<{ extensionId: string; name: string; version: string; sourceUrl: string }> {
  const crx = parseCrx(packageData, extensionId)
  await rm(target, { recursive: true, force: true })
  try {
    await extractZip(crx.zip, target)
    const manifestPath = join(target, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    if (manifest.manifest_version !== 3) throw new Error('only Manifest V3 extensions are supported')
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '') throw new Error('extension manifest name is missing')
    if (typeof manifest.version !== 'string' || manifest.version.trim() === '') throw new Error('extension manifest version is missing')
    if (typeof manifest.key === 'string') {
      let manifestPublicKey: Buffer
      try {
        manifestPublicKey = Buffer.from(manifest.key, 'base64')
      } catch {
        throw new Error('extension manifest key is invalid')
      }
      if (extensionIdFromPublicKey(manifestPublicKey) !== extensionId) throw new Error('extension manifest key does not match the signed extension ID')
    } else {
      // 解包目录通过 --load-extension 加载时由 manifest.key 决定稳定扩展 ID；使用已通过 CRX 签名验证的公钥补齐，不信任外部另传公钥。
      manifest.key = crx.publicKey.toString('base64')
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
    let name = manifest.name
    const localized = /^__MSG_(.+)__$/.exec(name)
    if (localized !== null) {
      const localeCandidates = [manifest.default_locale, 'zh_CN', 'zh_TW', 'en']
        .filter((locale): locale is string => typeof locale === 'string' && /^[A-Za-z0-9_-]+$/.test(locale))
      for (const locale of [...new Set(localeCandidates)]) {
        try {
          const messages = JSON.parse(await readFile(join(target, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, { message?: unknown }>
          const message = messages[localized[1] as string]?.message
          if (typeof message === 'string' && message.trim() !== '') {
            name = message.trim()
            break
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    await writeFile(join(target, '.dsh-extension.json'), `${JSON.stringify({ extensionId, sourceUrl }, null, 2)}\n`, 'utf8')
    const action = typeof manifest.action === 'object' && manifest.action !== null ? manifest.action as Record<string, unknown> : undefined
    const browserAction = typeof manifest.browser_action === 'object' && manifest.browser_action !== null ? manifest.browser_action as Record<string, unknown> : undefined
    const actionPopup = typeof action?.default_popup === 'string'
      ? action.default_popup.trim()
      : typeof browserAction?.default_popup === 'string'
        ? browserAction.default_popup.trim()
        : ''
    return { extensionId, name, version: manifest.version, sourceUrl, ...(actionPopup === '' ? {} : { actionPopup }) }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

async function boundedResponseBody(response: Response): Promise<Buffer> {
  if (response.body === null) throw new Error('Chrome Web Store returned an empty response body')
  const chunks: Buffer[] = []
  let bytes = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_CRX_BYTES) throw new Error(`extension package exceeds ${MAX_CRX_BYTES} bytes`)
      chunks.push(Buffer.from(next.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytes)
}

async function downloadWithChromium(sourceUrl: string, executablePath: string): Promise<Buffer> {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const session = await context.newCDPSession(page)
    try {
      const frameTree = await session.send('Page.getFrameTree')
      const loaded = await session.send('Network.loadNetworkResource', {
        frameId: frameTree.frameTree.frame.id,
        url: sourceUrl,
        options: { disableCache: true, includeCredentials: false },
      })
      const resource = loaded.resource
      if (!resource.success || resource.stream === undefined) {
        throw new Error(`Chrome Web Store Chromium request failed: ${resource.netErrorName ?? resource.httpStatusCode ?? resource.netError ?? 'unknown error'}`)
      }
      const chunks: Buffer[] = []
      let bytes = 0
      let eof = false
      try {
        while (!eof) {
          const part = await session.send('IO.read', { handle: resource.stream, size: 1024 * 1024 })
          const chunk = part.base64Encoded === true ? Buffer.from(part.data, 'base64') : Buffer.from(part.data)
          bytes += chunk.byteLength
          if (bytes > MAX_CRX_BYTES) throw new Error(`extension package exceeds ${MAX_CRX_BYTES} bytes`)
          chunks.push(chunk)
          eof = part.eof === true
        }
      } finally {
        await session.send('IO.close', { handle: resource.stream }).catch(() => {})
      }
      return Buffer.concat(chunks, bytes)
    } finally {
      await session.detach().catch(() => {})
      await context.close().catch(() => {})
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function downloadChromeWebStoreExtension(input: string, target: string, chromiumExecutablePath?: string): Promise<{ extensionId: string; name: string; version: string; sourceUrl: string; actionPopup?: string }> {
  const extensionId = chromeWebStoreExtensionId(input)
  const query = `response=redirect&prodversion=149.0.7827.55&acceptformat=crx3&x=${encodeURIComponent(`id=${extensionId}&installsource=ondemand&uc`)}`
  const sources = [
    `https://update.googleapis.com/service/update2/crx?${query}`,
    `https://clients2.google.com/service/update2/crx?${query}`,
  ]
  let lastError: unknown
  for (const sourceUrl of sources) {
    try {
      const response = await fetch(sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error(`Chrome Web Store returned HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(length) && length > MAX_CRX_BYTES) throw new Error(`extension package exceeds ${MAX_CRX_BYTES} bytes`)
      const packageData = await boundedResponseBody(response)
      return await installChromeWebStorePackage(packageData, extensionId, target, sourceUrl)
    } catch (error) {
      lastError = error
    }
  }
  if (chromiumExecutablePath !== undefined) {
    for (const sourceUrl of sources) {
      try {
        return await installChromeWebStorePackage(await downloadWithChromium(sourceUrl, chromiumExecutablePath), extensionId, target, sourceUrl)
      } catch (error) {
        lastError = error
      }
    }
  }
  throw new Error('无法连接 Chrome Web Store 官方扩展更新源，请检查当前网络或代理配置。', { cause: lastError })
}
