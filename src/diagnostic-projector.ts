import type { DiagnosticCheckpoint } from './debug-session-store.ts'
import type { ActionJournalEvent, ConsoleJournalEvent, JournalEvent, NetworkJournalEvent } from './event-journal.ts'
import { assertLosslessJson, type LosslessJsonValue } from './lossless-json.ts'

export type ActionCorrelationConfidence = 'confirmed' | 'strong-candidate' | 'temporal-candidate' | 'background' | 'excluded'
export type ComparisonVerdict = 'fixed' | 'improved' | 'unchanged' | 'regressed' | 'incomparable' | 'evidence-insufficient'

function consoleEvents(events: readonly JournalEvent[]): ConsoleJournalEvent[] {
  return events.filter((event): event is ConsoleJournalEvent => event.kind === 'console')
}

function failedRequests(events: readonly JournalEvent[]): NetworkJournalEvent[] {
  return events.filter((event): event is NetworkJournalEvent => event.kind === 'network' && (event.failure !== undefined || (event.status !== undefined && event.status >= 400)))
}

function fingerprints<T extends { fingerprint: string }>(values: readonly T[]): Set<string> {
  return new Set(values.map(value => value.fingerprint))
}

function difference<T extends { fingerprint: string }>(values: readonly T[], excluded: ReadonlySet<string>): T[] {
  return values.filter(value => !excluded.has(value.fingerprint))
}

function matchesActionIdentity(event: JournalEvent, action: ActionJournalEvent): boolean {
  const documents = new Set([
    action.documentGeneration,
    action.beforeDocumentGeneration,
    action.afterDocumentGeneration,
  ].filter((value): value is number => value !== undefined))
  const navigations = new Set([
    action.navigationId,
    action.beforeNavigationId,
    action.afterNavigationId,
  ].filter((value): value is string => value !== undefined))
  return event.viewId === action.viewId
    && event.contextGeneration === action.contextGeneration
    && documents.has(event.documentGeneration)
    && navigations.has(event.navigationId)
}

function compactError(event: ConsoleJournalEvent): ConsoleJournalEvent {
  return {
    ...event,
    text: event.text.slice(0, 500),
    ...(event.stack === undefined ? {} : { stack: event.stack.slice(0, 1000) }),
  }
}

function compactRequest(event: NetworkJournalEvent): NetworkJournalEvent {
  return { ...event, url: event.url.slice(0, 800), ...(event.failure === undefined ? {} : { failure: event.failure.slice(0, 500) }) }
}

function finiteDiagnosticNumber(value: number, path: string, degradations: string[]): number | undefined {
  if (!Number.isFinite(value)) {
    degradations.push(`${path}:non-finite-number-omitted`)
    return undefined
  }
  return Object.is(value, -0) ? 0 : value
}

function projectBox(box: { x: number; y: number; width: number; height: number } | undefined, path: string, degradations: string[]) {
  if (box === undefined) return undefined
  const x = finiteDiagnosticNumber(box.x, `${path}.x`, degradations)
  const y = finiteDiagnosticNumber(box.y, `${path}.y`, degradations)
  const width = finiteDiagnosticNumber(box.width, `${path}.width`, degradations)
  const height = finiteDiagnosticNumber(box.height, `${path}.height`, degradations)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

function boxesEqual(
  before: ReturnType<typeof projectBox>,
  after: ReturnType<typeof projectBox>,
): boolean {
  if (before === undefined || after === undefined) return before === after
  return before.x === after.x
    && before.y === after.y
    && before.width === after.width
    && before.height === after.height
}

function projectElementSummary(element: DiagnosticCheckpoint['element'], path: string, degradations: string[]) {
  if (element === undefined) return undefined
  const box = projectBox(element.box, `${path}.box`, degradations)
  const hitPoint = element.hitTest === undefined
    ? undefined
    : projectBox({ x: element.hitTest.point.x, y: element.hitTest.point.y, width: 0, height: 0 }, `${path}.hitTest.point`, degradations)
  return {
    ref: element.ref.slice(0, 200),
    visible: element.visible,
    viewportIntersection: element.viewportIntersection,
    ...(box === undefined ? {} : { box }),
    ...(element.hitTest === undefined ? {} : {
      hitTest: {
        targetMatches: element.hitTest.targetMatches,
        ...(hitPoint === undefined ? {} : { point: { x: hitPoint.x, y: hitPoint.y } }),
        occlusionCount: Math.min(element.hitTest.occlusionChain.length, 1000),
      },
    }),
    ...(element.surface === undefined ? {} : { surface: { rendererType: element.surface.rendererType } }),
    ...(element.application === undefined ? {} : {
      application: {
        applicationId: element.application.applicationId.slice(0, 200),
        kind: element.application.kind.slice(0, 100),
        name: element.application.name.slice(0, 200),
        confidence: element.application.confidence,
      },
    }),
  }
}

function projectConsoleComparisonEvent(event: ConsoleJournalEvent, path: string, degradations: string[]) {
  const repeatCount = finiteDiagnosticNumber(event.repeatCount, `${path}.repeatCount`, degradations)
  return {
    eventId: event.eventId.slice(0, 200),
    fingerprint: event.fingerprint.slice(0, 200),
    source: event.source,
    level: event.level.slice(0, 100),
    text: event.text.slice(0, 500),
    ...(repeatCount === undefined ? {} : { repeatCount }),
    ...(event.url === undefined ? {} : { url: event.url.slice(0, 800) }),
    ...(event.stack === undefined ? {} : { stack: event.stack.slice(0, 1000) }),
  }
}

function projectNetworkComparisonEvent(event: NetworkJournalEvent, path: string, degradations: string[]) {
  const status = event.status === undefined ? undefined : finiteDiagnosticNumber(event.status, `${path}.status`, degradations)
  return {
    eventId: event.eventId.slice(0, 200),
    requestId: event.requestId.slice(0, 200),
    fingerprint: event.fingerprint.slice(0, 200),
    method: event.method.slice(0, 40),
    resourceType: event.resourceType.slice(0, 100),
    url: event.url.slice(0, 800),
    ...(status === undefined ? {} : { status }),
    ...(event.failure === undefined ? {} : { failure: event.failure.slice(0, 500) }),
  }
}

export function projectDiagnosticCompareOutput(input: {
  comparison: ReturnType<typeof compareCheckpoints>
  l3Comparison?: unknown
  diagnosticContext: unknown
}): LosslessJsonValue {
  // Compare 工具出口只组合已经投影的普通 DTO，并在跨越 DSH 工具边界前执行同等级无损检查。
  // 这样未来任何新增非法字段都会在插件测试中得到精确路径，而不会只在正式 Session 中模糊失败。
  const output = {
    ...input.comparison,
    ...(input.l3Comparison === undefined ? {} : { l3Comparison: input.l3Comparison }),
    diagnosticContext: input.diagnosticContext,
  }
  assertLosslessJson(output, 'data')
  return output
}

export function projectEvidence(events: readonly JournalEvent[]) {
  const errors = consoleEvents(events)
  const requests = failedRequests(events)
  return {
    eventCount: events.length,
    errors: errors.slice(-6).map(compactError),
    failedRequests: requests.slice(-8).map(compactRequest),
    actions: events.filter(event => event.kind === 'action').slice(-10),
  }
}

export function projectCorrelations(events: readonly JournalEvent[]) {
  const actions = events.filter((event): event is ActionJournalEvent => event.kind === 'action' && !event.toolName.startsWith('browser_diagnose')).slice(-10)
  const evidence = events.filter(event => event.kind === 'console' || event.kind === 'network')
  return actions.map(action => {
    const strongCandidates = evidence.filter(event => {
      return matchesActionIdentity(event, action)
        && event.wallTime >= action.startedAt
        && event.wallTime <= action.finishedAt
    })
    const temporalCandidates = evidence.filter(event => {
      return matchesActionIdentity(event, action)
        && event.wallTime > action.finishedAt
        && event.wallTime <= action.finishedAt + 2000
    })
    return {
      actionId: action.actionId,
      actionEventId: action.eventId,
      toolName: action.toolName,
      callId: action.callId,
      rootCallId: action.rootCallId,
      window: { startedAt: action.startedAt, finishedAt: action.finishedAt, graceMs: 2000 },
      confidence: (strongCandidates.length > 0 ? 'strong-candidate' : 'temporal-candidate') as ActionCorrelationConfidence,
      reason: strongCandidates.length > 0
        ? 'same action window, view, context generation, document generation, and navigation'
        : 'same view and document identity inside the bounded post-action grace window',
      evidenceEventIds: [...strongCandidates, ...temporalCandidates].slice(-20).map(event => event.eventId),
    }
  }).filter(value => value.evidenceEventIds.length > 0)
}

function compactTimelineEvent(event: ConsoleJournalEvent | NetworkJournalEvent) {
  if (event.kind === 'console') {
    return {
      eventId: event.eventId,
      kind: event.kind,
      severity: event.severity,
      fingerprint: event.fingerprint,
      source: event.source,
      level: event.level,
      text: event.text.slice(0, 500),
    }
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    severity: event.severity,
    fingerprint: event.fingerprint,
    requestId: event.requestId,
    method: event.method,
    resourceType: event.resourceType,
    url: event.url.slice(0, 800),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.failure === undefined ? {} : { failure: event.failure.slice(0, 500) }),
  }
}

export function projectActionTimeline(events: readonly JournalEvent[]) {
  const actions = events.filter((event): event is ActionJournalEvent => {
    return event.kind === 'action' && !event.toolName.startsWith('browser_diagnose')
  }).slice(-20)
  const evidence = events.filter((event): event is ConsoleJournalEvent | NetworkJournalEvent => {
    return event.kind === 'console' || event.kind === 'network'
  })
  return actions.map(action => {
    const strongCandidates = evidence.filter(event => {
      return matchesActionIdentity(event, action)
        && event.wallTime >= action.startedAt
        && event.wallTime <= action.finishedAt
    })
    const temporalCandidates = evidence.filter(event => {
      return matchesActionIdentity(event, action)
        && event.wallTime > action.finishedAt
        && event.wallTime <= action.finishedAt + 2000
    })
    const background = evidence.filter(event => {
      return event.wallTime >= action.startedAt
        && event.wallTime <= action.finishedAt + 2000
        && !strongCandidates.includes(event)
        && !temporalCandidates.includes(event)
    })
    return {
      schemaVersion: 2 as const,
      actionId: action.actionId,
      actionEventId: action.eventId,
      toolName: action.toolName,
      callId: action.callId,
      rootCallId: action.rootCallId,
      humanInitiated: action.humanInitiated,
      outcome: action.outcome,
      identity: {
        viewId: action.viewId,
        contextGeneration: action.contextGeneration,
        documentBefore: action.beforeDocumentGeneration ?? action.documentGeneration,
        documentAfter: action.afterDocumentGeneration ?? action.documentGeneration,
        navigationBefore: action.beforeNavigationId ?? action.navigationId,
        navigationAfter: action.afterNavigationId ?? action.navigationId,
      },
      window: { startedAt: action.startedAt, finishedAt: action.finishedAt, graceMs: 2000 },
      changeSignals: action.changeSignals ?? {},
      evidence: {
        confirmed: [],
        strongCandidates: strongCandidates.slice(-20).map(compactTimelineEvent),
        temporalCandidates: temporalCandidates.slice(-20).map(compactTimelineEvent),
        background: background.slice(-10).map(compactTimelineEvent),
        excluded: [],
      },
      remainingUncertainty: [
        ...(strongCandidates.length + temporalCandidates.length === 0 ? ['No bounded Console or Network evidence was observed for this action.'] : []),
        ...(strongCandidates.length > 0 ? ['Time and page identity support correlation, but no direct initiator or async stack proves unique causality.'] : []),
        ...(action.beforeNavigationId !== undefined && action.afterNavigationId !== undefined && action.beforeNavigationId !== action.afterNavigationId
          ? ['The action crossed a navigation boundary; evidence from the previous navigation is not strongly associated with the new document.']
          : []),
      ],
    }
  })
}

export function compareCheckpoints(before: DiagnosticCheckpoint, after: DiagnosticCheckpoint) {
  const degradations: string[] = []
  const beforeErrors = consoleEvents(before.events)
  const afterErrors = consoleEvents(after.events)
  const beforeRequests = failedRequests(before.events)
  const afterRequests = failedRequests(after.events)
  const beforeErrorFingerprints = fingerprints(beforeErrors)
  const afterErrorFingerprints = fingerprints(afterErrors)
  const beforeRequestFingerprints = fingerprints(beforeRequests)
  const afterRequestFingerprints = fingerprints(afterRequests)
  const persistentErrors = afterErrors.filter(value => beforeErrorFingerprints.has(value.fingerprint))
  const persistentRequests = afterRequests.filter(value => beforeRequestFingerprints.has(value.fingerprint))
  const addedErrors = difference(afterErrors, beforeErrorFingerprints)
  const removedErrors = difference(beforeErrors, afterErrorFingerprints)
  const addedRequests = difference(afterRequests, beforeRequestFingerprints)
  const removedRequests = difference(beforeRequests, afterRequestFingerprints)
  const beforeOverflow = finiteDiagnosticNumber(Math.max(0, before.page.rootScrollWidth - before.page.viewport.width), 'data.page.rootOverflowBefore', degradations)
  const afterOverflow = finiteDiagnosticNumber(Math.max(0, after.page.rootScrollWidth - after.page.viewport.width), 'data.page.rootOverflowAfter', degradations)
  const comparisonReasons: string[] = []
  if (before.viewId !== after.viewId) comparisonReasons.push('viewId differs')
  if (before.contextGeneration !== after.contextGeneration) comparisonReasons.push('contextGeneration differs')
  if (before.environment === undefined || after.environment === undefined) {
    comparisonReasons.push('environment snapshot is unavailable')
  } else {
    if (before.environment.url !== after.environment.url) comparisonReasons.push('document URL differs')
    if (before.environment.viewport.width !== after.environment.viewport.width
      || before.environment.viewport.height !== after.environment.viewport.height) comparisonReasons.push('viewport size differs')
    if (before.environment.deviceScaleFactor !== after.environment.deviceScaleFactor) comparisonReasons.push('device scale factor differs')
  }
  const comparable = comparisonReasons.length === 0
  const countVerdict = (beforeCount: number, afterCount: number): ComparisonVerdict => {
    if (!comparable) return 'incomparable'
    if (beforeCount > 0 && afterCount === 0) return 'fixed'
    if (afterCount < beforeCount) return 'improved'
    if (afterCount > beforeCount) return 'regressed'
    return 'unchanged'
  }
  const pageVerdict: ComparisonVerdict = !comparable
    ? 'incomparable'
    : beforeOverflow === undefined || afterOverflow === undefined
      ? 'evidence-insufficient'
    : beforeOverflow > 0 && afterOverflow === 0
      ? 'fixed'
      : afterOverflow < beforeOverflow
        ? 'improved'
        : afterOverflow > beforeOverflow
          ? 'regressed'
          : 'unchanged'
  const beforeTargetMatches = before.element?.hitTest?.targetMatches
  const afterTargetMatches = after.element?.hitTest?.targetMatches
  const beforeVisible = before.element?.visible
  const afterVisible = after.element?.visible
  const elementVerdict: ComparisonVerdict = !comparable
    ? 'incomparable'
    : before.element === undefined || after.element === undefined
      ? 'evidence-insufficient'
      : (beforeTargetMatches === false || beforeVisible === false) && afterTargetMatches === true && afterVisible === true
        ? 'fixed'
        : (beforeTargetMatches === true && afterTargetMatches === false) || (beforeVisible === true && afterVisible === false)
          ? 'regressed'
          : beforeTargetMatches !== afterTargetMatches || beforeVisible !== afterVisible
            ? 'improved'
            : 'unchanged'
  const consoleVerdict = countVerdict(beforeErrors.length, afterErrors.length)
  const networkVerdict = countVerdict(beforeRequests.length, afterRequests.length)
  const verdicts = {
    page: pageVerdict,
    element: elementVerdict,
    console: consoleVerdict,
    network: networkVerdict,
    performance: 'evidence-insufficient' as const,
  }
  const comparableVerdicts = Object.values(verdicts).filter(verdict => verdict !== 'evidence-insufficient')
  const overallVerdict: ComparisonVerdict = !comparable
    ? 'incomparable'
    : comparableVerdicts.includes('regressed')
      ? 'regressed'
      : comparableVerdicts.includes('fixed')
        ? 'fixed'
        : comparableVerdicts.includes('improved')
          ? 'improved'
          : 'unchanged'
  const beforeElement = projectElementSummary(before.element, 'data.element.before', degradations)
  const afterElement = projectElementSummary(after.element, 'data.element.after', degradations)
  const beforeBox = projectBox(before.element?.box, 'data.element.before.box', degradations)
  const afterBox = projectBox(after.element?.box, 'data.element.after.box', degradations)
  const comparison = {
    schemaVersion: 2 as const,
    before: before.checkpointId,
    after: after.checkpointId,
    comparability: { comparable, reasons: comparisonReasons },
    verdicts,
    overallVerdict,
    newRegressions: {
      errors: addedErrors.slice(-8).map((event, index) => projectConsoleComparisonEvent(event, `data.newRegressions.errors[${index}]`, degradations)),
      failedRequests: addedRequests.slice(-8).map((event, index) => projectNetworkComparisonEvent(event, `data.newRegressions.failedRequests[${index}]`, degradations)),
      elementOccluded: beforeTargetMatches === true && afterTargetMatches === false,
      rootOverflowIncreased: beforeOverflow !== undefined && afterOverflow !== undefined && afterOverflow > beforeOverflow,
    },
    page: {
      urlChanged: before.page.url !== after.page.url,
      titleChanged: before.page.title !== after.page.title,
      documentChanged: before.documentGeneration !== after.documentGeneration,
      ...(beforeOverflow === undefined ? {} : { rootOverflowBefore: beforeOverflow }),
      ...(afterOverflow === undefined ? {} : { rootOverflowAfter: afterOverflow }),
    },
    element: {
      ...(beforeElement === undefined ? {} : { before: beforeElement }),
      ...(afterElement === undefined ? {} : { after: afterElement }),
      visibilityChanged: before.element?.visible !== after.element?.visible,
      viewportIntersectionChanged: before.element?.viewportIntersection !== after.element?.viewportIntersection,
      boxChanged: !boxesEqual(beforeBox, afterBox),
    },
    console: {
      added: addedErrors.slice(-8).map((event, index) => projectConsoleComparisonEvent(event, `data.console.added[${index}]`, degradations)),
      removed: removedErrors.slice(-8).map((event, index) => projectConsoleComparisonEvent(event, `data.console.removed[${index}]`, degradations)),
      persistent: persistentErrors.slice(-8).map((event, index) => projectConsoleComparisonEvent(event, `data.console.persistent[${index}]`, degradations)),
    },
    network: {
      added: addedRequests.slice(-8).map((event, index) => projectNetworkComparisonEvent(event, `data.network.added[${index}]`, degradations)),
      removed: removedRequests.slice(-8).map((event, index) => projectNetworkComparisonEvent(event, `data.network.removed[${index}]`, degradations)),
      persistent: persistentRequests.slice(-8).map((event, index) => projectNetworkComparisonEvent(event, `data.network.persistent[${index}]`, degradations)),
    },
    degradations: [...new Set(degradations)].slice(0, 32),
  }
  assertLosslessJson(comparison, 'data')
  return comparison
}
