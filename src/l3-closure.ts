import type { ApplicationIdentity } from './application-registry.ts'
import type { BuildIdentity } from './build-registry.ts'
import type { ContextTopologySnapshot } from './context-identity.ts'
import type { RecorderSnapshot } from './flight-recorder.ts'
import type { SurfaceEvidence } from './surface-evidence.ts'

export interface BrowserControllerIdentity {
  id: 'dsh-browser-tools'
  generation: number
  registrationMode: 'global' | 'session-select'
}

export interface L3CheckpointSnapshot {
  l3CheckpointSchemaVersion: 1
  controllerIdentity?: BrowserControllerIdentity
  contextTopology?: ContextTopologySnapshot
  recorder: RecorderSnapshot
  builds: BuildIdentity[]
  applications: ApplicationIdentity[]
  selectedApplicationId?: string
  surface?: SurfaceEvidence
  degradations: string[]
}

export interface CrossContextLink {
  linkId: string
  relation: 'surface-owned-by-application' | 'script-loaded-by-application' | 'error-thrown-by-build' | 'checkpoint-observes-context' | 'request-initiated-by-action'
  fromId: string
  toId: string
  evidenceIds: string[]
  confidence: 'confirmed' | 'correlated'
}

function immutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createL3Checkpoint(input: Omit<L3CheckpointSnapshot, 'l3CheckpointSchemaVersion'>): L3CheckpointSnapshot {
  return immutable({ l3CheckpointSchemaVersion: 1, ...input })
}

export function compareL3Checkpoints(before: L3CheckpointSnapshot, after: L3CheckpointSnapshot) {
  const reasons: string[] = []
  if (before.controllerIdentity?.id !== after.controllerIdentity?.id) reasons.push('browser controller identity differs')
  if (before.controllerIdentity?.generation !== after.controllerIdentity?.generation) reasons.push('browser controller generation differs')
  if (before.controllerIdentity?.registrationMode !== after.controllerIdentity?.registrationMode) reasons.push('browser controller registration mode differs')
  const beforeMain = before.contextTopology?.frames.find(frame => frame.mainFrame)
  const afterMain = after.contextTopology?.frames.find(frame => frame.mainFrame)
  if (before.contextTopology?.browserContextGeneration !== after.contextTopology?.browserContextGeneration) reasons.push('browser context generation differs')
  if (beforeMain?.frameId !== afterMain?.frameId) reasons.push('main frame identity differs')
  if (before.surface?.rendererType !== after.surface?.rendererType) reasons.push('surface renderer differs')
  const beforeApps = new Set(before.applications.filter(item => item.active).map(item => item.applicationId))
  const afterApps = new Set(after.applications.filter(item => item.active).map(item => item.applicationId))
  const beforeBuilds = new Set(before.builds.filter(item => item.active).map(item => item.buildId))
  const afterBuilds = new Set(after.builds.filter(item => item.active).map(item => item.buildId))
  const addedApplications = [...afterApps].filter(value => !beforeApps.has(value))
  const removedApplications = [...beforeApps].filter(value => !afterApps.has(value))
  const addedBuilds = [...afterBuilds].filter(value => !beforeBuilds.has(value))
  const removedBuilds = [...beforeBuilds].filter(value => !afterBuilds.has(value))
  return {
    l3CompareSchemaVersion: 1 as const,
    comparability: { comparable: reasons.length === 0, reasons },
    context: { beforeTargetCount: before.contextTopology?.targets.length ?? 0, afterTargetCount: after.contextTopology?.targets.length ?? 0, beforeFrameCount: before.contextTopology?.frames.length ?? 0, afterFrameCount: after.contextTopology?.frames.length ?? 0 },
    applications: { added: addedApplications, removed: removedApplications },
    builds: { added: addedBuilds, removed: removedBuilds },
    surface: {
      ...(before.surface === undefined ? {} : { before: before.surface.rendererType }),
      ...(after.surface === undefined ? {} : { after: after.surface.rendererType }),
    },
    recorder: { beforeEvents: before.recorder.eventCount, afterEvents: after.recorder.eventCount, frozenIncidentIds: after.recorder.frozenIncidentIds },
    verdict: reasons.length > 0 ? 'incomparable' as const : addedApplications.length + removedApplications.length + addedBuilds.length + removedBuilds.length === 0 ? 'stable' as const : 'changed' as const,
  }
}

export interface ClosureHealthInput {
  runtimeErrorCount: number
  failedRequestCount: number
  comparison?: {
    overallVerdict?: string
    comparable?: boolean
    newRegressionCount?: number
  }
}

export interface ClosureHealth {
  closureSchemaVersion: 1
  runtimeCleanQualified: boolean
  compareQualified: boolean
  failedRequestReviewRequired: boolean
  productClosureQualified: boolean
  blockers: string[]
}

/**
 * 根据插件能够客观观察的运行时证据计算 Closure 健康度。
 * 业务 4xx 可能是预期策略拒绝，因此这里只要求继续核对受控可见结果，
 * 不会把所有失败请求直接解释为运行时错误，也不会替业务 Oracle 猜测 UI 语义。
 */
export function evaluateClosureHealth(input: ClosureHealthInput): ClosureHealth {
  const runtimeCleanQualified = input.runtimeErrorCount === 0
  const compareQualified = input.comparison !== undefined
    && input.comparison.comparable === true
    && !['regressed', 'incomparable', 'evidence-insufficient'].includes(input.comparison.overallVerdict ?? '')
    && (input.comparison.newRegressionCount ?? 0) === 0
  const failedRequestReviewRequired = input.failedRequestCount > 0
  const blockers = [
    ...(runtimeCleanQualified ? [] : ['runtime-errors-remain']),
    ...(input.comparison === undefined ? ['compare-missing'] : []),
    ...(input.comparison !== undefined && input.comparison.comparable !== true ? ['compare-incomparable'] : []),
    ...(input.comparison?.overallVerdict === 'regressed' ? ['compare-regressed'] : []),
    ...((input.comparison?.newRegressionCount ?? 0) > 0 ? ['new-regressions-remain'] : []),
    ...(failedRequestReviewRequired ? ['failed-request-visible-outcome-unverified'] : []),
  ]
  return {
    closureSchemaVersion: 1,
    runtimeCleanQualified,
    compareQualified,
    failedRequestReviewRequired,
    productClosureQualified: blockers.length === 0,
    blockers,
  }
}

export function buildCrossContextLinks(input: { checkpointId: string; snapshot: L3CheckpointSnapshot; actionIds: string[]; errorEventIds: string[] }): CrossContextLink[] {
  const links: CrossContextLink[] = []
  const mainFrame = input.snapshot.contextTopology?.frames.find(frame => frame.mainFrame)
  if (mainFrame !== undefined) links.push({ linkId: `link-${links.length + 1}`, relation: 'checkpoint-observes-context', fromId: input.checkpointId, toId: mainFrame.frameId, evidenceIds: [], confidence: 'confirmed' })
  for (const application of input.snapshot.applications.filter(item => item.active)) {
    if (input.snapshot.surface !== undefined && input.snapshot.selectedApplicationId === application.applicationId) links.push({ linkId: `link-${links.length + 1}`, relation: 'surface-owned-by-application', fromId: input.snapshot.surface.rendererType, toId: application.applicationId, evidenceIds: [], confidence: application.confidence === 'confirmed' ? 'confirmed' : 'correlated' })
    for (const buildId of application.buildIds) links.push({ linkId: `link-${links.length + 1}`, relation: 'script-loaded-by-application', fromId: buildId, toId: application.applicationId, evidenceIds: [], confidence: application.confidence === 'confirmed' ? 'confirmed' : 'correlated' })
  }
  const activeBuilds = input.snapshot.builds.filter(item => item.active)
  if (activeBuilds.length === 1) for (const errorEventId of input.errorEventIds) links.push({ linkId: `link-${links.length + 1}`, relation: 'error-thrown-by-build', fromId: errorEventId, toId: activeBuilds[0]!.buildId, evidenceIds: [errorEventId], confidence: 'correlated' })
  return links.slice(0, 64)
}
