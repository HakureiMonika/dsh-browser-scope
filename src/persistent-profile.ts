import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface BrowserExtensionRecord {
  extensionId: string
  name: string
  version: string
  enabled: boolean
  installedAt: number
  sourceUrl: string
  path: string
  actionPopup?: string
}

interface BrowserExtensionRegistry {
  version: 1
  extensions: BrowserExtensionRecord[]
}

export type BrowserSplitViewOrientation = 'top-bottom' | 'left-right'

interface BrowserSplitViewPreferenceV1 {
  version: 1
  ratio: number
}

interface BrowserSplitViewPreferenceV2 {
  version: 2
  ratio: number
  orientation: BrowserSplitViewOrientation
}

export interface BrowserSplitViewPreference {
  ratio: number
  orientation: BrowserSplitViewOrientation
}

function profileSegment(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

function validProfileName(profileName: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profileName)) throw new Error('persistent profileName contains unsupported characters')
  return profileName
}

export class PersistentProfileStore {
  constructor(private readonly root: string) {}

  sharedProfilePath(): string {
    return join(this.root, 'profiles', 'shared', 'default')
  }

  profilePath(sessionId: string, profileName = 'default'): string {
    return join(this.root, 'profiles', 'sessions', profileSegment(sessionId), validProfileName(profileName))
  }

  extensionDirectory(sessionId: string, extensionId: string): string {
    return join(this.root, 'extensions', 'sessions', profileSegment(sessionId), 'packages', extensionId, `${Date.now().toString(36)}-${process.pid}`)
  }

  extensionStagingDirectory(sessionId: string, extensionId: string): string {
    return join(this.root, 'extensions', 'staging', profileSegment(sessionId), `${extensionId}-${Date.now().toString(36)}`)
  }

  sharedExtensionDirectory(extensionId: string): string {
    return join(this.root, 'extensions', 'shared', 'packages', extensionId, `${Date.now().toString(36)}-${process.pid}`)
  }

  sharedExtensionStagingDirectory(extensionId: string): string {
    return join(this.root, 'extensions', 'staging', 'shared', `${extensionId}-${Date.now().toString(36)}`)
  }

  chromiumPath(): string {
    return join(this.root, 'chromium')
  }

  private registryPath(sessionId: string): string {
    return join(this.root, 'extensions', 'sessions', profileSegment(sessionId), 'registry.json')
  }

  private sharedRegistryPath(): string {
    return join(this.root, 'extensions', 'shared', 'registry.json')
  }

  private sharedMigrationMarkerPath(): string {
    return join(this.root, 'profiles', 'shared', '.seed-migration.json')
  }

  private splitViewPreferencePath(sessionId: string): string {
    return join(this.root, 'layout', 'sessions', profileSegment(sessionId), 'split-view.json')
  }

  async splitViewPreference(sessionId: string): Promise<BrowserSplitViewPreference> {
    try {
      const parsed = JSON.parse(await readFile(this.splitViewPreferencePath(sessionId), 'utf8')) as Partial<BrowserSplitViewPreferenceV1 | BrowserSplitViewPreferenceV2>
      if (typeof parsed.ratio !== 'number' || !Number.isFinite(parsed.ratio)) return { ratio: 0.5, orientation: 'top-bottom' }
      const ratio = Math.min(Math.max(parsed.ratio, 0.4), 0.6)
      // v1 只保存上下分屏比例；升级时默认保留原有视觉方向，不要求用户迁移或重建 Session。
      if (parsed.version === 1) return { ratio, orientation: 'top-bottom' }
      if (parsed.version === 2 && (parsed.orientation === 'top-bottom' || parsed.orientation === 'left-right')) return { ratio, orientation: parsed.orientation }
      return { ratio: 0.5, orientation: 'top-bottom' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ratio: 0.5, orientation: 'top-bottom' }
      throw error
    }
  }

  async saveSplitViewPreference(sessionId: string, preference: BrowserSplitViewPreference): Promise<void> {
    const path = this.splitViewPreferencePath(sessionId)
    const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
    const backup = `${path}.bak-${process.pid}-${Date.now().toString(36)}`
    await mkdir(join(path, '..'), { recursive: true })
    // 布局偏好只保存稳定比例与排列方向，不保存会随 BrowserContext 重建失效的 viewId、URL 或控制权状态。
    await writeFile(temporary, `${JSON.stringify({ version: 2, ratio: preference.ratio, orientation: preference.orientation }, null, 2)}\n`, 'utf8')
    try {
      await rename(path, backup).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await rename(temporary, path)
      await rm(backup, { force: true })
    } catch (error) {
      await rm(temporary, { force: true })
      if (await readFile(path).then(() => false, () => true)) await rename(backup, path).catch(() => {})
      throw error
    }
  }

  async listExtensions(sessionId: string): Promise<BrowserExtensionRecord[]> {
    return this.readExtensions(this.registryPath(sessionId))
  }

  async listSharedExtensions(): Promise<BrowserExtensionRecord[]> {
    return this.readExtensions(this.sharedRegistryPath())
  }

  private async readExtensions(path: string): Promise<BrowserExtensionRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<BrowserExtensionRegistry>
      if (parsed.version !== 1 || !Array.isArray(parsed.extensions)) return []
      const extensions = parsed.extensions.filter((item): item is BrowserExtensionRecord => {
        return typeof item?.extensionId === 'string'
          && typeof item.name === 'string'
          && typeof item.version === 'string'
          && typeof item.enabled === 'boolean'
          && typeof item.installedAt === 'number'
          && typeof item.sourceUrl === 'string'
          && typeof item.path === 'string'
      })
      // 旧登记文件没有Popup元数据；从插件受管目录的Manifest按需补齐，不要求用户重装扩展或迁移registry版本。
      return Promise.all(extensions.map(async extension => {
        if (typeof extension.actionPopup === 'string' && extension.actionPopup.trim() !== '') return extension
        try {
          const manifest = JSON.parse(await readFile(join(extension.path, 'manifest.json'), 'utf8')) as { action?: { default_popup?: unknown }; browser_action?: { default_popup?: unknown } }
          const popup = typeof manifest.action?.default_popup === 'string'
            ? manifest.action.default_popup.trim()
            : typeof manifest.browser_action?.default_popup === 'string'
              ? manifest.browser_action.default_popup.trim()
              : ''
          return popup === '' ? extension : { ...extension, actionPopup: popup }
        } catch {
          return extension
        }
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async saveExtensions(sessionId: string, extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    await this.writeExtensions(this.registryPath(sessionId), extensions)
  }

  async saveSharedExtensions(extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    await this.writeExtensions(this.sharedRegistryPath(), extensions)
  }

  private async writeExtensions(path: string, extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
    const backup = `${path}.bak-${process.pid}-${Date.now().toString(36)}`
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(temporary, `${JSON.stringify({ version: 1, extensions }, null, 2)}\n`, 'utf8')
    try {
      await rename(path, backup).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await rename(temporary, path)
      await rm(backup, { force: true })
    } catch (error) {
      await rm(temporary, { force: true })
      if (await readFile(path).then(() => false, () => true)) await rename(backup, path).catch(() => {})
      throw error
    }
  }

  async removeExtensionDirectory(sessionId: string, extensionId: string): Promise<void> {
    await rm(join(this.root, 'extensions', 'sessions', profileSegment(sessionId), 'packages', extensionId), { recursive: true, force: true })
  }

  async removeSharedExtensionDirectory(extensionId: string): Promise<void> {
    await rm(join(this.root, 'extensions', 'shared', 'packages', extensionId), { recursive: true, force: true })
  }

  async pruneExtensionDirectories(sessionId: string, extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    await this.pruneDirectories(join(this.root, 'extensions', 'sessions', profileSegment(sessionId), 'packages'), extensions)
  }

  async pruneSharedExtensionDirectories(extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    await this.pruneDirectories(join(this.root, 'extensions', 'shared', 'packages'), extensions)
  }

  private async pruneDirectories(directory: string, extensions: readonly BrowserExtensionRecord[]): Promise<void> {
    const retained = new Set(extensions.map(extension => extension.path.toLowerCase()))
    try {
      const ids = await readdir(directory, { withFileTypes: true })
      await Promise.all(ids.map(async id => {
        if (!id.isDirectory()) return
        const idPath = join(directory, id.name)
        const generations = await readdir(idPath, { withFileTypes: true })
        await Promise.all(generations.map(async generation => {
          if (!generation.isDirectory()) return
          const path = join(idPath, generation.name)
          if (!retained.has(path.toLowerCase())) await rm(path, { recursive: true, force: true })
        }))
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async ensureSharedProfileSeed(seedSessionId?: string): Promise<void> {
    const marker = this.sharedMigrationMarkerPath()
    if (await stat(marker).then(() => true, () => false)) return

    const sharedProfile = this.sharedProfilePath()
    await mkdir(join(sharedProfile, '..'), { recursive: true })
    if (seedSessionId === undefined) {
      await mkdir(sharedProfile, { recursive: true })
      await writeFile(marker, `${JSON.stringify({ version: 1, source: 'empty', completedAt: Date.now() }, null, 2)}\n`, 'utf8')
      return
    }

    const sourceProfile = this.profilePath(seedSessionId)
    if (!await stat(sourceProfile).then(item => item.isDirectory(), () => false)) {
      await mkdir(sharedProfile, { recursive: true })
      await writeFile(marker, `${JSON.stringify({ version: 1, source: 'empty', requestedSeedSessionId: seedSessionId, completedAt: Date.now() }, null, 2)}\n`, 'utf8')
      return
    }

    if (!await stat(sharedProfile).then(() => true, () => false)) {
      const temporaryProfile = `${sharedProfile}.tmp-${process.pid}-${Date.now().toString(36)}`
      try {
        // Profile数据库不能逐文件合并；首次迁移只复制用户明确选择的单一Session，原目录始终保留为回退数据。
        await cp(sourceProfile, temporaryProfile, { recursive: true, force: false, errorOnExist: true })
        await rename(temporaryProfile, sharedProfile)
      } catch (error) {
        await rm(temporaryProfile, { recursive: true, force: true })
        throw error
      }
    }

    const sharedExtensions = await this.listSharedExtensions()
    if (sharedExtensions.length === 0) {
      const seededExtensions = await this.listExtensions(seedSessionId)
      const migrated: BrowserExtensionRecord[] = []
      for (const extension of seededExtensions) {
        const target = this.sharedExtensionDirectory(extension.extensionId)
        await mkdir(join(target, '..'), { recursive: true })
        await cp(extension.path, target, { recursive: true, force: false, errorOnExist: true })
        migrated.push({ ...extension, path: target })
      }
      await this.saveSharedExtensions(migrated)
    }

    await writeFile(marker, `${JSON.stringify({ version: 1, source: 'session', seedSessionId, completedAt: Date.now() }, null, 2)}\n`, 'utf8')
  }
}
