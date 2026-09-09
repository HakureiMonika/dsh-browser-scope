import type { Browser, BrowserContext, CDPSession, Dialog, ElementHandle, Page } from 'playwright-core'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ArtifactReference } from './artifact-store.ts'
import type { BrowserCallFrame, BrowserDiagnosticPanelSnapshot, BrowserLiveViewMode, BrowserScriptSummary, BrowserSplitViewPane } from './protocol.ts'
import type { BrowserExtensionRecord } from './persistent-profile.ts'
import type { CdpContextAdapter } from './cdp-context-adapter.ts'

export type ToolRegistrationMode = 'global' | 'session-select'
export type BrowserControllerMode = 'other' | 'dsh-browser-tools'

export interface SessionControllerConfig {
  defaultMode?: BrowserControllerMode
  conflictingToolPatterns?: string[]
  excludeTools?: string[]
  includeTools?: string[]
}

export interface Config {
  executablePath?: string
  headless?: boolean
  allowedOrigins?: string[]
  allowLoopback?: boolean
  allowPrivateNetwork?: boolean
  uploadRoots?: string[]
  artifactRoot?: string
  maxUploadBytes?: number
  maxDownloadBytes?: number
  maxArtifactBytes?: number
  maxOutputChars?: number
  interceptionTimeoutMs?: number
  externalCdpTimeoutMs?: number
  chromiumDownloadSource?: ChromiumDownloadSource
  chromiumDownloadTimeoutMs?: number
  subagentInteractive?: boolean
  sharedProfileSeedSessionId?: string
  toolRegistrationMode?: ToolRegistrationMode
  sessionController?: SessionControllerConfig
}

export interface ResolvedConfig {
  executablePath?: string
  headless: boolean
  allowedOrigins: ReadonlySet<string>
  allowLoopback: boolean
  allowPrivateNetwork: boolean
  uploadRoots: readonly string[]
  artifactRoot: string
  maxUploadBytes: number
  maxDownloadBytes: number
  maxArtifactBytes: number
  maxOutputChars: number
  interceptionTimeoutMs: number
  externalCdpTimeoutMs: number
  chromiumDownloadSource: ChromiumDownloadSource
  chromiumDownloadTimeoutMs: number
  subagentInteractive: boolean
  sharedProfileSeedSessionId?: string
  toolRegistrationMode: ToolRegistrationMode
  sessionController: {
    defaultMode: BrowserControllerMode
    conflictingToolPatterns: string[]
    excludeTools: string[]
    includeTools: string[]
  }
  controllerStorageRoot: string
}

export type BrowserProviderKind = 'managed' | 'managed-persistent' | 'external-cdp'
export type ChromiumDownloadSource = 'auto' | 'npmmirror' | 'official'

export type BrowserProviderBinding =
  | { kind: 'shared-persistent' }
  | { kind: 'isolated-managed'; context: BrowserContext }
  | { kind: 'isolated-persistent'; context: BrowserContext; profileName: string }
  | { kind: 'external-cdp'; context: BrowserContext; browser: Browser; endpoint: string }

export interface SharedPageOwner {
  sessionKey: string
  kind: ViewState['kind']
}

export interface SharedPersistentState {
  context?: BrowserContext
  launch?: Promise<BrowserContext>
  contextGeneration: number
  queue: Promise<void>
  pageCreationQueue: Promise<void>
  pageOwners: Map<Page, SharedPageOwner>
  pendingPageCreation?: SharedPageOwner
  extensionRegistry: BrowserExtensionRecord[]
  loadedExtensions: BrowserExtensionRecord[]
  loadedExtensionIds: Set<string>
  restarting: boolean
}

export interface PausedRequestState {
  requestId: string
  networkId?: string
  url: string
  rawUrl: string
  method: string
  resourceType: string
  requestStage: 'request' | 'response'
  responseStatusCode?: number
  responseStatusText?: string
  headers: Array<{ name: string; value: string }>
  postData?: string
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}

export interface ProfileState {
  traceActive: boolean
  traceCompletion?: Promise<Record<string, unknown>>
  resolveTrace?: (value: Record<string, unknown>) => void
  cpuActive: boolean
  jsCoverageActive: boolean
  cssCoverageActive: boolean
  heapSamplingActive: boolean
  heapSnapshotChunks?: string[]
  heapSnapshotBytes?: number
  heapSnapshotOverflow?: boolean
  artifacts: ArtifactReference[]
}

export interface Identity {
  sessionId: string
  sessionCreatedAt: number
  callId: string
  rootCallId: string
  toolName?: string
}

export interface RefState {
  handle: ElementHandle
  documentGeneration: number
  snapshotGeneration: number
}

export interface ViewState {
  viewId: string
  kind: 'page' | 'extension-popup'
  page: Page
  documentGeneration: number
  navigationGeneration: number
  navigationId: string
  pendingNavigationId?: string
  snapshotGeneration: number
  refs: Map<string, RefState>
  refCounter: number
  lastSnapshot?: string
  dialog?: Dialog
  dialogPolicy?: { accept: boolean; promptText?: string }
  console: Array<{ level: string; text: string; time: number }>
  network: Array<{ method: string; url: string; type: string; status?: number; failure?: string; time: number }>
  cdp?: {
    session: CDPSession
    contextAdapter?: CdpContextAdapter
    debuggerEnabled: boolean
    paused: boolean
    reason?: string
    callFrames: BrowserCallFrame[]
    scripts: Map<string, BrowserScriptSummary>
    breakpoints: Map<string, { breakpointId: string; url: string; lineNumber: number; columnNumber: number }>
    screencastStarted: boolean
    screencastConsumers: Set<'live-view' | 'recorder'>
    streamGeneration: number
    frameSequence: number
    lastAcceptedFrameAt: number
    latestFrame?: { streamGeneration: number; sequence: number; mediaType: 'image/jpeg'; data: string; width: number; height: number; viewportGeneration: number }
    networkEnabled: boolean
    pausedRequests: Map<string, PausedRequestState>
    profile: ProfileState
  }
  viewport: {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
    generation: number
    contentWidth: number
    fittedWidth: number
    reflowedElements: number
    fitDocumentGeneration: number
  }
  userPointer?: {
    button: 'left' | 'middle' | 'right'
    clickCount: number
    streamGeneration: number
    viewportGeneration: number
  }
}

export interface SessionState {
  key: string
  sessionId: string
  contextGeneration: number
  providerBinding: BrowserProviderBinding
  views: Map<string, ViewState>
  activeViewId: string
  splitView: {
    enabled: boolean
    topViewId?: string
    bottomViewId?: string
    focusedPane: BrowserSplitViewPane
    ratio: number
    changedAt: number
    panes: Record<BrowserSplitViewPane, { adaptiveWidth?: number; adaptiveHeight?: number }>
  }
  nextViewId: number
  queue: Promise<void>
  provider: BrowserProviderKind
  providerEndpoint?: string
  providerBrowser?: Browser
  persistentProfile?: string
  extensionRegistry: BrowserExtensionRecord[]
  loadedExtensions: BrowserExtensionRecord[]
  loadedExtensionIds: Set<string>
  openingExtensionPopup?: { extensionId: string; name: string }
  extensionPopup?: { extensionId: string; name: string; view: ViewState }
  playwrightTraceViewId?: string
  liveView: {
    mode: BrowserLiveViewMode
    initialized: boolean
    open: boolean
    fixedWidth: number
    fixedHeight: number
    adaptiveWidth?: number
    adaptiveHeight?: number
    changedAt: number
  }
  control: {
    owner: 'model' | 'user'
    pending: boolean
    changedAt: number
  }
  diagnosticPanel: {
    readSequences: Map<string, number>
    latestInspect?: NonNullable<BrowserDiagnosticPanelSnapshot['latestInspect']>
    latestComparison?: NonNullable<BrowserDiagnosticPanelSnapshot['latestComparison']>
    latestIncident?: NonNullable<BrowserDiagnosticPanelSnapshot['latestIncident']>
    takeover?: {
      startedAt: number
      startedSequence: number
      viewId: string
      documentGeneration: number
      navigationId: string
    }
    latestTakeoverSummary?: NonNullable<NonNullable<BrowserDiagnosticPanelSnapshot['takeover']>['latestSummary']>
  }
}

export interface RuntimeState {
  browser?: Browser
  launch?: Promise<Browser>
  sharedPersistent: SharedPersistentState
  sessions: Map<string, SessionState>
  disposed: boolean
}

export interface ToolOutput {
  ok: boolean
  action: string
  viewId?: string
  data?: JsonValue
}
