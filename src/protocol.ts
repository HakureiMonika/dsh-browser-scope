export type BrowserPanelView = 'live' | 'diagnostic' | 'console' | 'network' | 'debugger' | 'performance' | 'provider' | 'extensions' | 'emulation'

export type BrowserToolRegistrationMode = 'global' | 'session-select'
export type BrowserControllerMode = 'unselected' | 'other' | 'dsh-browser-tools'
export type BrowserControllerStatus = 'inactive' | 'activating' | 'active' | 'releasing' | 'error'

export interface BrowserControllerSnapshot {
  registrationMode: BrowserToolRegistrationMode
  mode: BrowserControllerMode
  status: BrowserControllerStatus
  generation: number
  conflictingTools: string[]
  shadowedTools: string[]
  restrictedTools: string[]
  selectionLocked: boolean
  canSwitchNow: boolean
  blockers: string[]
  error?: string
}

export type BrowserNetworkAction = 'enable' | 'disable' | 'list_paused' | 'continue' | 'abort' | 'fulfill' | 'body' | 'replay'
export type BrowserProfileAction = 'trace_start' | 'trace_stop' | 'playwright_trace_start' | 'playwright_trace_stop' | 'cpu_start' | 'cpu_stop' | 'coverage_start' | 'coverage_stop' | 'heap_snapshot' | 'heap_sampling_start' | 'heap_sampling_stop' | 'artifacts' | 'artifact_read'
export type BrowserEmulateAction = 'viewport' | 'device' | 'locale' | 'timezone' | 'network' | 'cpu' | 'offline' | 'permissions' | 'reset'
export type BrowserEvaluateAction = 'isolated' | 'main_world' | 'paused_frame'
export type BrowserProviderAction = 'list' | 'connect' | 'disconnect' | 'capabilities'
export type BrowserExtensionAction = 'list' | 'install' | 'enable' | 'disable' | 'uninstall' | 'apply' | 'open_popup' | 'close_popup'
export type BrowserExtensionApplyMode = 'next_start' | 'now'
export type BrowserTakeoverAction = 'status' | 'request' | 'return' | 'cancel'
export type BrowserLiveViewMode = 'standard' | 'adaptive'
export type BrowserLiveViewAction = 'status' | 'standard' | 'adaptive' | 'initialize' | 'resize'
export type BrowserSplitViewPane = 'top' | 'bottom'
export type BrowserSplitViewOrientation = 'top-bottom' | 'left-right'
export type BrowserSplitViewAction = 'status' | 'open' | 'close' | 'swap' | 'assign' | 'focus' | 'ratio' | 'orientation' | 'resize'
export type BrowserPanelTabAction = 'new' | 'select' | 'close' | 'back' | 'forward' | 'reload' | 'navigate'
export type BrowserDiagnoseAction = 'start' | 'status' | 'inspect' | 'checkpoint' | 'compare' | 'report' | 'stop' | 'recorder_status' | 'recorder_start' | 'recorder_pause' | 'recorder_resume' | 'recorder_clear' | 'recorder_stop' | 'recorder_mark' | 'recorder_complete' | 'recorder_timeline'
export type BrowserRecorderAction = 'status' | 'start' | 'pause' | 'resume' | 'clear' | 'stop' | 'mark' | 'complete'
export type BrowserRecorderMode = 'rolling' | 'deep'

export interface BrowserTabSummary {
  index: number
  viewId: string
  url: string
  title: string
  active: boolean
  status: string
}

export interface BrowserConsoleEntry {
  level: string
  text: string
  time: number
}

export interface BrowserNetworkEntry {
  method: string
  url: string
  type: string
  status?: number
  failure?: string
  time: number
}

export interface BrowserPausedRequest {
  requestId: string
  url: string
  method: string
  resourceType: string
  requestStage: 'request' | 'response'
  responseStatusCode?: number
  responseStatusText?: string
  createdAt: number
}

export interface BrowserArtifactSummary {
  artifactId: string
  kind: string
  name: string
  bytes: number
  createdAt: number
}

export interface BrowserCapabilityState {
  provider: 'managed' | 'managed-persistent' | 'external-cdp'
  debugger: boolean
  networkInterception: boolean
  tracing: boolean
  cpuProfile: boolean
  coverage: boolean
  heap: boolean
  emulation: boolean
  evaluate: boolean
  screencast: boolean
  takeover: boolean
}

export interface BrowserExtensionSummary {
  extensionId: string
  name: string
  version: string
  enabled: boolean
  loaded: boolean
  pendingRestart: boolean
  installedAt: number
  sourceUrl: string
  actionPopup?: string
}

export interface BrowserExtensionPopupSnapshot {
  extensionId: string
  name: string
  viewId: string
  width: number
  height: number
  frame?: { streamGeneration: number; sequence: number; mediaType: 'image/jpeg'; data: string; width: number; height: number; viewportGeneration: number }
}

export interface BrowserCallFrame {
  callFrameId: string
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
  scopes: Array<{ type: string; name?: string; objectId?: string }>
}

export interface BrowserScriptSummary {
  scriptId: string
  url: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  targetId?: string
  frameId?: string
  frameDocumentGeneration?: number
  executionContextId?: number
  worldType?: 'main' | 'isolated' | 'extension' | 'unknown'
  buildId?: string
  scriptSha256?: string
  sourceMapSha256?: string
}

export interface BrowserDebuggerState {
  attached: boolean
  paused: boolean
  reason?: string
  callFrames: BrowserCallFrame[]
  scripts: BrowserScriptSummary[]
  breakpoints: Array<{ breakpointId: string; url: string; lineNumber: number; columnNumber: number }>
}

export interface BrowserLivePaneSnapshot {
  pane: BrowserSplitViewPane
  viewId: string
  focused: boolean
  liveView: { mode: BrowserLiveViewMode; initialized: boolean; width: number; height: number; viewportGeneration: number; reflowed: boolean; contentWidth: number; fittedWidth: number; reflowedElements: number; changedAt: number }
  frame?: { streamGeneration: number; sequence: number; mediaType: 'image/jpeg'; data: string; width: number; height: number; viewportGeneration: number }
}

export interface BrowserFrameCursor {
  streamGeneration: number
  sequence: number
}

export interface BrowserDiagnosticPanelSnapshot {
  schemaVersion: 2
  active: boolean
  recording: boolean
  currentIdentity: {
    viewId: string
    contextGeneration: number
    documentGeneration: number
    navigationId: string
    targetId?: string
    frameId?: string
    frameDocumentGeneration?: number
    viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean; generation: number }
  }
  contextTopology?: {
    contextTopologySchemaVersion: 1
    targetCount: number
    frameCount: number
    executionContextCount: number
    degradationCount: number
    mainFrameId?: string
    truncated: boolean
  }
  buildTopology: {
    buildCount: number
    activeBuildCount: number
    scriptCount: number
    truncated: boolean
  }
  applicationTopology: {
    applicationCount: number
    activeApplicationCount: number
    confirmedApplicationCount: number
    truncated: boolean
  }
  recorder: {
    recorderSchemaVersion: 1
    mode: 'off' | 'rolling' | 'deep'
    status: 'idle' | 'recording' | 'paused' | 'disposed'
    retentionMs: number
    eventCount: number
    chunkCount: number
    byteSize: number
    frozenIncidentIds: string[]
    overload: 'normal' | 'sampling-reduced' | 'visual-dropped' | 'mutation-detail-dropped' | 'metadata-only'
    deepVisible: boolean
    visualCapture: {
      activeViewCount: number
      startedViewCount: number
      liveViewConsumerCount: number
      recorderConsumerCount: number
    }
  }
  debugSession?: {
    debugSessionId: string
    status: 'active' | 'invalidated' | 'stopped'
    startedAt: number
    checkpointCount: number
    checkpoints: Array<{ checkpointId: string; label: string; createdAt: number; viewId: string; documentGeneration: number; navigationId: string }>
    currentCheckpoint?: { checkpointId: string; label: string; createdAt: number }
  }
  synchronization: {
    status: 'same-view' | 'mismatch' | 'no-debug-session'
    reasons: string[]
  }
  unread: {
    consoleErrors: number
    failedRequests: number
    total: number
    latestSequence: number
  }
  timeline: Array<{
    actionId: string
    toolName: string
    humanInitiated: boolean
    outcome: 'ok' | 'failed' | 'aborted'
    wallTime: number
    documentGeneration: number
    navigationId: string
    relatedEvidenceCount: number
  }>
  latestInspect?: {
    viewId: string
    documentGeneration: number
    navigationId: string
    ref: string
    target: { tag: string; id?: string; role?: string; accessibleName?: string; box?: { x: number; y: number; width: number; height: number } }
    occluder?: { tag: string; id?: string; role?: string; accessibleName?: string; box: { x: number; y: number; width: number; height: number } }
  }
  latestComparison?: {
    beforeCheckpointId: string
    afterCheckpointId: string
    overallVerdict: string
    comparable: boolean
    newRegressionCount: number
    l3Verdict?: 'stable' | 'changed' | 'incomparable'
    l3Comparable?: boolean
  }
  latestIncident?: {
    incidentId: string
    generatedAt: number
    factCount: number
    causalCandidateCount: number
    verificationStatus: string
    reportBytes: number
    crossContextLinkCount?: number
    l3Verdict?: 'stable' | 'changed' | 'incomparable'
  }
  takeover?: {
    active: boolean
    startedAt?: number
    latestSummary?: {
      startedAt: number
      finishedAt: number
      actionCount: number
      documentChanged: boolean
      navigationChanged: boolean
      newConsoleErrors: number
      newFailedRequests: number
    }
  }
}

export interface BrowserSplitViewState {
  enabled: boolean
  focusedPane: BrowserSplitViewPane
  orientation: BrowserSplitViewOrientation
  ratio: number
  changedAt: number
  topViewId?: string
  bottomViewId?: string
  panes?: BrowserLivePaneSnapshot[]
}

export interface BrowserPanelSnapshot {
  available: boolean
  sessionId: string
  activeViewId?: string
  tabs: BrowserTabSummary[]
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  debugger?: BrowserDebuggerState
  pausedRequests?: BrowserPausedRequest[]
  artifacts?: BrowserArtifactSummary[]
  extensions?: BrowserExtensionSummary[]
  extensionPopup?: BrowserExtensionPopupSnapshot
  chromium?: { installed: boolean; executablePath?: string }
  capabilities?: BrowserCapabilityState
  control?: { owner: 'model' | 'user'; pending: boolean; changedAt: number }
  diagnostic?: BrowserDiagnosticPanelSnapshot
  splitView?: BrowserSplitViewState
  liveView?: { mode: BrowserLiveViewMode; initialized: boolean; width: number; height: number; viewportGeneration: number; reflowed: boolean; contentWidth: number; fittedWidth: number; reflowedElements: number; changedAt: number }
  frame?: { streamGeneration: number; sequence: number; mediaType: 'image/jpeg'; data: string; width: number; height: number; viewportGeneration: number }
  message?: string
}

export interface BrowserPanelTabInput {
  action: BrowserPanelTabAction
  viewId?: string
  url?: string
  notifyAgent?: boolean
}

export interface BrowserLiveViewInput {
  action: BrowserLiveViewAction
  viewId?: string
  mode?: BrowserLiveViewMode
  width?: number
  height?: number
  notifyAgent?: boolean
}

export interface BrowserSplitViewInput {
  action: BrowserSplitViewAction
  pane?: BrowserSplitViewPane
  orientation?: BrowserSplitViewOrientation
  viewId?: string
  ratio?: number
  width?: number
  height?: number
  notifyAgent?: boolean
}

export interface BrowserNetworkInput {
  action: BrowserNetworkAction
  viewId?: string
  requestId?: string
  urlPattern?: string
  resourceType?: string
  requestStage?: 'request' | 'response' | 'both'
  errorReason?: string
  responseCode?: number
  responsePhrase?: string
  headers?: Array<{ name: string; value: string }>
  body?: string
  bodyBase64?: boolean
}

export interface BrowserProfileInput {
  action: BrowserProfileAction
  viewId?: string
  artifactId?: string
  maxReadBytes?: number
}

export interface BrowserEmulateInput {
  action: BrowserEmulateAction
  viewId?: string
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  device?: string
  locale?: string
  timezoneId?: string
  offline?: boolean
  latencyMs?: number
  downloadKbps?: number
  uploadKbps?: number
  rate?: number
  permissions?: string[]
  origin?: string
}

export interface BrowserEvaluateInput {
  action: BrowserEvaluateAction
  viewId?: string
  expression: string
  callFrameId?: string
  awaitPromise?: boolean
}

export interface BrowserDiagnoseInput {
  action: BrowserDiagnoseAction
  viewId?: string
  ref?: string
  label?: string
  checkpointId?: string
  beforeCheckpointId?: string
  afterCheckpointId?: string
  screenshot?: boolean
  sinceActionId?: string
  untilActionId?: string
  sinceCheckpointId?: string
  sinceCursor?: number
  recorderMode?: BrowserRecorderMode
  incidentId?: string
  limit?: number
}

export interface BrowserRecorderInput {
  action: BrowserRecorderAction
  mode?: BrowserRecorderMode
  incidentId?: string
}

export interface BrowserProviderInput {
  action: BrowserProviderAction
  provider?: 'managed' | 'managed-persistent' | 'external-cdp'
  endpoint?: string
  profileName?: string
}

export interface BrowserExtensionInput {
  action: BrowserExtensionAction
  extension?: string
  extensionId?: string
  applyMode?: BrowserExtensionApplyMode
}

export interface BrowserTakeoverInput {
  action: BrowserTakeoverAction
  viewId?: string
}

interface BrowserInputTraceEnvelope {
  inputTraceId?: string
  clientRawAt?: number
  clientNormalizedAt?: number
  composing?: boolean
}

export type BrowserInputFailureResult =
  | 'dropped-at-client-normalization'
  | 'dropped-at-rpc'
  | 'dropped-at-host-bridge'
  | 'dropped-before-dom-event'
  | 'dropped-after-beforeinput'

export interface BrowserInputTraceUpdate {
  inputTraceId: string
  viewId: string
  action: 'key-press' | 'insert-text' | 'paste' | 'composition' | 'pointer' | 'wheel'
  sensitivity: 'normal' | 'potentially-sensitive' | 'sensitive' | 'security-challenge'
  composing: boolean
  characters?: {
    length: number
    asciiLetters: number
    digits: number
    whitespace: number
    punctuation: number
    cjk: number
    other: number
  }
  stage: 'client-raw' | 'client-normalized' | 'rpc-received' | 'host-dispatched' | 'dom-observed' | 'final-state'
  timestamp: number
  outcome: 'observed' | 'delivered' | 'prevented' | 'lost' | 'unknown'
  reason?: string
  result?: BrowserInputFailureResult | 'delivered' | 'composition-not-committed' | 'focus-lost' | 'target-replaced' | 'prevented-by-page' | 'transport-lost' | 'unknown'
}

export type BrowserUserInput = BrowserInputTraceEnvelope & (
  | { action: 'mouse_click'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
  | { action: 'mouse_down'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
  | { action: 'mouse_move'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; x: number; y: number }
  | { action: 'mouse_up'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; x: number; y: number }
  | { action: 'mouse_wheel'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'key_press'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; key: string; modifiers?: Array<'Control' | 'Alt' | 'Shift' | 'Meta'> }
  | { action: 'insert_text'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; text: string }
  | { action: 'composition_commit'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; text: string }
  | { action: 'paste'; viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number; text?: string; html?: string; uriList?: string; files?: Array<{ name: string; mediaType: string; data: string }> }
)

export type BrowserDebuggerAction =
  | 'attach'
  | 'detach'
  | 'pause'
  | 'resume'
  | 'step_over'
  | 'step_into'
  | 'step_out'
  | 'call_frames'
  | 'scripts'
  | 'script_source'
  | 'source_map'
  | 'scope_variables'
  | 'set_breakpoint'
  | 'remove_breakpoint'

export interface BrowserDebuggerInput {
  action: BrowserDebuggerAction
  viewId?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  breakpointId?: string
  callFrameId?: string
  scopeNumber?: number
  scriptId?: string
}
