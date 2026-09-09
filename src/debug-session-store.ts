import type { JournalCursor, JournalEvent } from './event-journal.ts'
import type { EvidenceContextIdentity } from './context-identity.ts'
import type { SurfaceEvidence } from './surface-evidence.ts'
import type { L3CheckpointSnapshot } from './l3-closure.ts'

export interface ElementSummary {
  tag: string
  id?: string
  className?: string
  role?: string
  accessibleName?: string
  box: { x: number; y: number; width: number; height: number }
  styles: {
    display: string
    visibility: string
    opacity: string
    pointerEvents: string
    position: string
    zIndex: string
  }
}

export interface ElementIdentity {
  resolution: 'resolved-by-ref' | 'reidentified' | 'ambiguous' | 'not-found'
  ref: string
  viewId: string
  documentGeneration: number
  navigationId: string
  tag: string
  role?: string
  accessibleName?: string
  selectorHints: string[]
  textFingerprint?: string
  targetId?: string
  frameId?: string
  frameDocumentGeneration?: number
}

export interface HitTestEvidence {
  point: { x: number; y: number }
  topElement: ElementSummary | null
  targetMatches: boolean
  occlusionChain: ElementSummary[]
}

export interface CanvasEvidence {
  cssWidth: number
  cssHeight: number
  backingWidth: number
  backingHeight: number
  deviceScaleFactor: number
  backingScaleX: number | null
  backingScaleY: number | null
  centerLocalPoint: { x: number; y: number }
}

export interface PortalEvidence {
  candidate: boolean
  root: ElementSummary
  overflow: { top: number; right: number; bottom: number; left: number }
}

export interface ElementEvidence {
  ref: string
  identity?: ElementIdentity
  visible: boolean
  viewportIntersection: boolean
  box?: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
  clippingAncestors: Array<{ tag: string; id?: string; className?: string; overflowX: string; overflowY: string; box: { x: number; y: number; width: number; height: number } }>
  stackingContexts?: ElementSummary[]
  hitTest?: HitTestEvidence
  canvas?: CanvasEvidence
  portal?: PortalEvidence
  surface?: SurfaceEvidence
  application?: {
    applicationId: string
    kind: string
    name: string
    confidence: 'confirmed' | 'candidate'
  }
}

export interface DiagnosticCheckpoint {
  schemaVersion: 2
  checkpointId: string
  label: string
  createdAt: number
  viewId: string
  contextGeneration: number
  documentGeneration: number
  navigationId: string
  cursor: JournalCursor
  journalRange?: {
    afterSequence: number
    untilSequence: number
    eventCount: number
  }
  environment?: {
    provider: string
    controlOwner: 'model' | 'user'
    url: string
    viewport: { width: number; height: number; generation: number }
    deviceScaleFactor: number
    scroll: { x: number; y: number }
    contextGeneration: number
    documentGeneration: number
    navigationId: string
  }
  summaries?: {
    console: { total: number; errors: number }
    network: { total: number; failed: number }
    actions: number
    performance: { status: 'unavailable' }
  }
  artifactManifest?: Array<{
    kind: 'screenshot'
    reference: unknown
  }>
  page: {
    url: string
    title: string
    viewport: { width: number; height: number; generation: number }
    rootScrollWidth: number
  }
  element?: ElementEvidence
  screenshot?: unknown
  events: JournalEvent[]
  l3?: L3CheckpointSnapshot
}

export interface DebugSessionRecord extends EvidenceContextIdentity {
  schemaVersion: 2
  debugSessionId: string
  sessionKey: string
  dshSessionId: string
  viewId: string
  contextGeneration: number
  documentGeneration: number
  navigationId: string
  startedAt: number
  startedCursor: JournalCursor
  status: 'active' | 'invalidated' | 'stopped'
  checkpoints: Map<string, DiagnosticCheckpoint>
  nextCheckpoint: number
}

export class DebugSessionStore {
  private readonly sessions = new Map<string, DebugSessionRecord>()
  private nextSession = 1

  start(input: Omit<DebugSessionRecord, 'schemaVersion' | 'debugSessionId' | 'status' | 'checkpoints' | 'nextCheckpoint'>): DebugSessionRecord {
    const existing = this.sessions.get(input.sessionKey)
    if (existing !== undefined) return existing
    const record: DebugSessionRecord = {
      ...input,
      schemaVersion: 2,
      debugSessionId: `ds${this.nextSession++}`,
      status: 'active',
      checkpoints: new Map(),
      nextCheckpoint: 1,
    }
    this.sessions.set(input.sessionKey, record)
    return record
  }

  get(sessionKey: string): DebugSessionRecord | undefined {
    return this.sessions.get(sessionKey)
  }

  require(sessionKey: string): DebugSessionRecord {
    const record = this.sessions.get(sessionKey)
    if (record === undefined) throw new Error('browser diagnose session is not active; call browser_diagnose with action start')
    return record
  }

  checkpoint(sessionKey: string, checkpoint: Omit<DiagnosticCheckpoint, 'schemaVersion' | 'checkpointId'>): DiagnosticCheckpoint {
    const record = this.require(sessionKey)
    const value: DiagnosticCheckpoint = { ...checkpoint, schemaVersion: 2, checkpointId: `cp${record.nextCheckpoint++}` }
    record.checkpoints.set(value.checkpointId, value)
    return value
  }

  checkpointById(sessionKey: string, checkpointId: string): DiagnosticCheckpoint | undefined {
    return this.require(sessionKey).checkpoints.get(checkpointId)
  }

  checkpoints(sessionKey: string): DiagnosticCheckpoint[] {
    return [...this.require(sessionKey).checkpoints.values()]
  }

  stop(sessionKey: string): DebugSessionRecord | undefined {
    const record = this.sessions.get(sessionKey)
    if (record !== undefined) record.status = 'stopped'
    this.sessions.delete(sessionKey)
    return record
  }

  updateDocument(sessionKey: string, documentGeneration: number, navigationId: string): DebugSessionRecord | undefined {
    const record = this.sessions.get(sessionKey)
    if (record === undefined) return undefined
    record.documentGeneration = documentGeneration
    record.navigationId = navigationId
    return record
  }

  invalidate(sessionKey: string): DebugSessionRecord | undefined {
    const record = this.sessions.get(sessionKey)
    if (record === undefined) return undefined
    record.status = 'invalidated'
    this.sessions.delete(sessionKey)
    return record
  }

  clear(): void {
    this.sessions.clear()
  }
}
