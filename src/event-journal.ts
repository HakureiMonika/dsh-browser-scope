import { createHash } from 'node:crypto'
import type { EvidenceContextIdentity } from './context-identity.ts'

export type JournalEvent = ConsoleJournalEvent | NetworkJournalEvent | ScriptJournalEvent | ActionJournalEvent
export type JournalSeverity = 'debug' | 'info' | 'warning' | 'error'

export interface JournalCursor {
  sequence: number
}

interface JournalBase {
  schemaVersion: 2
  eventId: string
  sequence: number
  sessionId: string
  sessionKey: string
  viewId: string
  contextGeneration: number
  documentGeneration: number
  navigationId: string
  monotonicTime: number
  wallTime: number
  severity: JournalSeverity
  fingerprint: string
  targetId?: string
  frameId?: string
  frameDocumentGeneration?: number
  executionContextId?: number
  worldType?: EvidenceContextIdentity['worldType']
  loaderId?: string
}

export interface ConsoleJournalEvent extends JournalBase {
  kind: 'console'
  source: 'console' | 'pageerror'
  level: string
  text: string
  repeatCount: number
  url?: string
  line?: number
  column?: number
  stack?: string
}

export interface NetworkJournalEvent extends JournalBase {
  kind: 'network'
  requestId: string
  method: string
  url: string
  resourceType: string
  redirectFromRequestId?: string
  status?: number
  failure?: string
  responseTime?: number
  finishedTime?: number
}

export interface ScriptJournalEvent extends JournalBase {
  kind: 'script'
  scriptId: string
  url: string
  sourceMapUrl?: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface ActionJournalEvent extends JournalBase {
  kind: 'action'
  actionId: string
  callId: string
  rootCallId: string
  toolName: string
  humanInitiated: boolean
  startedAt: number
  finishedAt: number
  outcome: 'ok' | 'failed' | 'aborted'
  beforeViewId?: string
  beforeDocumentGeneration?: number
  beforeNavigationId?: string
  afterViewId?: string
  afterDocumentGeneration?: number
  afterNavigationId?: string
  changeSignals?: Record<string, boolean>
  relatedEventIds: string[]
}

interface JournalSession {
  sequence: number
  actionSequence: number
  events: JournalEvent[]
}

export interface JournalScope extends EvidenceContextIdentity {
  sessionId: string
  sessionKey: string
  viewId: string
  contextGeneration: number
  documentGeneration: number
  navigationId: string
}

function contextIdentity(input: EvidenceContextIdentity): EvidenceContextIdentity {
  return {
    ...(input.targetId === undefined ? {} : { targetId: bounded(input.targetId, 200) }),
    ...(input.frameId === undefined ? {} : { frameId: bounded(input.frameId, 200) }),
    ...(input.frameDocumentGeneration === undefined ? {} : { frameDocumentGeneration: input.frameDocumentGeneration }),
    ...(input.executionContextId === undefined ? {} : { executionContextId: input.executionContextId }),
    ...(input.worldType === undefined ? {} : { worldType: input.worldType }),
    ...(input.loaderId === undefined ? {} : { loaderId: bounded(input.loaderId, 200) }),
  }
}

interface ConsoleInput extends JournalScope {
  source: ConsoleJournalEvent['source']
  level: string
  text: string
  url?: string
  line?: number
  column?: number
  stack?: string
}

interface NetworkStartInput extends JournalScope {
  request: object
  method: string
  url: string
  resourceType: string
  redirectFrom?: object
}

interface ActionInput extends JournalScope {
  callId: string
  rootCallId: string
  toolName: string
  humanInitiated: boolean
  startedAt: number
  finishedAt: number
  outcome: ActionJournalEvent['outcome']
  beforeViewId?: string
  beforeDocumentGeneration?: number
  beforeNavigationId?: string
  afterViewId?: string
  afterDocumentGeneration?: number
  afterNavigationId?: string
  changeSignals?: Record<string, boolean>
}

interface ScriptInput extends JournalScope {
  scriptId: string
  url: string
  sourceMapUrl?: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return value.slice(0, maximum)
}

function redactText(value: string): string {
  const urlsRedacted = value.replace(/https?:\/\/[^\s)]+/g, (match) => {
    try {
      const url = new URL(match)
      for (const key of url.searchParams.keys()) {
        if (/token|key|code|auth|session|secret|password/i.test(key)) url.searchParams.set(key, '[REDACTED]')
      }
      return url.href
    } catch {
      return match
    }
  })
  return urlsRedacted.replace(/((?:authorization|cookie|password|token|secret|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
}

function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20)
}

function consoleSeverity(source: ConsoleJournalEvent['source'], level: string): JournalSeverity {
  if (source === 'pageerror' || /error|assert/i.test(level)) return 'error'
  if (/warn/i.test(level)) return 'warning'
  if (/debug|trace/i.test(level)) return 'debug'
  return 'info'
}

export class EventJournal {
  private readonly sessions = new Map<string, JournalSession>()
  private readonly requests = new WeakMap<object, NetworkJournalEvent>()
  private readonly maximumEventsPerSession: number

  constructor(maximumEventsPerSession = 1200) {
    this.maximumEventsPerSession = maximumEventsPerSession
  }

  private session(sessionKey: string): JournalSession {
    let session = this.sessions.get(sessionKey)
    if (session === undefined) {
      session = { sequence: 0, actionSequence: 0, events: [] }
      this.sessions.set(sessionKey, session)
    }
    return session
  }

  private append<T extends JournalEvent>(sessionKey: string, create: (sequence: number, eventId: string) => T): T {
    const session = this.session(sessionKey)
    const sequence = ++session.sequence
    const event = create(sequence, `j${sequence}`)
    session.events.push(event)
    if (session.events.length > this.maximumEventsPerSession) {
      session.events.splice(0, session.events.length - this.maximumEventsPerSession)
    }
    return event
  }

  cursor(sessionKey: string): JournalCursor {
    return { sequence: this.sessions.get(sessionKey)?.sequence ?? 0 }
  }

  recordConsole(input: ConsoleInput): ConsoleJournalEvent {
    const text = bounded(redactText(input.text), 4000) ?? ''
    const stack = bounded(input.stack === undefined ? undefined : redactText(input.stack), 6000)
    const url = bounded(input.url === undefined ? undefined : redactText(input.url), 1000)
    const eventFingerprint = fingerprint([input.source, input.level, text, url, input.line, input.column, stack])
    const session = this.session(input.sessionKey)
    const previous = [...session.events].reverse().find((event): event is ConsoleJournalEvent => {
      return event.kind === 'console'
        && event.viewId === input.viewId
        && event.contextGeneration === input.contextGeneration
        && event.documentGeneration === input.documentGeneration
        && event.navigationId === input.navigationId
        && event.fingerprint === eventFingerprint
    })
    if (previous !== undefined) {
      return this.append(input.sessionKey, (sequence, eventId) => ({
        schemaVersion: 2,
        eventId,
        sequence,
        sessionId: bounded(input.sessionId, 200) ?? '',
        sessionKey: input.sessionKey,
        viewId: input.viewId,
        contextGeneration: input.contextGeneration,
        documentGeneration: input.documentGeneration,
        navigationId: bounded(input.navigationId, 160) ?? 'unknown',
        monotonicTime: performance.now(),
        wallTime: Date.now(),
        severity: consoleSeverity(input.source, input.level),
        ...contextIdentity(input),
        kind: 'console',
        source: input.source,
        level: bounded(input.level, 40) ?? 'unknown',
        text,
        fingerprint: eventFingerprint,
        repeatCount: previous.repeatCount + 1,
        ...(url === undefined ? {} : { url }),
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.column === undefined ? {} : { column: input.column }),
        ...(stack === undefined ? {} : { stack }),
      }))
    }
    return this.append(input.sessionKey, (sequence, eventId) => ({
      schemaVersion: 2,
      eventId,
      sequence,
      sessionId: bounded(input.sessionId, 200) ?? '',
      sessionKey: input.sessionKey,
      viewId: input.viewId,
      contextGeneration: input.contextGeneration,
      documentGeneration: input.documentGeneration,
      navigationId: bounded(input.navigationId, 160) ?? 'unknown',
      monotonicTime: performance.now(),
      wallTime: Date.now(),
      severity: consoleSeverity(input.source, input.level),
      ...contextIdentity(input),
      kind: 'console',
      source: input.source,
      level: bounded(input.level, 40) ?? 'unknown',
      text,
      fingerprint: eventFingerprint,
      repeatCount: 1,
      ...(url === undefined ? {} : { url }),
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(input.column === undefined ? {} : { column: input.column }),
      ...(stack === undefined ? {} : { stack }),
    }))
  }

  startNetwork(input: NetworkStartInput): NetworkJournalEvent {
    const redirect = input.redirectFrom === undefined ? undefined : this.requests.get(input.redirectFrom)
    const url = bounded(redactText(input.url), 1600) ?? ''
    const event = this.append(input.sessionKey, (sequence, eventId) => ({
      schemaVersion: 2,
      eventId,
      sequence,
      sessionId: bounded(input.sessionId, 200) ?? '',
      sessionKey: input.sessionKey,
      viewId: input.viewId,
      contextGeneration: input.contextGeneration,
      documentGeneration: input.documentGeneration,
      navigationId: bounded(input.navigationId, 160) ?? 'unknown',
      monotonicTime: performance.now(),
      wallTime: Date.now(),
      severity: 'info',
      ...contextIdentity(input),
      kind: 'network',
      requestId: `r${sequence}`,
      method: bounded(input.method, 32) ?? 'GET',
      url,
      resourceType: bounded(input.resourceType, 80) ?? 'other',
      fingerprint: fingerprint([input.method, url, input.resourceType]),
      ...(redirect === undefined ? {} : { redirectFromRequestId: redirect.requestId }),
    }))
    this.requests.set(input.request, event)
    return event
  }

  private requestEvent(request: object): NetworkJournalEvent | undefined {
    return this.requests.get(request)
  }

  requestNavigationId(request: object): string | undefined {
    return this.requestEvent(request)?.navigationId
  }

  recordResponse(request: object, status: number): void {
    const event = this.requestEvent(request)
    if (event === undefined) return
    event.status = status
    event.severity = status >= 500 ? 'error' : status >= 400 ? 'warning' : 'info'
    event.responseTime = Date.now()
  }

  recordRequestFailure(request: object, failure: string): void {
    const event = this.requestEvent(request)
    if (event === undefined) return
    event.failure = bounded(redactText(failure), 1000) ?? 'request failed'
    event.severity = 'error'
    event.finishedTime = Date.now()
  }

  recordRequestFinished(request: object): void {
    const event = this.requestEvent(request)
    if (event === undefined) return
    event.finishedTime = Date.now()
  }

  recordScript(input: ScriptInput): ScriptJournalEvent {
    const url = bounded(input.url, 1600) ?? ''
    const sourceMapUrl = bounded(input.sourceMapUrl, 1600)
    return this.append(input.sessionKey, (sequence, eventId) => ({
      schemaVersion: 2,
      eventId,
      sequence,
      sessionId: bounded(input.sessionId, 200) ?? '',
      sessionKey: input.sessionKey,
      viewId: input.viewId,
      contextGeneration: input.contextGeneration,
      documentGeneration: input.documentGeneration,
      navigationId: bounded(input.navigationId, 160) ?? 'unknown',
      monotonicTime: performance.now(),
      wallTime: Date.now(),
      severity: 'debug',
      ...contextIdentity(input),
      kind: 'script',
      scriptId: bounded(input.scriptId, 200) ?? '',
      url,
      ...(sourceMapUrl === undefined || sourceMapUrl === '' ? {} : { sourceMapUrl }),
      startLine: input.startLine,
      startColumn: input.startColumn,
      endLine: input.endLine,
      endColumn: input.endColumn,
      fingerprint: fingerprint([input.scriptId, url, input.executionContextId, input.frameId, input.frameDocumentGeneration]),
    }))
  }

  recordAction(input: ActionInput): ActionJournalEvent {
    const session = this.session(input.sessionKey)
    const actionId = `a${++session.actionSequence}`
    const relatedEventIds = session.events.filter(event => {
      const documentMatches = event.documentGeneration === (input.beforeDocumentGeneration ?? input.documentGeneration)
        || event.documentGeneration === (input.afterDocumentGeneration ?? input.documentGeneration)
      const navigationMatches = event.navigationId === (input.beforeNavigationId ?? input.navigationId)
        || event.navigationId === (input.afterNavigationId ?? input.navigationId)
      return (event.kind === 'console' || event.kind === 'network')
        && event.viewId === input.viewId
        && event.contextGeneration === input.contextGeneration
        && documentMatches
        && navigationMatches
        && event.wallTime >= input.startedAt
        && event.wallTime <= input.finishedAt
    }).slice(-40).map(event => event.eventId)
    return this.append(input.sessionKey, (sequence, eventId) => ({
      schemaVersion: 2,
      eventId,
      sequence,
      sessionId: bounded(input.sessionId, 200) ?? '',
      sessionKey: input.sessionKey,
      viewId: input.viewId,
      contextGeneration: input.contextGeneration,
      documentGeneration: input.documentGeneration,
      navigationId: bounded(input.navigationId, 160) ?? 'unknown',
      monotonicTime: performance.now(),
      wallTime: Date.now(),
      severity: input.outcome === 'ok' ? 'info' : input.outcome === 'aborted' ? 'warning' : 'error',
      ...contextIdentity(input),
      kind: 'action',
      actionId,
      fingerprint: fingerprint([input.toolName, input.humanInitiated, input.outcome, input.beforeViewId, input.afterViewId]),
      callId: bounded(input.callId, 200) ?? '',
      rootCallId: bounded(input.rootCallId, 200) ?? '',
      toolName: bounded(input.toolName, 160) ?? '',
      humanInitiated: input.humanInitiated,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: input.outcome,
      ...(input.beforeViewId === undefined ? {} : { beforeViewId: input.beforeViewId }),
      ...(input.beforeDocumentGeneration === undefined ? {} : { beforeDocumentGeneration: input.beforeDocumentGeneration }),
      ...(input.beforeNavigationId === undefined ? {} : { beforeNavigationId: bounded(input.beforeNavigationId, 160) ?? 'unknown' }),
      ...(input.afterViewId === undefined ? {} : { afterViewId: input.afterViewId }),
      ...(input.afterDocumentGeneration === undefined ? {} : { afterDocumentGeneration: input.afterDocumentGeneration }),
      ...(input.afterNavigationId === undefined ? {} : { afterNavigationId: bounded(input.afterNavigationId, 160) ?? 'unknown' }),
      ...(input.changeSignals === undefined ? {} : { changeSignals: input.changeSignals }),
      relatedEventIds,
    }))
  }

  action(sessionKey: string, actionId: string): ActionJournalEvent | undefined {
    return this.sessions.get(sessionKey)?.events.find((event): event is ActionJournalEvent => {
      return event.kind === 'action' && event.actionId === actionId
    })
  }

  event(sessionKey: string, eventId: string): JournalEvent | undefined {
    return this.sessions.get(sessionKey)?.events.find(event => event.eventId === eventId)
  }

  events(sessionKey: string, afterSequence = 0, viewId?: string): JournalEvent[] {
    return (this.sessions.get(sessionKey)?.events ?? []).filter(event => {
      return event.sequence > afterSequence && (viewId === undefined || event.viewId === viewId)
    })
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  migrateSession(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return
    const previous = this.sessions.get(previousKey)
    if (previous === undefined) return
    const next = this.sessions.get(nextKey)
    if (next !== undefined) {
      throw new Error('cannot migrate browser journal into an existing session')
    }
    for (const event of previous.events) {
      event.sessionKey = nextKey
    }
    this.sessions.set(nextKey, previous)
    this.sessions.delete(previousKey)
  }

  clear(): void {
    this.sessions.clear()
  }
}
