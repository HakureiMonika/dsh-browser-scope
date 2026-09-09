import assert from 'node:assert/strict'
import { buildCrossContextLinks, compareL3Checkpoints, createL3Checkpoint, evaluateClosureHealth } from '../src/l3-closure.ts'
const recorder = { recorderSchemaVersion: 1 as const, recorderId: 'r1', sessionId: 'a', sessionKey: 'a@1', mode: 'rolling' as const, status: 'recording' as const, retentionMs: 180000, eventCount: 2, chunkCount: 1, byteSize: 100, frozenIncidentIds: [], overload: 'normal' as const }
const context = { contextTopologySchemaVersion: 1 as const, sessionId: 'a', sessionKey: 'a@1', browserContextGeneration: 1, targets: [], frames: [{ frameId: 'f1', viewId: 'v1', targetId: 't1', mainFrame: true, url: 'https://app.test', origin: 'https://app.test', documentGeneration: 1, attached: true, oopif: false, confidence: 'confirmed' as const }], documents: [], executionContexts: [], degradations: [], truncated: { targets: false, frames: false, documents: false, executionContexts: false, degradations: false } }
const before = createL3Checkpoint({ contextTopology: context, recorder, builds: [], applications: [{ applicationId: 'app1', viewId: 'v1', kind: 'shell', name: 'Shell', buildIds: [], signals: ['main-frame'], counterEvidence: [], confidence: 'confirmed', active: true, detectedAt: 1 }], selectedApplicationId: 'app1', surface: { rendererType: 'html' }, degradations: [] })
const after = createL3Checkpoint({ contextTopology: context, recorder: { ...recorder, eventCount: 3 }, builds: [], applications: before.applications, selectedApplicationId: 'app1', surface: { rendererType: 'html' }, degradations: [] })
assert.equal(compareL3Checkpoints(before, after).verdict, 'stable')
assert.equal(compareL3Checkpoints(before, createL3Checkpoint({ ...after, surface: { rendererType: 'svg', tag: 'rect', clientRect: { x: 0, y: 0, width: 1, height: 1 }, fill: '', stroke: '', pointerEvents: 'all', pointerHit: true } })).verdict, 'incomparable')

// 旧证据两边都没有 Controller Identity 时继续沿用历史可比规则；上面的 stable 断言即为兼容门禁。
// 新证据必须同时匹配控制器 ID、激活代际和注册模式，避免跨控制器切换错误解释前后差异。
const sessionController = {
  id: 'dsh-browser-tools',
  generation: 2,
  registrationMode: 'session-select',
} as const
const controllerBefore = createL3Checkpoint({ ...before, controllerIdentity: sessionController })
const controllerAfter = createL3Checkpoint({ ...after, controllerIdentity: sessionController })
assert.equal(compareL3Checkpoints(controllerBefore, controllerAfter).verdict, 'stable')

const generationChanged = compareL3Checkpoints(
  controllerBefore,
  createL3Checkpoint({
    ...controllerAfter,
    controllerIdentity: { ...sessionController, generation: 3 },
  }),
)
assert.equal(generationChanged.verdict, 'incomparable')
assert.deepEqual(generationChanged.comparability.reasons, [
  'browser controller generation differs',
])

const registrationModeChanged = compareL3Checkpoints(
  controllerBefore,
  createL3Checkpoint({
    ...controllerAfter,
    controllerIdentity: { ...sessionController, registrationMode: 'global' },
  }),
)
assert.equal(registrationModeChanged.verdict, 'incomparable')
assert.deepEqual(registrationModeChanged.comparability.reasons, [
  'browser controller registration mode differs',
])

const identityMissingOnOneSide = compareL3Checkpoints(before, controllerAfter)
assert.equal(identityMissingOnOneSide.verdict, 'incomparable')
assert.deepEqual(identityMissingOnOneSide.comparability.reasons, [
  'browser controller identity differs',
  'browser controller generation differs',
  'browser controller registration mode differs',
])

const links = buildCrossContextLinks({ checkpointId: 'cp1', snapshot: before, actionIds: ['a1'], errorEventIds: ['j1'] })
assert.equal(links.some(link => link.relation === 'checkpoint-observes-context' && link.confidence === 'confirmed'), true)
assert.equal(links.filter(link => link.relation === 'surface-owned-by-application').length, 1)
const cleanClosure = evaluateClosureHealth({
  runtimeErrorCount: 0,
  failedRequestCount: 0,
  comparison: {
    overallVerdict: 'fixed',
    comparable: true,
    newRegressionCount: 0,
  },
})
assert.equal(cleanClosure.productClosureQualified, true)
const guardedClosure = evaluateClosureHealth({
  runtimeErrorCount: 1,
  failedRequestCount: 1,
})
assert.deepEqual(guardedClosure.blockers, [
  'runtime-errors-remain',
  'compare-missing',
  'failed-request-visible-outcome-unverified',
])
const serialized = JSON.stringify(before); (context.frames[0] as { frameId: string }).frameId = 'changed'; assert.equal(serialized, JSON.stringify(before))
process.stdout.write(`${JSON.stringify({ ok: true, stableCompare: true, incomparableSurface: true, crossContextLinks: true, closureGuardrail: true, immutable: true }, null, 2)}\n`)
