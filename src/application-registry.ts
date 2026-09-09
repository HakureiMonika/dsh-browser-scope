import { createHash } from 'node:crypto'

export type ApplicationConfidence = 'confirmed' | 'candidate'
export type ApplicationKind = 'shell' | 'root' | 'iframe' | 'module-federation' | 'third-party' | 'unknown'

export interface ApplicationIdentity {
  applicationId: string
  viewId: string
  kind: ApplicationKind
  name: string
  origin?: string
  frameId?: string
  rootSelector?: string
  buildIds: string[]
  signals: string[]
  counterEvidence: string[]
  confidence: ApplicationConfidence
  active: boolean
  detectedAt: number
}

function idOf(input: Omit<ApplicationIdentity, 'applicationId' | 'buildIds' | 'active' | 'detectedAt'>): string {
  return `app-${createHash('sha256').update(JSON.stringify([input.viewId, input.kind, input.name, input.origin, input.frameId, input.rootSelector])).digest('hex').slice(0, 20)}`
}

export class ApplicationRegistry {
  private readonly sessions = new Map<string, Map<string, ApplicationIdentity>>()

  upsert(sessionKey: string, input: Omit<ApplicationIdentity, 'applicationId' | 'buildIds' | 'active' | 'detectedAt'> & { buildIds?: string[] }): ApplicationIdentity {
    let session = this.sessions.get(sessionKey)
    if (session === undefined) { session = new Map(); this.sessions.set(sessionKey, session) }
    const applicationId = idOf(input)
    const previous = session.get(applicationId)
    const value: ApplicationIdentity = {
      applicationId,
      viewId: input.viewId.slice(0, 200), kind: input.kind, name: input.name.slice(0, 200),
      ...(input.origin === undefined ? {} : { origin: input.origin.slice(0, 500) }),
      ...(input.frameId === undefined ? {} : { frameId: input.frameId.slice(0, 200) }),
      ...(input.rootSelector === undefined ? {} : { rootSelector: input.rootSelector.slice(0, 500) }),
      buildIds: [...new Set([...(previous?.buildIds ?? []), ...(input.buildIds ?? [])])].slice(0, 32),
      signals: input.signals.slice(0, 16).map(value => value.slice(0, 300)),
      counterEvidence: input.counterEvidence.slice(0, 16).map(value => value.slice(0, 300)),
      confidence: input.confidence, active: true, detectedAt: previous?.detectedAt ?? Date.now(),
    }
    session.set(applicationId, value)
    return value
  }

  bindBuild(sessionKey: string, applicationId: string, buildId: string): void { const value = this.sessions.get(sessionKey)?.get(applicationId); if (value !== undefined && !value.buildIds.includes(buildId)) value.buildIds.push(buildId) }
  deactivateView(sessionKey: string, viewId: string): void { for (const value of this.sessions.get(sessionKey)?.values() ?? []) if (value.viewId === viewId) value.active = false }
  snapshot(sessionKey: string, limit = 24): { applications: ApplicationIdentity[]; truncated: boolean } { const values = [...(this.sessions.get(sessionKey)?.values() ?? [])]; return { applications: values.slice(-limit), truncated: values.length > limit } }
  migrateSession(previousKey: string, nextKey: string): void { if (previousKey === nextKey) return; const value = this.sessions.get(previousKey); if (value === undefined) return; if (this.sessions.has(nextKey)) throw new Error('cannot migrate application registry into an existing session'); this.sessions.set(nextKey, value); this.sessions.delete(previousKey) }
  clearSession(sessionKey: string): void { this.sessions.delete(sessionKey) }
  clear(): void { this.sessions.clear() }
}
