import type { DiagnosticCheckpoint, DebugSessionRecord } from './debug-session-store.ts'
import type { ActionJournalEvent, ConsoleJournalEvent, JournalEvent, NetworkJournalEvent } from './event-journal.ts'
import { evaluateClosureHealth } from './l3-closure.ts'

type EvidenceConfidence = 'confirmed' | 'correlated' | 'candidate' | 'excluded' | 'unavailable'

interface TimelineItem {
  actionId: string
  actionEventId: string
  toolName: string
  evidence: {
    confirmed: Array<{ eventId: string }>
    strongCandidates: Array<{ eventId: string }>
    temporalCandidates: Array<{ eventId: string }>
  }
}

interface SourceMappingInput {
  errorEventId?: string
  confidence?: string
  sourceMapId?: string
  build?: { buildId?: string }
  workspace?: { path?: string; confidence?: string }
  reason?: string
}

interface ComparisonInput {
  before?: string
  after?: string
  overallVerdict?: string
  comparability?: { comparable?: boolean; reasons?: string[] }
  newRegressions?: {
    errors?: Array<{ eventId?: string; fingerprint?: string; text?: string }>
    failedRequests?: Array<{ eventId?: string; requestId?: string; fingerprint?: string; method?: string; url?: string; status?: number }>
    elementOccluded?: boolean
    rootOverflowIncreased?: boolean
  }
}

export interface IncidentReportInput {
  debugSession: DebugSessionRecord
  events: readonly JournalEvent[]
  timeline: readonly TimelineItem[]
  checkpoints: readonly DiagnosticCheckpoint[]
  sourceMappings: readonly SourceMappingInput[]
  comparison?: ComparisonInput
  environment: {
    provider: string
    viewId: string
    contextGeneration: number
    documentGeneration: number
    navigationId: string
    url: string
  }
  generatedAt: number
}

function errors(events: readonly JournalEvent[]): ConsoleJournalEvent[] {
  return events.filter((event): event is ConsoleJournalEvent => event.kind === 'console' && event.severity === 'error')
}

function failedRequests(events: readonly JournalEvent[]): NetworkJournalEvent[] {
  return events.filter((event): event is NetworkJournalEvent => event.kind === 'network'
    && (event.failure !== undefined || (event.status !== undefined && event.status >= 400)))
}

function actions(events: readonly JournalEvent[]): ActionJournalEvent[] {
  return events.filter((event): event is ActionJournalEvent => event.kind === 'action')
}

function firstOffset(startedAt: number, values: readonly number[]): number | 'unavailable' {
  const first = values.filter(value => value >= startedAt).sort((left, right) => left - right).at(0)
  return first === undefined ? 'unavailable' : first - startedAt
}

function artifactManifest(checkpoints: readonly DiagnosticCheckpoint[]) {
  return checkpoints.flatMap(checkpoint => (checkpoint.artifactManifest ?? []).map((artifact, index) => ({
    manifestId: `${checkpoint.checkpointId}-artifact-${index + 1}`,
    checkpointId: checkpoint.checkpointId,
    kind: artifact.kind,
    reference: artifact.reference,
  })))
}

function referenceBytes(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('bytes' in value)) return 0
  return typeof value.bytes === 'number' && Number.isFinite(value.bytes) ? value.bytes : 0
}

export function buildIncidentReport(input: IncidentReportInput) {
  const reportStartedAt = performance.now()
  const runtimeErrors = errors(input.events).slice(-8)
  const requestFailures = failedRequests(input.events).slice(-8)
  const browserActions = actions(input.events)
  const triggerAction = browserActions.filter(action => !action.toolName.startsWith('browser_diagnose')).at(-1)
  const triggerTimeline = triggerAction === undefined ? undefined : input.timeline.find(item => item.actionId === triggerAction.actionId)
  const artifacts = artifactManifest(input.checkpoints)
  const comparisonNewRegressionCount = input.comparison === undefined
    ? 0
    : (input.comparison.newRegressions?.errors?.length ?? 0)
      + (input.comparison.newRegressions?.failedRequests?.length ?? 0)
      + Number(input.comparison.newRegressions?.elementOccluded === true)
      + Number(input.comparison.newRegressions?.rootOverflowIncreased === true)
  const closure = evaluateClosureHealth({
    runtimeErrorCount: runtimeErrors.length,
    failedRequestCount: requestFailures.length,
    ...(input.comparison === undefined ? {} : {
      comparison: {
        overallVerdict: input.comparison.overallVerdict,
        comparable: input.comparison.comparability?.comparable,
        newRegressionCount: comparisonNewRegressionCount,
      },
    }),
  })
  const facts = [
    ...runtimeErrors.map((event, index) => ({
      evidenceId: `fact-error-${index + 1}`,
      kind: 'runtime-error' as const,
      confidence: 'confirmed' as EvidenceConfidence,
      claim: `${event.source} ${event.level}: ${event.text.slice(0, 500)}`,
      eventIds: [event.eventId],
    })),
    ...requestFailures.map((event, index) => ({
      evidenceId: `fact-request-${index + 1}`,
      kind: 'failed-request' as const,
      confidence: 'confirmed' as EvidenceConfidence,
      claim: `${event.method} ${event.url.slice(0, 800)} ${event.failure ?? event.status ?? 'failed'}`,
      eventIds: [event.eventId],
    })),
    ...input.sourceMappings.filter(mapping => mapping.sourceMapId !== undefined).slice(-8).map((mapping, index) => ({
      evidenceId: `fact-source-map-${index + 1}`,
      kind: 'source-mapping' as const,
      confidence: mapping.confidence === 'confirmed' ? 'confirmed' as EvidenceConfidence : 'candidate' as EvidenceConfidence,
      claim: mapping.workspace?.path === undefined
        ? `Source mapping ${mapping.sourceMapId} is ${mapping.confidence ?? 'unavailable'}.`
        : `Source mapping ${mapping.sourceMapId} points to ${mapping.workspace.path} as ${mapping.workspace.confidence ?? 'candidate'}.`,
      eventIds: mapping.errorEventId === undefined ? [] : [mapping.errorEventId],
      sourceMapId: mapping.sourceMapId,
    })),
  ]
  const correlatedEventIds = triggerTimeline === undefined
    ? []
    : [...triggerTimeline.evidence.strongCandidates, ...triggerTimeline.evidence.temporalCandidates].map(event => event.eventId)
  const causalCandidates = triggerAction === undefined || correlatedEventIds.length === 0
    ? []
    : [{
        candidateId: 'cause-1',
        claim: `Events after ${triggerAction.toolName} are correlated with the same bounded action and page identity.`,
        predecessorEventIds: [triggerAction.eventId],
        consequenceEventIds: correlatedEventIds.slice(0, 20),
        evidenceIds: facts.filter(fact => fact.eventIds.some(eventId => correlatedEventIds.includes(eventId))).map(fact => fact.evidenceId),
        confidence: 'correlated' as EvidenceConfidence,
        counterEvidenceIds: [],
        missingEvidence: ['Direct request initiator, async stack, or debugger call-path evidence is unavailable.'],
      }]
  const screenshotCheckpoints = input.checkpoints.filter(checkpoint => (checkpoint.artifactManifest?.length ?? 0) > 0)
  const generatedAt = input.generatedAt
  const costs = {
    debugSessionDurationMs: Math.max(0, generatedAt - input.debugSession.startedAt),
    timeToFirstRuntimeErrorMs: firstOffset(input.debugSession.startedAt, runtimeErrors.map(event => event.wallTime)),
    timeToFirstCheckpointMs: firstOffset(input.debugSession.startedAt, input.checkpoints.map(checkpoint => checkpoint.createdAt)),
    timeToFirstVisualEvidenceMs: firstOffset(input.debugSession.startedAt, screenshotCheckpoints.map(checkpoint => checkpoint.createdAt)),
    browserToolCalls: browserActions.filter(action => !action.humanInitiated).length,
    screenshotCount: screenshotCheckpoints.length,
    snapshotCount: browserActions.filter(action => action.toolName === 'browser_snapshot').length,
    evaluateCount: browserActions.filter(action => action.toolName === 'browser_evaluate').length,
    pageReloadCount: browserActions.filter(action => action.toolName === 'browser_navigate_back' || action.toolName === 'browser_navigate').length,
    takeoverCount: browserActions.filter(action => action.humanInitiated).length,
    checkpointCount: input.checkpoints.length,
    artifactCount: artifacts.length,
    artifactBytes: artifacts.reduce((total, artifact) => total + referenceBytes(artifact.reference), 0),
    browserContextCount: 'unavailable' as const,
    workspaceFixDurationMs: 'unavailable' as const,
    externalBrowserFallback: input.environment.provider === 'external-cdp',
  }
  // Closure 推荐项直接来自机器可观察事实：业务非 2xx 需要场景 Oracle 复核可见结果，
  // 页面错误必须归零，且修复前后 Checkpoint 必须完成可比且无新增关键回归的 Compare。
  // 这里不猜测具体业务文案，只提示调用方继续补齐对应闭环证据。
  const recommendedNextChecks = [
    ...(input.checkpoints.length < 2 ? ['create before and after checkpoints'] : []),
    ...(input.comparison === undefined ? ['compare before and after checkpoints'] : []),
    ...(input.sourceMappings.length === 0 || input.sourceMappings.every(mapping => mapping.confidence === 'unavailable') ? ['map a current-document runtime error'] : []),
    ...(causalCandidates.length === 0 ? ['capture an action with bounded runtime evidence'] : []),
    ...(input.comparison?.comparability?.comparable === false ? ['repeat the same scenario with matching URL, viewport, DPR, and context'] : []),
    ...(closure.failedRequestReviewRequired
      ? ['verify every business non-2xx response has a controlled visible outcome']
      : []),
    ...(closure.runtimeCleanQualified
      ? []
      : ['remove remaining page runtime errors and unhandled rejections']),
    ...(closure.compareQualified
      ? []
      : ['complete a comparable checkpoint comparison without new critical regressions']),
  ]
  const incident = {
    schemaVersion: 2 as const,
    incidentId: `incident-${input.debugSession.debugSessionId}`,
    debugSessionId: input.debugSession.debugSessionId,
    sessionId: input.debugSession.dshSessionId,
    title: triggerAction === undefined ? 'Frontend diagnostic session' : `Frontend incident after ${triggerAction.toolName}`,
    ...(triggerAction === undefined ? {} : { triggerActionId: triggerAction.actionId }),
    environment: input.environment,
    buildIds: [...new Set(input.sourceMappings.map(mapping => mapping.build?.buildId).filter((value): value is string => value !== undefined))],
    symptom: {
      runtimeErrorCount: runtimeErrors.length,
      failedRequestCount: requestFailures.length,
      compareVerdict: input.comparison?.overallVerdict ?? 'unavailable',
    },
    facts,
    causalCandidates,
    sourceMappings: input.sourceMappings,
    ...(input.comparison?.before === undefined ? {} : { beforeCheckpointId: input.comparison.before }),
    ...(input.comparison?.after === undefined ? {} : { afterCheckpointId: input.comparison.after }),
    verification: {
      status: input.comparison?.overallVerdict ?? 'unavailable',
      comparable: input.comparison?.comparability?.comparable ?? false,
      newRegressions: input.comparison?.newRegressions ?? null,
    },
    closure,
    remainingUncertainty: [
      ...causalCandidates.flatMap(candidate => candidate.missingEvidence),
      ...input.sourceMappings.filter(mapping => mapping.confidence === 'unavailable').map(mapping => mapping.reason ?? 'Source mapping unavailable.'),
    ].slice(0, 12),
    recommendedNextChecks: recommendedNextChecks.slice(0, 8),
    costs,
    generatedAt,
  }
  const markdown = [
    `# ${incident.title}`,
    '',
    `- Incident: ${incident.incidentId}`,
    `- Debug Session: ${incident.debugSessionId}`,
    `- View: ${incident.environment.viewId}`,
    `- Document / Navigation: ${incident.environment.documentGeneration} / ${incident.environment.navigationId}`,
    `- Compare Verdict: ${incident.verification.status}`,
    `- Product Closure Qualified: ${incident.closure.productClosureQualified}`,
    `- Closure Blockers: ${incident.closure.blockers.length === 0 ? 'none' : incident.closure.blockers.join(', ')}`,
    '',
    '## Facts',
    ...incident.facts.map(fact => `- [${fact.evidenceId}] ${fact.claim}`),
    '',
    '## Causal Candidates',
    ...(incident.causalCandidates.length === 0
      ? ['- No bounded causal candidate is available.']
      : incident.causalCandidates.map(candidate => `- [${candidate.candidateId}] (${candidate.confidence}) ${candidate.claim}`)),
    '',
    '## Remaining Uncertainty',
    ...(incident.remainingUncertainty.length === 0 ? ['- None recorded.'] : incident.remainingUncertainty.map(value => `- ${value}`)),
    '',
    '## Recommended Next Checks',
    ...(incident.recommendedNextChecks.length === 0 ? ['- No additional bounded check is required.'] : incident.recommendedNextChecks.map(value => `- ${value}`)),
  ].join('\n')
  const reportBytes = Buffer.byteLength(JSON.stringify({ incident, markdown, artifactManifest: artifacts }))
  const reportGenerationDurationMs = Math.max(0, performance.now() - reportStartedAt)
  return {
    incident: { ...incident, costs: { ...costs, reportGenerationDurationMs, reportBytes } },
    markdown,
    artifactManifest: artifacts,
  }
}
