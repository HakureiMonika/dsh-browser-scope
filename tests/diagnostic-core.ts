import assert from 'node:assert/strict'
import { DebugSessionStore } from '../src/debug-session-store.ts'
import { compareCheckpoints, projectActionTimeline, projectCorrelations, projectDiagnosticCompareOutput, projectEvidence } from '../src/diagnostic-projector.ts'
import { EventJournal } from '../src/event-journal.ts'
import { buildIncidentReport } from '../src/incident-report.ts'
import { findLosslessJsonViolation } from '../src/lossless-json.ts'
import { parseGeneratedLocation, resolveSourceMap } from '../src/source-map-resolver.ts'

const journal = new EventJournal(100)
const scope = { sessionId: 'dsh-session-a', sessionKey: 'session-a', viewId: 'v1', contextGeneration: 1, documentGeneration: 2, navigationId: 'v1-n1', targetId: 'target-a', frameId: 'frame-a', frameDocumentGeneration: 4, executionContextId: 7, worldType: 'main' as const, loaderId: 'loader-a' }
const firstRequest = {}
const secondRequest = {}
journal.startNetwork({ ...scope, request: firstRequest, method: 'POST', url: 'http://127.0.0.1/api/rules', resourceType: 'fetch' })
journal.startNetwork({ ...scope, request: secondRequest, method: 'POST', url: 'http://127.0.0.1/api/rules', resourceType: 'fetch' })
journal.recordResponse(secondRequest, 409)
journal.recordResponse(firstRequest, 200)
journal.recordRequestFinished(firstRequest)
journal.recordRequestFinished(secondRequest)
const requests = journal.events(scope.sessionKey).filter(event => event.kind === 'network')
assert.equal(requests.length, 2)
assert.equal(requests[0]?.status, 200)
assert.equal(requests[1]?.status, 409)
assert.equal(requests[0]?.targetId, scope.targetId)
assert.equal(requests[0]?.frameId, scope.frameId)
assert.equal(requests[0]?.frameDocumentGeneration, scope.frameDocumentGeneration)

const redirectRequest = {}
journal.startNetwork({ ...scope, request: redirectRequest, redirectFrom: firstRequest, method: 'GET', url: 'http://127.0.0.1/rules', resourceType: 'document' })
const redirect = journal.events(scope.sessionKey).find(event => event.kind === 'network' && event.url === 'http://127.0.0.1/rules')
assert.equal(redirect?.kind === 'network' ? redirect.redirectFromRequestId : undefined, requests[0]?.requestId)

const sensitiveRequest = {}
journal.startNetwork({ ...scope, request: sensitiveRequest, method: 'GET', url: 'http://127.0.0.1/diagnostic-fail?token=visible-secret', resourceType: 'fetch' })
journal.recordRequestFailure(sensitiveRequest, 'request failed authorization=visible-secret')
const sanitizedRequest = journal.events(scope.sessionKey).find(event => event.kind === 'network' && event.url.includes('/diagnostic-fail'))
assert.equal(sanitizedRequest?.kind === 'network' ? sanitizedRequest.url.includes('visible-secret') : true, false)
assert.equal(sanitizedRequest?.kind === 'network' ? sanitizedRequest.url.includes('REDACTED') : false, true)
assert.equal(sanitizedRequest?.kind === 'network' ? sanitizedRequest.failure?.includes('visible-secret') : true, false)

const firstError = journal.recordConsole({ ...scope, source: 'pageerror', level: 'error', text: 'broken', stack: 'Error: broken\n at save (http://127.0.0.1/assets/app.js:1:1)' })
const secondError = journal.recordConsole({ ...scope, source: 'pageerror', level: 'error', text: 'broken', stack: 'Error: broken\n at save (http://127.0.0.1/assets/app.js:1:1)' })
assert.equal(firstError.repeatCount, 1)
assert.equal(secondError.repeatCount, 2)
assert.notEqual(firstError.eventId, secondError.eventId)
assert.equal(firstError.executionContextId, scope.executionContextId)
const script = journal.recordScript({ ...scope, scriptId: 'script-a', url: 'http://127.0.0.1/assets/app.js', sourceMapUrl: 'http://127.0.0.1/assets/app.js.map', startLine: 0, startColumn: 0, endLine: 10, endColumn: 0 })

const firstAction = journal.recordAction({ ...scope, callId: 'call-1', rootCallId: 'root-1', toolName: 'browser_click', humanInitiated: false, startedAt: firstError.wallTime - 10, finishedAt: firstError.wallTime + 10, outcome: 'ok' })
const nextNavigationError = journal.recordConsole({ ...scope, documentGeneration: 3, navigationId: 'v1-n2', source: 'pageerror', level: 'error', text: 'next-navigation-error' })
const evidence = journal.events(scope.sessionKey)
assert.equal(projectEvidence(evidence).failedRequests.length, 2)
assert.equal(projectCorrelations(evidence).some(value => value.evidenceEventIds.includes(firstError.eventId)), true)
assert.equal(firstAction.actionId, 'a1')
assert.equal(firstAction.schemaVersion, 2)
assert.equal(firstAction.sessionId, scope.sessionId)
assert.equal(firstAction.navigationId, scope.navigationId)
assert.equal(firstAction.severity, 'info')
assert.equal(firstAction.relatedEventIds.includes(firstError.eventId), true)
assert.equal(firstAction.relatedEventIds.includes(script.eventId), false)
assert.equal(firstAction.frameId, scope.frameId)
const firstTimeline = projectActionTimeline(evidence).find(item => item.actionId === firstAction.actionId)
assert.equal(firstTimeline?.evidence.strongCandidates.some(event => event.eventId === firstError.eventId), true)
assert.equal(firstTimeline?.evidence.strongCandidates.some(event => event.eventId === nextNavigationError.eventId), false)
assert.equal(firstTimeline?.evidence.background.some(event => event.eventId === nextNavigationError.eventId), true)
assert.equal(firstTimeline?.evidence.confirmed.length, 0)

journal.migrateSession('session-a', 'session-final')
assert.equal(journal.events('session-a').length, 0)
assert.equal(journal.events('session-final').every(event => event.sessionKey === 'session-final'), true)
assert.equal(journal.events('session-final').every(event => event.sessionId === scope.sessionId), true)
assert.equal(journal.action('session-final', firstAction.actionId)?.eventId, firstAction.eventId)

const store = new DebugSessionStore()
const debugSession = store.start({ sessionKey: 'session-final', dshSessionId: scope.sessionId, viewId: 'v1', contextGeneration: 1, documentGeneration: 2, navigationId: 'v1-n1', startedAt: Date.now(), startedCursor: { sequence: 0 } })
assert.equal(debugSession.schemaVersion, 2)
assert.equal(debugSession.status, 'active')
const checkpointEnvironment = {
  provider: 'managed-persistent',
  controlOwner: 'model' as const,
  url: 'http://127.0.0.1/',
  viewport: { width: 560, height: 760, generation: 1 },
  deviceScaleFactor: 1,
  scroll: { x: 0, y: 0 },
  contextGeneration: 1,
  documentGeneration: 2,
  navigationId: 'v1-n1',
}
const before = store.checkpoint('session-final', {
  label: 'before', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 2, navigationId: 'v1-n1', cursor: { sequence: 1 },
  environment: checkpointEnvironment,
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 1 }, rootScrollWidth: 720 },
  element: { ref: 'e1', visible: false, viewportIntersection: false, styles: {}, clippingAncestors: [], hitTest: { point: { x: 10, y: 10 }, topElement: null, targetMatches: false, occlusionChain: [] } }, events: evidence,
})
const after = store.checkpoint('session-final', {
  label: 'after', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 3, navigationId: 'v1-n2', cursor: { sequence: 2 },
  environment: { ...checkpointEnvironment, documentGeneration: 3, navigationId: 'v1-n2' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 2 }, rootScrollWidth: 560 },
  element: { ref: 'e2', visible: true, viewportIntersection: true, styles: {}, clippingAncestors: [], hitTest: { point: { x: 10, y: 10 }, topElement: null, targetMatches: true, occlusionChain: [] } }, events: [],
})
assert.equal(before.schemaVersion, 2)
assert.equal(after.navigationId, 'v1-n2')
store.updateDocument('session-final', 3, 'v1-n2')
assert.equal(store.require('session-final').documentGeneration, 3)
assert.equal(store.require('session-final').navigationId, 'v1-n2')
const comparison = compareCheckpoints(before, after)
assert.equal(comparison.page.rootOverflowBefore, 160)
assert.equal(comparison.page.rootOverflowAfter, 0)
assert.equal(comparison.element.visibilityChanged, true)
assert.equal(comparison.console.removed.length >= 1, true)
assert.equal(comparison.comparability.comparable, true)
assert.equal(comparison.verdicts.page, 'fixed')
assert.equal(comparison.verdicts.element, 'fixed')
assert.equal(comparison.verdicts.console, 'fixed')
assert.equal(comparison.verdicts.network, 'fixed')
assert.equal(comparison.verdicts.performance, 'evidence-insufficient')
assert.equal(comparison.overallVerdict, 'fixed')

const pageOnlyBefore = store.checkpoint('session-final', {
  label: 'page-only-before', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 3, navigationId: 'v1-n2', cursor: { sequence: 2 },
  environment: { ...checkpointEnvironment, documentGeneration: 3, navigationId: 'v1-n2' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 2 }, rootScrollWidth: 560 },
  events: [],
})
const pageOnlyAfter = store.checkpoint('session-final', {
  label: 'page-only-after', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 3, navigationId: 'v1-n2', cursor: { sequence: 2 },
  environment: { ...checkpointEnvironment, documentGeneration: 3, navigationId: 'v1-n2' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 2 }, rootScrollWidth: 560 },
  events: [],
})
const pageOnlyComparison = compareCheckpoints(pageOnlyBefore, pageOnlyAfter)
assert.equal(Object.hasOwn(pageOnlyComparison.element, 'before'), false)
assert.equal(Object.hasOwn(pageOnlyComparison.element, 'after'), false)
assert.equal(pageOnlyComparison.verdicts.element, 'evidence-insufficient')
assert.deepEqual(JSON.parse(JSON.stringify(pageOnlyComparison)), pageOnlyComparison)

const regressed = store.checkpoint('session-final', {
  label: 'regressed', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 4, navigationId: 'v1-n3', cursor: { sequence: 3 },
  environment: { ...checkpointEnvironment, documentGeneration: 4, navigationId: 'v1-n3' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 3 }, rootScrollWidth: 760 },
  element: { ref: 'e3', visible: true, viewportIntersection: true, styles: {}, clippingAncestors: [], hitTest: { point: { x: 10, y: 10 }, topElement: null, targetMatches: false, occlusionChain: [] } }, events: evidence,
})
const regressionComparison = compareCheckpoints(after, regressed)
assert.equal(regressionComparison.overallVerdict, 'regressed')
assert.equal(regressionComparison.verdicts.page, 'regressed')
assert.equal(regressionComparison.verdicts.element, 'regressed')
assert.equal(regressionComparison.newRegressions.errors.length >= 1, true)
assert.equal(regressionComparison.newRegressions.failedRequests.length >= 1, true)
assert.equal(regressionComparison.newRegressions.elementOccluded, true)
assert.equal(regressionComparison.newRegressions.rootOverflowIncreased, true)

const incomparable = store.checkpoint('session-final', {
  label: 'incomparable', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 5, navigationId: 'v1-n4', cursor: { sequence: 4 },
  environment: { ...checkpointEnvironment, viewport: { width: 768, height: 760, generation: 4 }, documentGeneration: 5, navigationId: 'v1-n4' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 768, height: 760, generation: 4 }, rootScrollWidth: 768 },
  element: { ref: 'e4', visible: true, viewportIntersection: true, styles: {}, clippingAncestors: [] }, events: [],
})
const incomparableComparison = compareCheckpoints(after, incomparable)
assert.equal(incomparableComparison.comparability.comparable, false)
assert.equal(incomparableComparison.comparability.reasons.includes('viewport size differs'), true)
assert.equal(incomparableComparison.overallVerdict, 'incomparable')

assert.equal(findLosslessJsonViolation(pageOnlyComparison), undefined)

const oneSidedComparison = compareCheckpoints(before, pageOnlyAfter)
assert.equal(Object.hasOwn(oneSidedComparison.element, 'before'), true)
assert.equal(Object.hasOwn(oneSidedComparison.element, 'after'), false)
assert.equal(findLosslessJsonViolation(oneSidedComparison), undefined)

const negativeZeroCheckpoint = store.checkpoint('session-final', {
  label: 'negative-zero', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 8, navigationId: 'v1-n7', cursor: { sequence: 7 },
  environment: { ...checkpointEnvironment, documentGeneration: 8, navigationId: 'v1-n7' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 7 }, rootScrollWidth: 560 },
  element: { ref: 'e-negative-zero', visible: true, viewportIntersection: true, box: { x: -0, y: 0, width: 10, height: 10 }, styles: {}, clippingAncestors: [] }, events: [],
})
const normalizedComparison = compareCheckpoints(negativeZeroCheckpoint, negativeZeroCheckpoint)
assert.equal(Object.is(normalizedComparison.element.before?.box?.x, -0), false)
assert.equal(normalizedComparison.element.before?.box?.x, 0)
assert.equal(findLosslessJsonViolation(normalizedComparison), undefined)

const nonFiniteCheckpoint = store.checkpoint('session-final', {
  label: 'non-finite', createdAt: Date.now(), viewId: 'v1', contextGeneration: 1, documentGeneration: 9, navigationId: 'v1-n8', cursor: { sequence: 8 },
  environment: { ...checkpointEnvironment, documentGeneration: 9, navigationId: 'v1-n8' },
  page: { url: 'http://127.0.0.1/', title: 'Rules', viewport: { width: 560, height: 760, generation: 8 }, rootScrollWidth: 560 },
  element: { ref: 'e-non-finite', visible: true, viewportIntersection: true, box: { x: Number.NaN, y: 0, width: 10, height: 10 }, styles: {}, clippingAncestors: [] }, events: [],
})
const degradedComparison = compareCheckpoints(nonFiniteCheckpoint, nonFiniteCheckpoint)
assert.equal(Object.hasOwn(degradedComparison.element.before ?? {}, 'box'), false)
assert.equal(degradedComparison.degradations.some(value => value.includes('data.element.before.box.x')), true)
assert.equal(findLosslessJsonViolation(degradedComparison), undefined)

const projectedComparison = projectDiagnosticCompareOutput({ comparison: pageOnlyComparison, diagnosticContext: { schemaVersion: 2 } })
assert.equal(findLosslessJsonViolation(projectedComparison), undefined)
assert.equal(findLosslessJsonViolation({ element: { before: undefined } }), 'data.element.before contains undefined')
assert.equal(findLosslessJsonViolation({ context: { beforeTargetCount: -0 } }), 'data.context.beforeTargetCount contains -0')
assert.equal(findLosslessJsonViolation({ values: [1, Number.POSITIVE_INFINITY] }), 'data.values[1] contains a non-finite number')
const sparseValues = new Array(2)
sparseValues[1] = 'present'
assert.equal(findLosslessJsonViolation({ values: sparseValues }), 'data.values is sparse or has extra own properties')
assert.equal(findLosslessJsonViolation({ values: new Map() }), 'data.values is not a plain object')
const circular: Record<string, unknown> = {}
circular.self = circular
assert.equal(findLosslessJsonViolation(circular), 'data.self contains a circular reference')

before.artifactManifest = [{ kind: 'screenshot', reference: { attachmentId: 'sha256:test', bytes: 128 } }]
const incidentReport = buildIncidentReport({
  debugSession,
  events: evidence,
  timeline: projectActionTimeline(evidence),
  checkpoints: [before, after],
  sourceMappings: [{ errorEventId: firstError.eventId, confidence: 'confirmed', sourceMapId: 'sm-test', build: { buildId: 'build-test' }, workspace: { path: 'src/save-rule.ts', confidence: 'mapped-workspace-unconfirmed' } }],
  comparison,
  environment: { provider: 'managed-persistent', viewId: 'v1', contextGeneration: 1, documentGeneration: 3, navigationId: 'v1-n2', url: 'http://127.0.0.1/' },
  generatedAt: debugSession.startedAt + 500,
})
assert.equal(incidentReport.incident.schemaVersion, 2)
assert.equal(incidentReport.incident.facts.some(fact => fact.eventIds.includes(firstError.eventId)), true)
assert.equal(incidentReport.incident.causalCandidates[0]?.confidence, 'correlated')
assert.equal(incidentReport.incident.buildIds.includes('build-test'), true)
assert.equal(incidentReport.incident.costs.browserContextCount, 'unavailable')
assert.equal(incidentReport.incident.costs.workspaceFixDurationMs, 'unavailable')
assert.equal(incidentReport.incident.costs.artifactCount, 1)
assert.equal(incidentReport.incident.costs.artifactBytes, 128)
assert.equal(incidentReport.artifactManifest[0]?.checkpointId, before.checkpointId)
assert.equal(incidentReport.markdown.includes(incidentReport.incident.incidentId), true)
assert.equal(incidentReport.markdown.includes(incidentReport.incident.facts[0]?.evidenceId ?? 'missing'), true)

const incidentWithoutComparison = buildIncidentReport({
  debugSession,
  events: evidence,
  timeline: projectActionTimeline(evidence),
  checkpoints: [before],
  sourceMappings: [],
  environment: { provider: 'managed-persistent', viewId: 'v1', contextGeneration: 1, documentGeneration: 3, navigationId: 'v1-n2', url: 'http://127.0.0.1/' },
  generatedAt: debugSession.startedAt + 500,
})
assert.deepEqual(JSON.parse(JSON.stringify(incidentWithoutComparison)), incidentWithoutComparison)

const generated = parseGeneratedLocation('TypeError: broken\n at save (http://127.0.0.1/assets/app.js:1:1)')
assert.deepEqual(generated, { url: 'http://127.0.0.1/assets/app.js', line: 1, column: 0 })
const sourceMapFixture = {
  version: 3,
  file: 'app.js',
  names: [],
  sources: ['../src/save-rule.ts'],
  sourcesContent: ['export function saveRule() {}'],
  mappings: 'AAAA',
}
const mapping = resolveSourceMap(generated, 'http://127.0.0.1/assets/app.js.map', sourceMapFixture, {
  documentUrl: 'http://127.0.0.1/rules',
  generatedContentSha256: 'generated-a',
})
const nextBuildMapping = resolveSourceMap(generated, 'http://127.0.0.1/assets/app.js.map', sourceMapFixture, {
  documentUrl: 'http://127.0.0.1/rules',
  generatedContentSha256: 'generated-b',
})
assert.equal(mapping.confidence, 'confirmed')
assert.equal(mapping.schemaVersion, 2)
assert.equal(mapping.workspace?.path, 'src/save-rule.ts')
assert.equal(mapping.workspace?.confidence, 'mapped-workspace-unconfirmed')
assert.equal(typeof mapping.sourceMapId, 'string')
assert.equal(typeof mapping.build?.buildId, 'string')
assert.equal(mapping.build?.generatedContentSha256, 'generated-a')
assert.notEqual(mapping.build?.buildId, nextBuildMapping.build?.buildId)
assert.equal(mapping.original?.source, '../src/save-rule.ts')
assert.equal(mapping.original?.line, 1)
assert.equal(requests[1]?.status, 409)

process.stdout.write(`${JSON.stringify({
  ok: true,
  concurrentRequestIds: requests.map(request => request.requestId),
  concurrentStatuses: requests.map(request => request.status),
  redirectFromRequestId: redirect?.kind === 'network' ? redirect.redirectFromRequestId : undefined,
  repeatedErrorCount: secondError.repeatCount,
  actionId: firstAction.actionId,
  correlationCount: projectCorrelations(evidence).length,
  actionTimelineCount: projectActionTimeline(evidence).length,
  comparison: { rootOverflowBefore: comparison.page.rootOverflowBefore, rootOverflowAfter: comparison.page.rootOverflowAfter, visibilityChanged: comparison.element.visibilityChanged, overallVerdict: comparison.overallVerdict, regressionVerdict: regressionComparison.overallVerdict, incomparableVerdict: incomparableComparison.overallVerdict },
  incident: { incidentId: incidentReport.incident.incidentId, factCount: incidentReport.incident.facts.length, causalCandidateCount: incidentReport.incident.causalCandidates.length, artifactCount: incidentReport.artifactManifest.length },
  sourceMap: mapping,
}, null, 2)}\n`)
