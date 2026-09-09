import { createHash } from 'node:crypto'
import type { EvidenceContextIdentity } from './context-identity.ts'

export interface ScriptBuildIdentity extends EvidenceContextIdentity {
  scriptId: string
  viewId: string
  documentGeneration: number
  navigationId: string
  url: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  loadedAt: number
  scriptSha256?: string
  sourceMapUrl?: string
  sourceMapSha256?: string
  buildId?: string
  active: boolean
}

export interface BuildIdentity extends EvidenceContextIdentity {
  buildId: string
  viewId: string
  documentGeneration: number
  navigationId: string
  scriptIds: string[]
  scriptUrls: string[]
  sourceMapUrls: string[]
  scriptHashes: Record<string, string>
  detectedAt: number
  active: boolean
  confidence: 'confirmed' | 'candidate'
  versionHint?: string
  publicPath?: string
}

interface BuildSession {
  scripts: Map<string, ScriptBuildIdentity>
  builds: Map<string, BuildIdentity>
}

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

export class BuildRegistry {
  private readonly sessions = new Map<string, BuildSession>()

  private refreshBuildActivity(session: BuildSession, buildId: string | undefined): void {
    if (buildId === undefined) return
    const build = session.builds.get(buildId)
    if (build === undefined) return
    build.active = build.scriptIds.some(scriptId => session.scripts.get(scriptId)?.active === true)
  }

  private session(sessionKey: string): BuildSession {
    let session = this.sessions.get(sessionKey)
    if (session === undefined) {
      session = { scripts: new Map(), builds: new Map() }
      this.sessions.set(sessionKey, session)
    }
    return session
  }

  registerScript(sessionKey: string, input: ScriptBuildIdentity): ScriptBuildIdentity {
    const value: ScriptBuildIdentity = {
      ...input,
      scriptId: bounded(input.scriptId, 200),
      viewId: bounded(input.viewId, 200),
      navigationId: bounded(input.navigationId, 200),
      url: bounded(input.url, 1600),
    }
    this.session(sessionKey).scripts.set(value.scriptId, value)
    return value
  }

  bindSource(sessionKey: string, scriptId: string, input: { source: string; sourceMapUrl?: string; sourceMap?: unknown; versionHint?: string; publicPath?: string }): BuildIdentity {
    const session = this.session(sessionKey)
    const script = session.scripts.get(scriptId)
    if (script === undefined) throw new Error('build registry script does not exist')
    const scriptSha256 = createHash('sha256').update(input.source).digest('hex')
    const sourceMapSha256 = input.sourceMap === undefined ? undefined : createHash('sha256').update(JSON.stringify(input.sourceMap)).digest('hex')
    const buildId = `build-${hash([
      script.targetId,
      script.frameId,
      script.documentGeneration,
      script.navigationId,
      script.url,
      scriptSha256,
      sourceMapSha256,
      input.versionHint,
    ]).slice(0, 20)}`
    if (script.buildId !== undefined && script.buildId !== buildId) {
      const previousBuild = session.builds.get(script.buildId)
      if (previousBuild !== undefined) previousBuild.active = false
    }
    script.scriptSha256 = scriptSha256
    script.buildId = buildId
    if (input.sourceMapUrl !== undefined) script.sourceMapUrl = bounded(input.sourceMapUrl, 1600)
    if (sourceMapSha256 !== undefined) script.sourceMapSha256 = sourceMapSha256
    let build = session.builds.get(buildId)
    if (build === undefined) {
      build = {
        buildId,
        viewId: script.viewId,
        documentGeneration: script.documentGeneration,
        navigationId: script.navigationId,
        ...(script.targetId === undefined ? {} : { targetId: script.targetId }),
        ...(script.frameId === undefined ? {} : { frameId: script.frameId }),
        ...(script.frameDocumentGeneration === undefined ? {} : { frameDocumentGeneration: script.frameDocumentGeneration }),
        scriptIds: [],
        scriptUrls: [],
        sourceMapUrls: [],
        scriptHashes: {},
        detectedAt: Date.now(),
        active: script.active,
        confidence: sourceMapSha256 === undefined ? 'candidate' : 'confirmed',
        ...(input.versionHint === undefined ? {} : { versionHint: bounded(input.versionHint, 200) }),
        ...(input.publicPath === undefined ? {} : { publicPath: bounded(input.publicPath, 1000) }),
      }
      session.builds.set(buildId, build)
    }
    if (!build.scriptIds.includes(script.scriptId)) build.scriptIds.push(script.scriptId)
    if (!build.scriptUrls.includes(script.url)) build.scriptUrls.push(script.url)
    if (script.sourceMapUrl !== undefined && !build.sourceMapUrls.includes(script.sourceMapUrl)) build.sourceMapUrls.push(script.sourceMapUrl)
    build.scriptHashes[script.scriptId] = scriptSha256
    return build
  }

  script(sessionKey: string, scriptId: string): ScriptBuildIdentity | undefined {
    return this.sessions.get(sessionKey)?.scripts.get(scriptId)
  }

  deactivateScript(sessionKey: string, scriptId: string): void {
    const session = this.sessions.get(sessionKey)
    const script = session?.scripts.get(scriptId)
    if (session === undefined || script === undefined || !script.active) return
    script.active = false
    this.refreshBuildActivity(session, script.buildId)
  }

  deactivateExecutionContext(sessionKey: string, executionContextId: number): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    const buildIds = new Set<string>()
    for (const script of session.scripts.values()) {
      if (script.executionContextId !== executionContextId || !script.active) continue
      script.active = false
      if (script.buildId !== undefined) buildIds.add(script.buildId)
    }
    for (const buildId of buildIds) this.refreshBuildActivity(session, buildId)
  }

  deactivateTarget(sessionKey: string, targetId: string): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    const buildIds = new Set<string>()
    for (const script of session.scripts.values()) {
      if (script.targetId !== targetId || !script.active) continue
      script.active = false
      if (script.buildId !== undefined) buildIds.add(script.buildId)
    }
    for (const buildId of buildIds) this.refreshBuildActivity(session, buildId)
  }

  selectScript(sessionKey: string, input: { viewId: string; documentGeneration: number; url: string; line?: number; targetId?: string; frameId?: string }): { script?: ScriptBuildIdentity; status: 'confirmed' | 'ambiguous' | 'unavailable' } {
    const candidates = [...(this.sessions.get(sessionKey)?.scripts.values() ?? [])].filter(script => script.active
      && script.viewId === input.viewId
      && script.documentGeneration === input.documentGeneration
      && script.url === input.url
      && (input.targetId === undefined || script.targetId === input.targetId)
      && (input.frameId === undefined || script.frameId === input.frameId)
      && (input.line === undefined || (input.line - 1 >= script.startLine && input.line - 1 <= script.endLine)))
    if (candidates.length === 0) return { status: 'unavailable' }
    if (candidates.length > 1) return { status: 'ambiguous' }
    return { script: candidates[0], status: 'confirmed' }
  }

  invalidateDocument(sessionKey: string, viewId: string, documentGeneration: number): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    const buildIds = new Set<string>()
    for (const script of session.scripts.values()) {
      if (script.viewId !== viewId || script.documentGeneration === documentGeneration || !script.active) continue
      script.active = false
      if (script.buildId !== undefined) buildIds.add(script.buildId)
    }
    for (const buildId of buildIds) this.refreshBuildActivity(session, buildId)
  }

  snapshot(sessionKey: string, limit = 32): { builds: BuildIdentity[]; scripts: ScriptBuildIdentity[]; truncated: boolean } {
    const session = this.sessions.get(sessionKey)
    const builds = [...(session?.builds.values() ?? [])]
    const scripts = [...(session?.scripts.values() ?? [])]
    return { builds: builds.slice(-limit), scripts: scripts.slice(-limit * 4), truncated: builds.length > limit || scripts.length > limit * 4 }
  }

  migrateSession(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return
    const session = this.sessions.get(previousKey)
    if (session === undefined) return
    if (this.sessions.has(nextKey)) throw new Error('cannot migrate build registry into an existing session')
    this.sessions.set(nextKey, session)
    this.sessions.delete(previousKey)
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  clear(): void {
    this.sessions.clear()
  }
}
