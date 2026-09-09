import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fail } from './errors.ts'

export interface ArtifactReference {
  artifactId: string
  kind: string
  name: string
  bytes: number
  createdAt: number
}

interface ArtifactRecord extends ArtifactReference {
  path: string
  sessionKey: string
}

function safeName(value: string): string {
  return basename(value).replace(/[^\w.() -]/g, '_') || 'artifact.bin'
}

function safeSession(value: string): string {
  return value.replace(/[^\w.-]/g, '_')
}

export class ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>()
  private sequence = 1

  constructor(
    private readonly root: string,
    private readonly maxBytes: number,
  ) {}

  private async target(sessionKey: string, name: string): Promise<{ artifactId: string; path: string; name: string }> {
    const artifactId = `a${Date.now().toString(36)}-${this.sequence++}`
    const fileName = `${artifactId}-${safeName(name)}`
    const directory = join(this.root, 'sessions', safeSession(sessionKey))
    await mkdir(directory, { recursive: true })
    return { artifactId, path: join(directory, fileName), name: safeName(name) }
  }

  async save(sessionKey: string, kind: string, name: string, data: Uint8Array | string): Promise<ArtifactReference> {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (bytes > this.maxBytes) fail('ARTIFACT_TOO_LARGE', `browser artifact exceeds the configured ${this.maxBytes} byte limit`)
    const target = await this.target(sessionKey, name)
    await writeFile(target.path, data)
    return this.register(sessionKey, kind, target, bytes)
  }

  async saveChunks(sessionKey: string, kind: string, name: string, chunks: readonly (string | Uint8Array)[]): Promise<ArtifactReference> {
    const target = await this.target(sessionKey, name)
    const handle = await open(target.path, 'w')
    let bytes = 0
    try {
      for (const chunk of chunks) {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
        if (bytes > this.maxBytes) fail('ARTIFACT_TOO_LARGE', `browser artifact exceeds the configured ${this.maxBytes} byte limit`)
        if (typeof chunk === 'string') await handle.write(chunk)
        else await handle.write(chunk)
      }
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(target.path, { force: true })
      throw error
    }
    await handle.close()
    return this.register(sessionKey, kind, target, bytes)
  }

  private register(
    sessionKey: string,
    kind: string,
    target: { artifactId: string; path: string; name: string },
    bytes: number,
  ): ArtifactReference {
    const record: ArtifactRecord = {
      artifactId: target.artifactId,
      kind,
      name: target.name,
      bytes,
      createdAt: Date.now(),
      path: target.path,
      sessionKey,
    }
    this.records.set(record.artifactId, record)
    return this.reference(record)
  }

  list(sessionKey: string): ArtifactReference[] {
    return [...this.records.values()]
      .filter(record => record.sessionKey === sessionKey)
      .map(record => this.reference(record))
  }

  async read(sessionKey: string, artifactId: string, maxBytes: number): Promise<{ reference: ArtifactReference; data: Buffer }> {
    const record = this.records.get(artifactId)
    if (record === undefined || record.sessionKey !== sessionKey) fail('UNKNOWN_ARTIFACT', `browser artifact ${JSON.stringify(artifactId)} does not exist in this session`)
    const info = await stat(record.path)
    if (info.size > maxBytes) fail('ARTIFACT_TOO_LARGE', 'browser artifact is too large to read into a tool result')
    return { reference: this.reference(record), data: await readFile(record.path) }
  }

  async removeSession(sessionKey: string): Promise<void> {
    for (const [artifactId, record] of this.records) {
      if (record.sessionKey === sessionKey) this.records.delete(artifactId)
    }
    await rm(join(this.root, 'sessions', safeSession(sessionKey)), { recursive: true, force: true })
  }

  async migrateSession(previousKey: string, nextKey: string): Promise<void> {
    if (previousKey === nextKey) return
    const previousDirectory = join(this.root, 'sessions', safeSession(previousKey))
    const nextDirectory = join(this.root, 'sessions', safeSession(nextKey))
    try {
      await mkdir(join(this.root, 'sessions'), { recursive: true })
      await rename(previousDirectory, nextDirectory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    for (const record of this.records.values()) {
      if (record.sessionKey !== previousKey) continue
      record.sessionKey = nextKey
      record.path = join(nextDirectory, basename(record.path))
    }
  }

  async dispose(): Promise<void> {
    this.records.clear()
  }

  private reference(record: ArtifactRecord): ArtifactReference {
    return {
      artifactId: record.artifactId,
      kind: record.kind,
      name: record.name,
      bytes: record.bytes,
      createdAt: record.createdAt,
    }
  }
}
