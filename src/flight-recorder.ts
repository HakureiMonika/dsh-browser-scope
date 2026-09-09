import type { EvidenceContextIdentity } from './context-identity.ts'
import type { InputCharacterSummary, InputSensitivity, InputTraceRecord } from './input-trace.ts'

export type RecorderMode = 'off' | 'rolling' | 'deep'
export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'disposed'
export type RecorderOverload = 'normal' | 'sampling-reduced' | 'visual-dropped' | 'mutation-detail-dropped' | 'metadata-only'

export interface RecorderEvent extends EvidenceContextIdentity {
  recorderEventSchemaVersion: 1
  traceEventId: string
  recorderId: string
  sequence: number
  timestamp: number
  source: 'user' | 'agent' | 'page' | 'system'
  kind: string
  viewId: string
  documentGeneration?: number
  navigationId?: string
  actionId?: string
  inputTraceId?: string
  buildId?: string
  applicationId?: string
  outcome?: string
  input?: {
    sensitivity: InputSensitivity
    characters?: InputCharacterSummary
    composing: boolean
    result?: InputTraceRecord['result']
  }
  metrics?: Record<string, number | boolean>
  labels?: Record<string, string>
}

export interface RecorderChunk {
  chunkId: string
  startedAt: number
  endedAt: number
  events: RecorderEvent[]
  byteSize: number
  frozenByIncidents: string[]
}

export interface RecordedIncidentWindow {
  incidentId: string
  markedAt: number
  windowStartedAt: number
  postTriggerUntil: number
  completedAt?: number
  chunkIds: string[]
  status: 'collecting-post-trigger' | 'complete'
}

export interface RecorderSnapshot {
  recorderSchemaVersion: 1
  recorderId: string
  sessionId: string
  sessionKey: string
  mode: RecorderMode
  status: RecorderStatus
  retentionMs: number
  startedAt?: number
  eventCount: number
  chunkCount: number
  byteSize: number
  oldestEventAt?: number
  newestEventAt?: number
  frozenIncidentIds: string[]
  overload: RecorderOverload
}

interface RecorderSession {
  recorderId: string
  sessionId: string
  sessionKey: string
  mode: RecorderMode
  status: RecorderStatus
  startedAt?: number
  sequence: number
  nextChunk: number
  chunks: RecorderChunk[]
  incidents: Map<string, RecordedIncidentWindow>
  overload: RecorderOverload
}

export interface FlightRecorderOptions {
  retentionMs?: number
  chunkDurationMs?: number
  postTriggerMs?: number
  maxEvents?: number
  maxBytes?: number
  now?: () => number
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function eventBytes(event: RecorderEvent): number {
  return Buffer.byteLength(JSON.stringify(event))
}

export class FlightRecorderStore {
  private readonly sessions = new Map<string, RecorderSession>()
  private readonly retentionMs: number
  private readonly chunkDurationMs: number
  private readonly postTriggerMs: number
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly now: () => number
  private nextRecorder = 1
  private nextIncident = 1

  constructor(options: FlightRecorderOptions = {}) {
    this.retentionMs = options.retentionMs ?? 180000
    this.chunkDurationMs = options.chunkDurationMs ?? 3000
    this.postTriggerMs = options.postTriggerMs ?? 30000
    this.maxEvents = options.maxEvents ?? 12000
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    this.now = options.now ?? Date.now
  }

  private session(sessionId: string, sessionKey: string): RecorderSession {
    let session = this.sessions.get(sessionKey)
    if (session === undefined) {
      session = {
        recorderId: `rec${this.nextRecorder++}`,
        sessionId: bounded(sessionId, 200),
        sessionKey,
        mode: 'off',
        status: 'idle',
        sequence: 0,
        nextChunk: 1,
        chunks: [],
        incidents: new Map(),
        overload: 'normal',
      }
      this.sessions.set(sessionKey, session)
    }
    return session
  }

  setMode(sessionId: string, sessionKey: string, mode: RecorderMode): RecorderSnapshot {
    const session = this.session(sessionId, sessionKey)
    if (session.status === 'disposed') throw new Error('flight recorder session is disposed')
    session.mode = mode
    if (mode === 'off') {
      session.status = 'idle'
      session.startedAt = undefined
    } else {
      session.status = 'recording'
      session.startedAt ??= this.now()
    }
    return this.snapshot(sessionKey)
  }

  pause(sessionKey: string): RecorderSnapshot {
    const session = this.require(sessionKey)
    if (session.mode !== 'off' && session.status !== 'disposed') session.status = 'paused'
    return this.snapshot(sessionKey)
  }

  resume(sessionKey: string): RecorderSnapshot {
    const session = this.require(sessionKey)
    if (session.mode !== 'off' && session.status !== 'disposed') session.status = 'recording'
    return this.snapshot(sessionKey)
  }

  private require(sessionKey: string): RecorderSession {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) throw new Error('flight recorder session is not active')
    return session
  }

  status(sessionId: string, sessionKey: string): RecorderSnapshot {
    this.session(sessionId, sessionKey)
    return this.snapshot(sessionKey)
  }

  record(sessionId: string, sessionKey: string, input: Omit<RecorderEvent, 'recorderEventSchemaVersion' | 'traceEventId' | 'recorderId' | 'sequence' | 'timestamp'> & { timestamp?: number }): RecorderEvent | undefined {
    const session = this.session(sessionId, sessionKey)
    if (session.mode === 'off' || session.status !== 'recording') return undefined
    const timestamp = input.timestamp ?? this.now()
    this.prune(session, timestamp)
    const sequence = ++session.sequence
    const event: RecorderEvent = {
      recorderEventSchemaVersion: 1,
      traceEventId: `rt${sequence}`,
      recorderId: session.recorderId,
      sequence,
      timestamp,
      source: input.source,
      kind: bounded(input.kind, 120),
      viewId: bounded(input.viewId, 200),
      ...(input.documentGeneration === undefined ? {} : { documentGeneration: input.documentGeneration }),
      ...(input.navigationId === undefined ? {} : { navigationId: bounded(input.navigationId, 200) }),
      ...(input.actionId === undefined ? {} : { actionId: bounded(input.actionId, 200) }),
      ...(input.inputTraceId === undefined ? {} : { inputTraceId: bounded(input.inputTraceId, 200) }),
      ...(input.buildId === undefined ? {} : { buildId: bounded(input.buildId, 200) }),
      ...(input.applicationId === undefined ? {} : { applicationId: bounded(input.applicationId, 200) }),
      ...(input.outcome === undefined ? {} : { outcome: bounded(input.outcome, 120) }),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
      ...(input.labels === undefined ? {} : { labels: Object.fromEntries(Object.entries(input.labels).map(([key, value]) => [bounded(key, 80), bounded(value, 200)])) }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
      ...(input.frameDocumentGeneration === undefined ? {} : { frameDocumentGeneration: input.frameDocumentGeneration }),
      ...(input.executionContextId === undefined ? {} : { executionContextId: input.executionContextId }),
      ...(input.worldType === undefined ? {} : { worldType: input.worldType }),
      ...(input.loaderId === undefined ? {} : { loaderId: input.loaderId }),
    }
    let chunk = session.chunks.at(-1)
    if (chunk === undefined || timestamp - chunk.startedAt >= this.chunkDurationMs) {
      chunk = { chunkId: `rc${session.nextChunk++}`, startedAt: timestamp, endedAt: timestamp, events: [], byteSize: 0, frozenByIncidents: [] }
      session.chunks.push(chunk)
    }
    chunk.events.push(event)
    chunk.endedAt = timestamp
    chunk.byteSize += eventBytes(event)
    for (const incident of session.incidents.values()) {
      if (incident.status !== 'collecting-post-trigger' || timestamp > incident.postTriggerUntil) continue
      this.freezeChunk(chunk, incident)
    }
    this.enforceQuota(session)
    return event
  }

  private freezeChunk(chunk: RecorderChunk, incident: RecordedIncidentWindow): void {
    if (!chunk.frozenByIncidents.includes(incident.incidentId)) chunk.frozenByIncidents.push(incident.incidentId)
    if (!incident.chunkIds.includes(chunk.chunkId)) incident.chunkIds.push(chunk.chunkId)
  }

  mark(sessionKey: string, timestamp = this.now()): RecordedIncidentWindow {
    const session = this.require(sessionKey)
    const incident: RecordedIncidentWindow = {
      incidentId: `recorded-${this.nextIncident++}`,
      markedAt: timestamp,
      windowStartedAt: timestamp - this.retentionMs,
      postTriggerUntil: timestamp + this.postTriggerMs,
      chunkIds: [],
      status: 'collecting-post-trigger',
    }
    session.incidents.set(incident.incidentId, incident)
    for (const chunk of session.chunks) {
      if (chunk.endedAt >= incident.windowStartedAt && chunk.startedAt <= timestamp) this.freezeChunk(chunk, incident)
    }
    return incident
  }

  complete(sessionKey: string, incidentId: string, timestamp = this.now()): RecordedIncidentWindow {
    const incident = this.require(sessionKey).incidents.get(incidentId)
    if (incident === undefined) throw new Error('recorded incident is not active')
    incident.status = 'complete'
    incident.completedAt = timestamp
    return incident
  }

  tick(sessionKey: string, timestamp = this.now()): void {
    const session = this.require(sessionKey)
    for (const incident of session.incidents.values()) {
      if (incident.status === 'collecting-post-trigger' && timestamp >= incident.postTriggerUntil) {
        incident.status = 'complete'
        incident.completedAt = incident.postTriggerUntil
      }
    }
    this.prune(session, timestamp)
  }

  private prune(session: RecorderSession, timestamp: number): void {
    const minimum = timestamp - this.retentionMs
    session.chunks = session.chunks.filter(chunk => chunk.frozenByIncidents.length > 0 || chunk.endedAt >= minimum)
  }

  private enforceQuota(session: RecorderSession): void {
    const totals = () => ({
      events: session.chunks.reduce((total, chunk) => total + chunk.events.length, 0),
      bytes: session.chunks.reduce((total, chunk) => total + chunk.byteSize, 0),
    })
    let total = totals()
    while ((total.events > this.maxEvents || total.bytes > this.maxBytes) && session.chunks.some(chunk => chunk.frozenByIncidents.length === 0)) {
      const index = session.chunks.findIndex(chunk => chunk.frozenByIncidents.length === 0)
      if (index < 0) break
      session.chunks.splice(index, 1)
      total = totals()
    }
    session.overload = total.events > this.maxEvents || total.bytes > this.maxBytes ? 'metadata-only' : 'normal'
  }

  timeline(sessionKey: string, limit = 200): RecorderEvent[] {
    const session = this.require(sessionKey)
    this.tick(sessionKey)
    return session.chunks.flatMap(chunk => chunk.events).slice(-Math.min(Math.max(limit, 1), 1000))
  }

  incident(sessionKey: string, incidentId: string): RecordedIncidentWindow | undefined {
    return this.sessions.get(sessionKey)?.incidents.get(incidentId)
  }

  chunks(sessionKey: string): RecorderChunk[] {
    return this.sessions.get(sessionKey)?.chunks ?? []
  }

  snapshot(sessionKey: string): RecorderSnapshot {
    const session = this.require(sessionKey)
    const events = session.chunks.flatMap(chunk => chunk.events)
    return {
      recorderSchemaVersion: 1,
      recorderId: session.recorderId,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      mode: session.mode,
      status: session.status,
      retentionMs: this.retentionMs,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
      eventCount: events.length,
      chunkCount: session.chunks.length,
      byteSize: session.chunks.reduce((total, chunk) => total + chunk.byteSize, 0),
      ...(events[0] === undefined ? {} : { oldestEventAt: events[0].timestamp }),
      ...(events.at(-1) === undefined ? {} : { newestEventAt: events.at(-1)?.timestamp }),
      frozenIncidentIds: [...session.incidents.keys()],
      overload: session.overload,
    }
  }

  clearSession(sessionKey: string, preserveFrozen = true): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    if (!preserveFrozen) {
      session.chunks = []
      session.incidents.clear()
      return
    }
    session.chunks = session.chunks.filter(chunk => chunk.frozenByIncidents.length > 0)
  }

  migrateSession(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return
    const session = this.sessions.get(previousKey)
    if (session === undefined) return
    if (this.sessions.has(nextKey)) throw new Error('cannot migrate flight recorder into an existing session')
    session.sessionKey = nextKey
    this.sessions.set(nextKey, session)
    this.sessions.delete(previousKey)
  }

  disposeSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (session !== undefined) session.status = 'disposed'
    this.sessions.delete(sessionKey)
  }

  clear(): void {
    for (const session of this.sessions.values()) session.status = 'disposed'
    this.sessions.clear()
  }
}
