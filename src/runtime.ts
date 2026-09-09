import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { chromium, devices } from 'playwright-core'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Browser, BrowserContext, CDPSession, ElementHandle, Page, Request } from 'playwright-core'
import { abortReason, fail, requireActive } from './errors.ts'
import { assertCdpEndpoint, assertUploadPath, assertUrlAllowed, redactUrl } from './policy.ts'
import type { Identity, RefState, ResolvedConfig, RuntimeState, SessionState, ToolOutput, ViewState } from './types.ts'
import type { BrowserCallFrame, BrowserDebuggerInput, BrowserDiagnoseInput, BrowserDiagnosticPanelSnapshot, BrowserEmulateInput, BrowserEvaluateInput, BrowserExtensionInput, BrowserExtensionSummary, BrowserFrameCursor, BrowserInputTraceUpdate, BrowserLiveViewInput, BrowserNetworkInput, BrowserPanelSnapshot, BrowserPanelTabInput, BrowserPanelView, BrowserProfileInput, BrowserProviderInput, BrowserRecorderInput, BrowserSplitViewInput, BrowserSplitViewPane, BrowserTakeoverInput, BrowserUserInput } from './protocol.ts'
import { ArtifactStore } from './artifact-store.ts'
import { ChromiumManager } from './chromium-manager.ts'
import { downloadChromeWebStoreExtension } from './crx.ts'
import { PersistentProfileStore } from './persistent-profile.ts'
import { DebugSessionStore } from './debug-session-store.ts'
import type { DiagnosticCheckpoint, ElementEvidence } from './debug-session-store.ts'
import { compareCheckpoints, projectActionTimeline, projectCorrelations, projectDiagnosticCompareOutput, projectEvidence } from './diagnostic-projector.ts'
import { EventJournal } from './event-journal.ts'
import type { ConsoleJournalEvent } from './event-journal.ts'
import { buildIncidentReport } from './incident-report.ts'
import { parseGeneratedLocation, resolveSourceMap } from './source-map-resolver.ts'
import { CdpContextAdapter } from './cdp-context-adapter.ts'
import { ContextIdentityRegistry } from './context-registry.ts'
import type { EvidenceContextIdentity } from './context-identity.ts'
import { FlightRecorderStore } from './flight-recorder.ts'
import { InputTraceStore, classifyInputFailure, inputSensitivity, summarizeInputCharacters, type InputTraceRecord } from './input-trace.ts'
import { BuildRegistry } from './build-registry.ts'
import { ApplicationRegistry, type ApplicationIdentity } from './application-registry.ts'
import { buildCrossContextLinks, compareL3Checkpoints, createL3Checkpoint } from './l3-closure.ts'
import type { BrowserControllerIdentity } from './l3-closure.ts'

const WINDOWS_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const STANDARD_VIEWPORT = { width: 1280, height: 720 } as const
const MIN_ADAPTIVE_VIEWPORT = { width: 320, height: 240 } as const
const MIN_SPLIT_ADAPTIVE_VIEWPORT = { width: 320, height: 120 } as const
const MAX_ADAPTIVE_VIEWPORT = { width: 1920, height: 1200 } as const
const ADAPTIVE_REFLOW_ATTRIBUTE = 'data-dsh-browser-tools-adaptive-reflow'

function sessionKey(identity: Identity): string {
  return `${identity.sessionId}@${identity.sessionCreatedAt}`
}

function pendingSessionKey(sessionId: string): string {
  return `${sessionId}@pending`
}

function asData(value: unknown): ToolOutput['data'] {
  return value as ToolOutput['data']
}

interface RawCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  on(event: string, listener: (payload: Record<string, unknown>) => void): RawCdpSession
  detach(): Promise<void>
}

function rawCdp(session: CDPSession): RawCdpSession {
  return session as unknown as RawCdpSession
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export class BrowserRuntime {
  private readonly state: RuntimeState = {
    sharedPersistent: {
      contextGeneration: 0,
      queue: Promise.resolve(),
      pageCreationQueue: Promise.resolve(),
      pageOwners: new Map(),
      extensionRegistry: [],
      loadedExtensions: [],
      loadedExtensionIds: new Set(),
      restarting: false,
    },
    sessions: new Map(),
    disposed: false,
  }
  private readonly artifacts: ArtifactStore
  private readonly profiles: PersistentProfileStore
  private readonly chromiumManager: ChromiumManager
  private readonly journal = new EventJournal()
  private readonly debugSessions = new DebugSessionStore()
  private readonly contextIdentities = new ContextIdentityRegistry()
  private readonly recorder = new FlightRecorderStore()
  private readonly inputTraces = new InputTraceStore()
  private readonly builds = new BuildRegistry()
  private readonly applications = new ApplicationRegistry()
  private controllerIdentityResolver: (sessionId: string) => BrowserControllerIdentity | undefined = () => ({
    id: 'dsh-browser-tools',
    generation: 0,
    registrationMode: 'global',
  })
  private nextLegacyInputTrace = 1
  private readonly legacyRequests = new WeakMap<Request, ViewState['network'][number]>()

  constructor(private readonly config: ResolvedConfig, private readonly attachments: AttachmentStore) {
    this.artifacts = new ArtifactStore(config.artifactRoot, config.maxArtifactBytes)
    this.profiles = new PersistentProfileStore(config.artifactRoot)
    this.chromiumManager = new ChromiumManager(this.profiles.chromiumPath(), {
      source: config.chromiumDownloadSource,
      timeoutMs: config.chromiumDownloadTimeoutMs,
    })
  }

  setControllerIdentityResolver(resolver: (sessionId: string) => BrowserControllerIdentity | undefined): void {
    // Runtime 只读取控制器身份并写入证据，不持有 Controller Store，也不参与工具注册状态机。
    // 该单向依赖避免 Browser Runtime 与 Agent Scope 生命周期互相调用形成循环所有权。
    this.controllerIdentityResolver = resolver
  }

  private controllerIdentity(sessionId: string): BrowserControllerIdentity | undefined {
    return this.controllerIdentityResolver(sessionId)
  }

  private async releaseHandles(handles: Iterable<ElementHandle>): Promise<void> {
    // 同一个ElementHandle只能由一个逻辑所有者保留；用Set去重后统一释放，避免Snapshot与Query异常路径重复dispose。
    const unique = new Set(handles)
    await Promise.allSettled([...unique].map(handle => handle.dispose()))
  }

  private async releaseViewRefs(view: ViewState): Promise<void> {
    // 必须先同步清空Map，使旧Ref立即变为STALE_REF；随后再等待协议句柄释放，避免清理期间旧引用仍可被并发操作命中。
    const handles = [...view.refs.values()].map(ref => ref.handle)
    view.refs.clear()
    await this.releaseHandles(handles)
  }

  private splitViewState(ratio = 0.5): SessionState['splitView'] {
    // activeViewId 仍是现有 28 个工具的默认操作目标；分屏状态只补充两个可见窗格，避免破坏既有工具协议。
    return {
      enabled: false,
      focusedPane: 'top',
      ratio,
      changedAt: Date.now(),
      panes: { top: {}, bottom: {} },
    }
  }

  private executablePath(): string | undefined {
    if (this.config.executablePath !== undefined) return this.config.executablePath
    return WINDOWS_BROWSERS.find(existsSync)
  }

  private async browser(): Promise<Browser> {
    if (this.state.disposed) fail('PROVIDER_UNAVAILABLE', 'browser provider is disposed')
    if (this.state.browser?.isConnected()) return this.state.browser
    if (this.state.launch === undefined) {
      this.state.launch = chromium.launch({
        ...(this.executablePath() === undefined ? {} : { executablePath: this.executablePath() }),
        headless: this.config.headless,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
      }).then(browser => {
        this.state.browser = browser
        this.state.launch = undefined
        return browser
      }, error => {
        this.state.launch = undefined
        fail('PROVIDER_UNAVAILABLE', 'failed to launch browser', error)
      })
    }
    return this.state.launch
  }

  private async managedContext() {
    const browser = await this.browser()
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' })
    await this.installSurfaceProbe(context)
    return context
  }

  private async installSurfaceProbe(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      const key = '__dshShadowHostModes'
      const root = globalThis as typeof globalThis & { [key: string]: unknown }
      if (root[key] instanceof WeakMap) return
      const modes = new WeakMap<Element, ShadowRootMode>()
      root[key] = modes
      const original = Element.prototype.attachShadow
      Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
        const shadow = original.call(this, init)
        modes.set(this, init.mode)
        return shadow
      }
    })
  }

  private sessionContext(session: SessionState): BrowserContext {
    if (session.providerBinding.kind === 'shared-persistent') {
      const context = this.state.sharedPersistent.context
      if (context === undefined) fail('PROVIDER_UNAVAILABLE', 'shared persistent browser context is not available')
      return context
    }
    return session.providerBinding.context
  }

  private async queueSharedContext<T>(operation: () => Promise<T>): Promise<T> {
    const shared = this.state.sharedPersistent
    const previous = shared.queue
    let release!: () => void
    shared.queue = new Promise<void>(resolveQueue => { release = resolveQueue })
    await previous
    try {
      if (this.state.disposed) fail('PROVIDER_UNAVAILABLE', 'browser provider is disposed')
      return await operation()
    } finally {
      release()
    }
  }

  private async queueSharedPageCreation<T>(operation: () => Promise<T>): Promise<T> {
    const shared = this.state.sharedPersistent
    const previous = shared.pageCreationQueue
    let release!: () => void
    shared.pageCreationQueue = new Promise<void>(resolveQueue => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async queueSessions<T>(sessions: readonly SessionState[], operation: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = []
    for (const session of [...sessions].sort((left, right) => left.key.localeCompare(right.key))) {
      const previous = session.queue
      let release!: () => void
      session.queue = new Promise<void>(resolveQueue => { release = resolveQueue })
      await previous
      releases.push(release)
    }
    try {
      return await operation()
    } finally {
      for (const release of releases.reverse()) release()
    }
  }

  private async persistentContext(sessionId: string, profileName = 'default', launchExtensions?: readonly SessionState['extensionRegistry'][number][]): Promise<{ context: BrowserContext; extensionRegistry: SessionState['extensionRegistry']; loadedExtensions: SessionState['loadedExtensions']; loadedExtensionIds: Set<string> }> {
    const extensions = await this.profiles.listExtensions(sessionId)
    const enabled = launchExtensions === undefined ? extensions.filter(extension => extension.enabled) : [...launchExtensions]
    const executablePath = enabled.length === 0
      ? this.executablePath()
      : await this.chromiumManager.ensureInstalled()
    const extensionPaths = enabled.map(extension => extension.path)
    const context = await chromium.launchPersistentContext(this.profiles.profilePath(sessionId, profileName), {
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: this.config.headless,
      acceptDownloads: true,
      serviceWorkers: 'allow',
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        ...(extensionPaths.length === 0
          ? []
          : [
              `--disable-extensions-except=${extensionPaths.join(',')}`,
              `--load-extension=${extensionPaths.join(',')}`,
            ]),
      ],
    })
    await this.installSurfaceProbe(context)
    // 只有新 Context 已经成功加载目标扩展后，才能删除不再登记或不再运行的旧版本目录，确保启动失败仍可使用旧版本回滚。
    await this.profiles.pruneExtensionDirectories(sessionId, [...extensions, ...enabled])
    return { context, extensionRegistry: extensions, loadedExtensions: enabled, loadedExtensionIds: new Set(enabled.map(extension => extension.extensionId)) }
  }

  private async launchSharedPersistentContext(launchExtensions?: readonly SessionState['extensionRegistry'][number][]): Promise<BrowserContext> {
    const shared = this.state.sharedPersistent
    await this.profiles.ensureSharedProfileSeed(this.config.sharedProfileSeedSessionId)
    const extensions = await this.profiles.listSharedExtensions()
    const enabled = launchExtensions === undefined ? extensions.filter(extension => extension.enabled) : [...launchExtensions]
    const executablePath = enabled.length === 0
      ? this.executablePath()
      : await this.chromiumManager.ensureInstalled()
    const extensionPaths = enabled.map(extension => extension.path)
    const context = await chromium.launchPersistentContext(this.profiles.sharedProfilePath(), {
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: this.config.headless,
      acceptDownloads: true,
      serviceWorkers: 'allow',
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        ...(extensionPaths.length === 0
          ? []
          : [
              `--disable-extensions-except=${extensionPaths.join(',')}`,
              `--load-extension=${extensionPaths.join(',')}`,
            ]),
      ],
    })
    await this.installSurfaceProbe(context)
    shared.context = context
    shared.contextGeneration += 1
    shared.extensionRegistry = extensions
    shared.loadedExtensions = enabled
    shared.loadedExtensionIds = new Set(enabled.map(extension => extension.extensionId))
    shared.pageOwners.clear()
    shared.pendingPageCreation = undefined
    context.on('page', page => { void this.routeSharedPage(page) })
    for (const page of context.pages()) await page.close({ runBeforeUnload: false }).catch(() => {})
    return context
  }

  private async sharedPersistentContext(): Promise<BrowserContext> {
    const shared = this.state.sharedPersistent
    if (shared.context !== undefined) return shared.context
    if (shared.launch === undefined) {
      shared.launch = this.launchSharedPersistentContext().finally(() => {
        shared.launch = undefined
      })
    }
    return shared.launch
  }

  private async cleanupProvider(session: SessionState): Promise<void> {
    this.debugSessions.invalidate(session.key)
    this.contextIdentities.invalidateSession(session.key, session.contextGeneration + 1)
    this.builds.clearSession(session.key)
    this.applications.clearSession(session.key)
    session.diagnosticPanel.readSequences.clear()
    session.diagnosticPanel.latestInspect = undefined
    session.diagnosticPanel.latestComparison = undefined
    session.diagnosticPanel.latestIncident = undefined
    session.diagnosticPanel.takeover = undefined
    session.diagnosticPanel.latestTakeoverSummary = undefined
    session.contextGeneration += 1
    const context = session.providerBinding.kind === 'shared-persistent'
      ? this.state.sharedPersistent.context
      : session.providerBinding.context
    if (session.playwrightTraceViewId !== undefined) {
      await context?.tracing.stop().catch(() => {})
      session.playwrightTraceViewId = undefined
    }
    const views = [...session.views.values()]
    for (const view of views) {
      await this.releaseViewRefs(view)
      await this.releasePausedRequests(view)
      const cdp = view.cdp
      if (cdp !== undefined) {
        await this.forceStopScreencast(view)
        cdp.contextAdapter?.dispose()
        await rawCdp(cdp.session).detach().catch(() => {})
      }
    }
    session.views.clear()
    if (session.providerBinding.kind === 'shared-persistent') {
      // Session只拥有共享Context中的Page；退出共享Provider或销毁Session时逐页关闭，不能关闭插件级Context。
      for (const view of views) {
        this.state.sharedPersistent.pageOwners.delete(view.page)
        await view.page.close({ runBeforeUnload: false }).catch(() => {})
      }
    } else if (session.providerBinding.kind === 'external-cdp') {
      // connectOverCDP 的 Browser.close 仅关闭 Playwright 传输连接，不发送 Browser.close，因此不会退出用户浏览器。
      await session.providerBinding.browser.close().catch(() => {})
    } else {
      await session.providerBinding.context.close().catch(() => {})
    }
    session.providerBrowser = undefined
    session.providerEndpoint = undefined
    session.persistentProfile = undefined
    session.loadedExtensions = []
    session.loadedExtensionIds = new Set()
    session.openingExtensionPopup = undefined
    session.extensionPopup = undefined
  }

  private acceptPage(session: SessionState, page: Page, kind: ViewState['kind'] = 'page'): ViewState {
    const popupRequest = kind === 'extension-popup' ? session.openingExtensionPopup : undefined
    if (popupRequest !== undefined) {
      const popupView = this.bindView(session, page, 'extension-popup')
      session.extensionPopup = { ...popupRequest, view: popupView }
      return popupView
    }
    const existing = [...session.views.values()].find(view => view.page === page)
    if (existing !== undefined) return existing
    const view = this.bindView(session, page, kind)
    if (kind === 'page') {
      if (session.splitView.enabled) {
        // 网页弹出标签必须进入当前焦点窗格；否则分屏状态仍指向旧标签，地址栏与 Agent 默认目标会和用户看到的页面不一致。
        if (session.splitView.focusedPane === 'top') session.splitView.topViewId = view.viewId
        else session.splitView.bottomViewId = view.viewId
      }
      session.activeViewId = view.viewId
      void (async () => {
        await this.applyLiveViewport(session, view)
        await this.syncScreencasts(session)
      })().catch(() => {})
    }
    return view
  }

  private async routeSharedPage(page: Page): Promise<void> {
    const shared = this.state.sharedPersistent
    let owner = shared.pageOwners.get(page)
    if (owner === undefined) {
      const opener = await page.opener().catch(() => null)
      owner = opener === null ? shared.pendingPageCreation : shared.pageOwners.get(opener)
    }
    if (owner === undefined) {
      await page.close({ runBeforeUnload: false }).catch(() => {})
      return
    }
    shared.pageOwners.set(page, owner)
    const session = this.state.sessions.get(owner.sessionKey)
    if (session === undefined || session.providerBinding.kind !== 'shared-persistent') {
      shared.pageOwners.delete(page)
      await page.close({ runBeforeUnload: false }).catch(() => {})
      return
    }
    this.acceptPage(session, page, owner.kind)
  }

  private async createSharedPageUnlocked(session: SessionState, kind: ViewState['kind'] = 'page'): Promise<Page> {
    const shared = this.state.sharedPersistent
    const context = await this.sharedPersistentContext()
    const owner = { sessionKey: session.key, kind }
    shared.pendingPageCreation = owner
    try {
      const page = await context.newPage()
      shared.pageOwners.set(page, owner)
      this.acceptPage(session, page, kind)
      return page
    } finally {
      if (shared.pendingPageCreation === owner) shared.pendingPageCreation = undefined
    }
  }

  private async createSharedPage(session: SessionState, kind: ViewState['kind'] = 'page'): Promise<Page> {
    return this.queueSharedPageCreation(() => this.createSharedPageUnlocked(session, kind))
  }

  private sessionPages(session: SessionState): Page[] {
    return [...session.views.values()]
      .filter(view => view.kind === 'page' && !view.page.isClosed())
      .map(view => view.page)
  }

  private async createPage(session: SessionState, kind: ViewState['kind'] = 'page'): Promise<Page> {
    if (session.providerBinding.kind === 'shared-persistent') return this.createSharedPage(session, kind)
    const page = await this.sessionContext(session).newPage()
    this.acceptPage(session, page, kind)
    return page
  }

  private sharedSessions(): SessionState[] {
    return [...this.state.sessions.values()].filter(session => session.providerBinding.kind === 'shared-persistent')
  }

  private syncSharedExtensions(): void {
    const shared = this.state.sharedPersistent
    for (const session of this.sharedSessions()) {
      // Session字段只保留兼容快照，禁止共享Set引用；Provider切换时清理Session不能修改插件级加载集合。
      session.extensionRegistry = [...shared.extensionRegistry]
      session.loadedExtensions = [...shared.loadedExtensions]
      session.loadedExtensionIds = new Set(shared.loadedExtensionIds)
    }
  }

  private extensionRegistry(session: SessionState): SessionState['extensionRegistry'] {
    return session.providerBinding.kind === 'shared-persistent'
      ? this.state.sharedPersistent.extensionRegistry
      : session.extensionRegistry
  }

  private loadedExtensions(session: SessionState): SessionState['loadedExtensions'] {
    return session.providerBinding.kind === 'shared-persistent'
      ? this.state.sharedPersistent.loadedExtensions
      : session.loadedExtensions
  }

  private loadedExtensionIds(session: SessionState): Set<string> {
    return session.providerBinding.kind === 'shared-persistent'
      ? this.state.sharedPersistent.loadedExtensionIds
      : session.loadedExtensionIds
  }

  private async bindContext(session: SessionState): Promise<void> {
    const context = this.sessionContext(session)
    if (session.providerBinding.kind === 'shared-persistent') {
      const page = await this.createSharedPage(session)
      const view = this.bindView(session, page)
      session.activeViewId = view.viewId
      await this.applyLiveViewport(session, view)
      return
    }
    context.on('page', page => { this.acceptPage(session, page) })
    for (const page of context.pages()) this.bindView(session, page)
    const page = context.pages().find(item => this.bindView(session, item).kind === 'page') ?? await context.newPage()
    const view = this.bindView(session, page)
    session.activeViewId = view.viewId
    await this.applyLiveViewport(session, view)
  }

  private bindView(session: SessionState, page: Page, kind: ViewState['kind'] = 'page'): ViewState {
    const existing = [...session.views.values()].find(view => view.page === page)
    if (existing !== undefined) return existing
    const initialViewport = kind === 'extension-popup' ? { width: 420, height: 600 } : STANDARD_VIEWPORT
    const viewId = `v${session.nextViewId++}`
    const view: ViewState = {
      viewId,
      kind,
      page,
      documentGeneration: 0,
      navigationGeneration: 0,
      navigationId: `${viewId}-n0`,
      snapshotGeneration: 0,
      refs: new Map(),
      refCounter: 1,
      console: [],
      network: [],
      viewport: {
        width: initialViewport.width,
        height: initialViewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        generation: 0,
        contentWidth: initialViewport.width,
        fittedWidth: initialViewport.width,
        reflowedElements: 0,
        fitDocumentGeneration: -1,
      },
    }
    session.views.set(view.viewId, view)
    page.on('console', message => {
      const text = message.text().slice(0, this.config.maxOutputChars)
      const location = message.location()
      view.console.push({ level: message.type(), text, time: Date.now() })
      if (view.console.length > 200) view.console.splice(0, view.console.length - 200)
      const contextIdentity = view.cdp?.contextAdapter?.isEnabled()
        ? view.cdp.contextAdapter.contextForUrl(location.url)
        : {}
      this.journal.recordConsole({
        sessionId: session.sessionId,
        sessionKey: session.key,
        viewId: view.viewId,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...contextIdentity,
        source: 'console',
        level: message.type(),
        text,
        ...(location.url === '' ? {} : { url: redactUrl(location.url) }),
        ...(location.lineNumber === 0 ? {} : { line: location.lineNumber }),
        ...(location.columnNumber === 0 ? {} : { column: location.columnNumber }),
      })
      this.recorder.record(session.sessionId, session.key, {
        source: 'page',
        kind: 'console',
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...contextIdentity,
        outcome: /error|assert/i.test(message.type()) ? 'error' : message.type(),
        labels: { level: message.type() },
      })
    })
    page.on('pageerror', error => {
      const stack = error.stack?.slice(0, this.config.maxOutputChars)
      const location = parseGeneratedLocation(stack)
      const text = error.message.slice(0, this.config.maxOutputChars)
      view.console.push({ level: 'error', text, time: Date.now() })
      if (view.console.length > 200) view.console.splice(0, view.console.length - 200)
      const contextIdentity = view.cdp?.contextAdapter?.isEnabled()
        ? view.cdp.contextAdapter.contextForUrl(location?.url ?? '')
        : {}
      this.journal.recordConsole({
        sessionId: session.sessionId,
        sessionKey: session.key,
        viewId: view.viewId,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...contextIdentity,
        source: 'pageerror',
        level: 'error',
        text,
        ...(location === undefined ? {} : { url: redactUrl(location.url), line: location.line, column: location.column }),
        ...(stack === undefined ? {} : { stack }),
      })
      this.recorder.record(session.sessionId, session.key, {
        source: 'page',
        kind: 'page-error',
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...contextIdentity,
        outcome: 'error',
      })
    })
    page.on('request', request => this.recordRequest(session, view, request))
    page.on('response', response => {
      const request = response.request()
      const item = this.legacyRequests.get(request)
      if (item !== undefined) item.status = response.status()
      this.journal.recordResponse(request, response.status())
      const frameIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.contextForFrame(request.frame()) : {}
      this.recorder.record(session.sessionId, session.key, {
        source: 'page',
        kind: 'network-response',
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...frameIdentity,
        outcome: String(response.status()),
        metrics: { status: response.status() },
        labels: { method: request.method(), resourceType: request.resourceType() },
      })
    })
    page.on('requestfailed', request => {
      const item = this.legacyRequests.get(request)
      if (item !== undefined) item.failure = request.failure()?.errorText ?? 'request failed'
      const failedNavigationId = this.journal.requestNavigationId(request)
      this.journal.recordRequestFailure(request, request.failure()?.errorText ?? 'request failed')
      const frameIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.contextForFrame(request.frame()) : {}
      this.recorder.record(session.sessionId, session.key, {
        source: 'page',
        kind: 'network-failure',
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: failedNavigationId ?? view.navigationId,
        ...frameIdentity,
        outcome: 'failed',
        labels: { method: request.method(), resourceType: request.resourceType() },
      })
      if (request.isNavigationRequest()
        && request.frame() === page.mainFrame()
        && failedNavigationId !== undefined
        && failedNavigationId === view.pendingNavigationId) {
        // 主导航请求失败时撤销尚未提交的导航身份，避免后续同一文档事件被错误归入失败导航。
        view.pendingNavigationId = undefined
      }
    })
    page.on('requestfinished', request => this.journal.recordRequestFinished(request))
    page.on('dialog', dialog => {
      const policy = view.dialogPolicy
      if (policy !== undefined) {
        view.dialogPolicy = undefined
        void (policy.accept ? dialog.accept(policy.promptText) : dialog.dismiss())
      } else {
        view.dialog = dialog
      }
    })
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return
      if (view.pendingNavigationId === undefined) {
        view.navigationGeneration += 1
        view.navigationId = `${view.viewId}-n${view.navigationGeneration}`
      } else {
        view.navigationId = view.pendingNavigationId
        view.pendingNavigationId = undefined
      }
      view.documentGeneration += 1
      this.builds.invalidateDocument(session.key, view.viewId, view.documentGeneration)
      this.debugSessions.updateDocument(session.key, view.documentGeneration, view.navigationId)
      view.viewport.generation += 1
      view.viewport.contentWidth = view.viewport.width
      view.viewport.fittedWidth = view.viewport.width
      view.viewport.reflowedElements = 0
      view.viewport.fitDocumentGeneration = -1
      if (view.cdp !== undefined) view.cdp.latestFrame = undefined
      void this.releaseViewRefs(view)
      view.lastSnapshot = undefined
      const mainIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.mainContext() : {}
      this.recorder.record(session.sessionId, session.key, {
        source: 'page',
        kind: 'navigation',
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...mainIdentity,
        outcome: 'committed',
      })
    })
    page.on('load', () => {
      if (view.kind !== 'page' || session.liveView.mode !== 'adaptive' || page.isClosed()) return
      // 页面在 DOMContentLoaded 后仍可能继续加载样式并形成新的最小内容宽度；load 阶段重新适配，避免只依据导航早期布局作出错误判断。
      void this.queueSession(session, () => this.applyLiveViewport(session, view)).catch(() => {})
    })
    page.on('close', () => {
      if (view.kind === 'extension-popup') {
        void this.releaseViewRefs(view)
        const cdp = view.cdp
        cdp?.screencastConsumers.clear()
        cdp?.contextAdapter?.dispose()
        this.contextIdentities.removeView(session.key, view.viewId)
        view.cdp = undefined
        if (cdp !== undefined) void rawCdp(cdp.session).detach().catch(() => {})
        session.views.delete(view.viewId)
        this.applications.deactivateView(session.key, view.viewId)
        if (this.debugSessions.get(session.key)?.viewId === view.viewId) this.debugSessions.invalidate(session.key)
        if (session.extensionPopup?.view === view) session.extensionPopup = undefined
        return
      }
      const splitPane = this.splitPaneForView(session, view.viewId)
      const splitOther = splitPane === undefined ? undefined : this.splitPaneView(session, splitPane === 'top' ? 'bottom' : 'top')
      void this.releaseViewRefs(view)
      const cdp = view.cdp
      cdp?.screencastConsumers.clear()
      cdp?.contextAdapter?.dispose()
      this.contextIdentities.removeView(session.key, view.viewId)
      view.cdp = undefined
      if (cdp !== undefined) {
        for (const paused of cdp.pausedRequests.values()) {
          clearTimeout(paused.timer)
          void rawCdp(cdp.session).send('Fetch.continueRequest', { requestId: paused.requestId }).catch(() => {})
        }
        cdp.pausedRequests.clear()
        void rawCdp(cdp.session).detach().catch(() => {})
      }
      session.views.delete(view.viewId)
      this.applications.deactivateView(session.key, view.viewId)
      if (this.debugSessions.get(session.key)?.viewId === view.viewId) this.debugSessions.invalidate(session.key)
      if (splitPane !== undefined) {
        // 用户确认的关闭语义是任一可见分屏标签关闭后立即退回单页；保留另一标签可避免出现半空分屏和无目标地址栏。
        session.splitView.enabled = false
        session.splitView.topViewId = undefined
        session.splitView.bottomViewId = undefined
        session.splitView.changedAt = Date.now()
        session.activeViewId = splitOther?.viewId ?? ''
      }
      if (session.activeViewId === view.viewId) {
        // 网页脚本或外部 CDP 可能绕过插件按钮自行关闭活动标签；活动指针必须立即收敛到存活标签，末页关闭时则进入用户确认的无标签状态。
        const next = [...session.views.values()].find(item => item.kind === 'page' && !item.page.isClosed())
        session.activeViewId = next?.viewId ?? ''
        if (next !== undefined) {
          void next.page.bringToFront().catch(() => {})
          void this.applyLiveViewport(session, next).catch(() => {})
        }
      }
      // 页面可被网页脚本或外部CDP直接关闭；活动View收敛后重新同步，确保Deep Recorder或仍打开的实况立即转移到新的可见View。
      void this.queueSession(session, () => this.syncScreencasts(session)).catch(() => {})
    })
    return view
  }

  private sessionById(sessionId: string): SessionState | undefined {
    return [...this.state.sessions.values()].find(session => session.key.startsWith(`${sessionId}@`))
  }

  private async adoptPendingSession(identity: Identity): Promise<SessionState | undefined> {
    const pendingKey = pendingSessionKey(identity.sessionId)
    const pending = this.state.sessions.get(pendingKey)
    if (pending === undefined) return undefined
    const key = sessionKey(identity)
    const existing = this.state.sessions.get(key)
    if (existing !== undefined) {
      await this.cleanupProvider(pending)
      await this.artifacts.removeSession(pendingKey)
      this.state.sessions.delete(pendingKey)
      return existing
    }
    await this.queueSession(pending, async () => {
      await this.artifacts.migrateSession(pendingKey, key)
      this.journal.migrateSession(pendingKey, key)
      this.contextIdentities.migrateSession(pendingKey, key)
      this.recorder.migrateSession(pendingKey, key)
      this.inputTraces.migrateSession(pendingKey, key)
      this.builds.migrateSession(pendingKey, key)
      this.applications.migrateSession(pendingKey, key)
      this.state.sessions.delete(pendingKey)
      pending.key = key
      this.state.sessions.set(key, pending)
      if (pending.providerBinding.kind === 'shared-persistent') {
        // 草稿接管不重建Page；只把共享Owner键从@pending原子改为正式Session键，现有View、登录态和实况继续保留。
        for (const [page, owner] of this.state.sharedPersistent.pageOwners) {
          if (owner.sessionKey === pendingKey) this.state.sharedPersistent.pageOwners.set(page, { ...owner, sessionKey: key })
        }
      }
    })
    return pending
  }

  private async cdp(sessionState: SessionState, view: ViewState): Promise<NonNullable<ViewState['cdp']>> {
    if (view.cdp !== undefined) return view.cdp
    const session = await view.page.context().newCDPSession(view.page)
    const state: NonNullable<ViewState['cdp']> = {
      session,
      debuggerEnabled: false,
      paused: false,
      callFrames: [],
      scripts: new Map(),
      breakpoints: new Map(),
      screencastStarted: false,
      screencastConsumers: new Set(),
      streamGeneration: view.viewport.generation + 1,
      frameSequence: 0,
      lastAcceptedFrameAt: 0,
      networkEnabled: false,
      pausedRequests: new Map(),
      profile: {
        traceActive: false,
        cpuActive: false,
        jsCoverageActive: false,
        cssCoverageActive: false,
        heapSamplingActive: false,
        artifacts: [],
      },
    }
    view.cdp = state
    const client = rawCdp(session)
    state.contextAdapter = this.createContextAdapter(sessionState, view, client)
    client.on('Debugger.paused', payload => {
      state.paused = true
      state.reason = string(payload.reason)
      const frames = Array.isArray(payload.callFrames) ? payload.callFrames : []
      const callFrames: BrowserCallFrame[] = frames.map(value => {
        const frame = record(value)
        const location = record(frame.location)
        const scopeChain = Array.isArray(frame.scopeChain) ? frame.scopeChain : []
        return {
          callFrameId: string(frame.callFrameId),
          functionName: string(frame.functionName) || '(anonymous)',
          url: string(frame.url),
          lineNumber: number(location.lineNumber),
          columnNumber: number(location.columnNumber),
          scopes: scopeChain.map(scopeValue => {
            const scope = record(scopeValue)
            const object = record(scope.object)
            const name = string(scope.name)
            const objectId = string(object.objectId)
            return {
              type: string(scope.type),
              ...(name === '' ? {} : { name }),
              ...(objectId === '' ? {} : { objectId }),
            }
          }),
        }
      })
      state.callFrames = callFrames
    })
    client.on('Debugger.scriptParsed', payload => {
      const scriptId = string(payload.scriptId)
      if (scriptId === '') return
      const executionContextId = number(payload.executionContextId)
      const identity = executionContextId === 0 || state.contextAdapter?.isEnabled() !== true
        ? {}
        : state.contextAdapter.contextForExecution(executionContextId)
      const script = {
        scriptId,
        url: string(payload.url),
        startLine: number(payload.startLine),
        startColumn: number(payload.startColumn),
        endLine: number(payload.endLine),
        endColumn: number(payload.endColumn),
        ...(executionContextId === 0 ? {} : { executionContextId }),
        ...identity,
      }
      state.scripts.set(scriptId, script)
      this.builds.registerScript(sessionState.key, {
        scriptId,
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        url: script.url,
        startLine: script.startLine,
        startColumn: script.startColumn,
        endLine: script.endLine,
        endColumn: script.endColumn,
        loadedAt: Date.now(),
        active: true,
        ...identity,
      })
      if (state.contextAdapter?.isEnabled()) state.contextAdapter.registerScript(script.url, identity)
      if (state.contextAdapter?.isEnabled()) {
        this.journal.recordScript({
          sessionId: sessionState.sessionId,
          sessionKey: sessionState.key,
          viewId: view.viewId,
          contextGeneration: sessionState.contextGeneration,
          documentGeneration: view.documentGeneration,
          navigationId: view.navigationId,
          ...identity,
          scriptId,
          url: script.url,
          ...(string(payload.sourceMapURL) === '' ? {} : { sourceMapUrl: string(payload.sourceMapURL) }),
          startLine: script.startLine,
          startColumn: script.startColumn,
          endLine: script.endLine,
          endColumn: script.endColumn,
        })
      }
    })
    client.on('Runtime.executionContextDestroyed', payload => {
      const executionContextId = number(payload.executionContextId)
      if (executionContextId !== 0) this.builds.deactivateExecutionContext(sessionState.key, executionContextId)
    })
    client.on('Runtime.executionContextsCleared', () => {
      const targetId = state.contextAdapter?.mainContext().targetId
      if (targetId !== undefined) this.builds.deactivateTarget(sessionState.key, targetId)
    })
    client.on('Target.detachedFromTarget', payload => {
      const targetId = string(payload.targetId)
      if (targetId !== '') this.builds.deactivateTarget(sessionState.key, targetId)
    })
    client.on('Debugger.resumed', () => {
      state.paused = false
      state.reason = undefined
      state.callFrames = []
    })
    client.on('Page.screencastFrame', payload => {
      const sessionId = number(payload.sessionId)
      const receivedAt = Date.now()
      // Chromium动画页可接近60FPS；悬浮面板目标是30FPS。过早帧立即ACK但不复制Base64、不推进对外帧序号，把CPU和内存带宽留给实际可展示画面与输入。
      if (state.latestFrame !== undefined && receivedAt - state.lastAcceptedFrameAt < 33) {
        void client.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
        return
      }
      const metadata = record(payload.metadata)
      state.lastAcceptedFrameAt = receivedAt
      state.frameSequence += 1
      state.latestFrame = {
        streamGeneration: state.streamGeneration,
        sequence: state.frameSequence,
        mediaType: 'image/jpeg',
        data: string(payload.data),
        width: number(metadata.deviceWidth),
        height: number(metadata.deviceHeight),
        viewportGeneration: view.viewport.generation,
      }
      const recorderState = this.recorder.status(sessionState.sessionId, sessionState.key)
      if (recorderState.mode === 'deep' && recorderState.status === 'recording') {
        const mainIdentity = state.contextAdapter?.isEnabled() ? state.contextAdapter.mainContext() : {}
        this.recorder.record(sessionState.sessionId, sessionState.key, {
          source: 'system',
          kind: 'visual-frame',
          viewId: view.viewId,
          documentGeneration: view.documentGeneration,
          navigationId: view.navigationId,
          ...mainIdentity,
          metrics: {
            width: number(metadata.deviceWidth),
            height: number(metadata.deviceHeight),
            frameSequence: state.frameSequence,
            viewportGeneration: view.viewport.generation,
          },
        })
      }
      void client.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    client.on('Fetch.requestPaused', payload => {
      const request = record(payload.request)
      const requestId = string(payload.requestId)
      if (requestId === '') return
      const previous = state.pausedRequests.get(requestId)
      if (previous !== undefined) clearTimeout(previous.timer)
      const timer = setTimeout(() => {
        const paused = state.pausedRequests.get(requestId)
        if (paused === undefined) return
        state.pausedRequests.delete(requestId)
        // 模型未在时限内处理时自动放行，避免页面因拦截队列永久冻结。
        void client.send('Fetch.continueRequest', { requestId }).catch(() => {})
      }, this.config.interceptionTimeoutMs)
      state.pausedRequests.set(requestId, {
        requestId,
        ...(string(payload.networkId) === '' ? {} : { networkId: string(payload.networkId) }),
        url: redactUrl(string(request.url)),
        rawUrl: string(request.url),
        method: string(request.method),
        resourceType: string(payload.resourceType),
        requestStage: typeof payload.responseStatusCode === 'number' ? 'response' : 'request',
        ...(typeof payload.responseStatusCode === 'number' ? { responseStatusCode: payload.responseStatusCode } : {}),
        ...(typeof payload.responseStatusText === 'string' ? { responseStatusText: payload.responseStatusText } : {}),
        headers: Object.entries(record(request.headers)).map(([name, value]) => ({ name, value: /authorization|cookie|token|secret|password/i.test(name) ? '[REDACTED]' : String(value) })),
        ...(typeof request.postData === 'string' ? { postData: request.postData } : {}),
        createdAt: Date.now(),
        timer,
      })
    })
    client.on('Tracing.tracingComplete', payload => {
      state.profile.resolveTrace?.(payload)
      state.profile.resolveTrace = undefined
    })
    client.on('HeapProfiler.addHeapSnapshotChunk', payload => {
      const chunk = string(payload.chunk)
      if (state.profile.heapSnapshotChunks === undefined || state.profile.heapSnapshotOverflow === true) return
      state.profile.heapSnapshotBytes = (state.profile.heapSnapshotBytes ?? 0) + Buffer.byteLength(chunk)
      if (state.profile.heapSnapshotBytes > this.config.maxArtifactBytes) {
        state.profile.heapSnapshotOverflow = true
        state.profile.heapSnapshotChunks.length = 0
        return
      }
      state.profile.heapSnapshotChunks.push(chunk)
    })
    return state
  }

  private createContextAdapter(session: SessionState, view: ViewState, client: RawCdpSession): CdpContextAdapter {
    return new CdpContextAdapter(client, this.contextIdentities, {
      sessionId: session.sessionId,
      sessionKey: session.key,
      viewId: view.viewId,
      browserContextGeneration: session.contextGeneration,
      owner: session.provider === 'external-cdp' ? 'external' : session.provider === 'managed' ? 'managed' : 'persistent',
    })
  }

  private async ensureContextIdentity(session: SessionState, view: ViewState): Promise<NonNullable<ViewState['cdp']>> {
    const state = await this.cdp(session, view)
    if (state.contextAdapter === undefined || state.contextAdapter.isDisposed()) {
      state.contextAdapter = this.createContextAdapter(session, view, rawCdp(state.session))
    }
    await state.contextAdapter.enable()
    if (!state.debuggerEnabled) {
      await rawCdp(state.session).send('Debugger.enable')
      state.debuggerEnabled = true
    }
    return state
  }

  private pausedRequests(view: ViewState) {
    return [...(view.cdp?.pausedRequests.values() ?? [])].map(item => ({
      requestId: item.requestId,
      url: item.url,
      method: item.method,
      resourceType: item.resourceType,
      requestStage: item.requestStage,
      ...(item.responseStatusCode === undefined ? {} : { responseStatusCode: item.responseStatusCode }),
      ...(item.responseStatusText === undefined ? {} : { responseStatusText: item.responseStatusText }),
      createdAt: item.createdAt,
    }))
  }

  private async releasePausedRequests(view: ViewState): Promise<void> {
    const state = view.cdp
    if (state === undefined) return
    const client = rawCdp(state.session)
    await Promise.all([...state.pausedRequests.values()].map(async item => {
      clearTimeout(item.timer)
      await client.send('Fetch.continueRequest', { requestId: item.requestId }).catch(() => {})
    }))
    state.pausedRequests.clear()
  }

  private async networkAction(session: SessionState, input: BrowserNetworkInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    if (actor === 'model' && input.action !== 'list_paused' && input.action !== 'body') {
      const blocked = this.modelWriteBlocked(session, view, 'network_control')
      if (blocked !== undefined) return blocked
    }
    const state = await this.cdp(session, view)
    const client = rawCdp(state.session)
    if (input.action === 'enable') {
      const stages = input.requestStage === 'request' ? ['Request'] : input.requestStage === 'response' ? ['Response'] : ['Request', 'Response']
      const patterns = stages.map(requestStage => ({
        urlPattern: input.urlPattern?.trim() || '*',
        ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
        requestStage,
      }))
      await client.send('Fetch.enable', { patterns, handleAuthRequests: false })
      state.networkEnabled = true
    } else if (input.action === 'disable') {
      await this.releasePausedRequests(view)
      await client.send('Fetch.disable').catch(() => {})
      state.networkEnabled = false
    } else if (input.action !== 'list_paused') {
      if (input.requestId === undefined) fail('INVALID_ARGS', `${input.action} requires requestId`)
      const paused = state.pausedRequests.get(input.requestId)
      if (paused === undefined) return { ok: false, action: 'network_control', viewId: view.viewId, data: asData({ code: 'UNKNOWN_PAUSED_REQUEST', recoverable: true, message: 'The paused request expired or was already handled.', next: { tool: 'browser_network_control', arguments: { action: 'list_paused', viewId: view.viewId } } }) }
      if (input.action === 'body') {
        let body = paused.postData ?? ''
        let base64Encoded = false
        if (paused.requestStage === 'response') {
          const result = await client.send('Fetch.getResponseBody', { requestId: paused.requestId })
          body = string(result.body)
          base64Encoded = result.base64Encoded === true
        }
        const raw = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
        if (raw.byteLength > this.config.maxOutputChars) {
          const artifact = await this.artifacts.save(session.key, 'network-body', `network-${paused.requestId}.bin`, raw)
          state.profile.artifacts.push(artifact)
          return { ok: true, action: 'network_body', viewId: view.viewId, data: asData({ requestId: paused.requestId, bytes: raw.byteLength, base64Encoded, artifact }) }
        }
        return { ok: true, action: 'network_body', viewId: view.viewId, data: asData({ requestId: paused.requestId, bytes: raw.byteLength, base64Encoded, body: base64Encoded ? raw.toString('base64') : raw.toString('utf8') }) }
      }
      if (input.action === 'replay') {
        const response = await this.sessionContext(session).request.fetch(paused.rawUrl, {
          method: paused.method,
          ...(paused.postData === undefined ? {} : { data: paused.postData }),
          failOnStatusCode: false,
        })
        const body = await response.body()
        const artifact = await this.artifacts.save(session.key, 'network-replay', `replay-${paused.requestId}.bin`, body)
        state.profile.artifacts.push(artifact)
        return { ok: true, action: 'network_replay', viewId: view.viewId, data: asData({ requestId: paused.requestId, status: response.status(), bytes: body.byteLength, artifact }) }
      }
      clearTimeout(paused.timer)
      state.pausedRequests.delete(paused.requestId)
      if (input.action === 'continue') await client.send('Fetch.continueRequest', { requestId: paused.requestId })
      else if (input.action === 'abort') await client.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: input.errorReason ?? 'Aborted' })
      else if (input.action === 'fulfill') {
        if (input.responseCode === undefined) fail('INVALID_ARGS', 'fulfill requires responseCode')
        const body = input.body ?? ''
        await client.send('Fetch.fulfillRequest', {
          requestId: paused.requestId,
          responseCode: input.responseCode,
          ...(input.responsePhrase === undefined ? {} : { responsePhrase: input.responsePhrase }),
          ...(input.headers === undefined ? {} : { responseHeaders: input.headers }),
          body: input.bodyBase64 === true ? body : Buffer.from(body).toString('base64'),
        })
      } else fail('INVALID_ARGS', `unknown browser_network_control action ${JSON.stringify(input.action)}`)
    }
    return { ok: true, action: 'network_control', viewId: view.viewId, data: asData({ enabled: state.networkEnabled, pausedRequests: this.pausedRequests(view) }) }
  }

  private async readCdpStream(client: RawCdpSession, handle: string): Promise<Buffer[]> {
    const chunks: Buffer[] = []
    let eof = false
    let bytes = 0
    while (!eof) {
      const result = await client.send('IO.read', { handle, size: 1024 * 1024 })
      const data = string(result.data)
      const chunk = result.base64Encoded === true ? Buffer.from(data, 'base64') : Buffer.from(data)
      bytes += chunk.byteLength
      if (bytes > this.config.maxArtifactBytes) {
        await client.send('IO.close', { handle }).catch(() => {})
        fail('ARTIFACT_TOO_LARGE', `browser artifact exceeds the configured ${this.config.maxArtifactBytes} byte limit`)
      }
      chunks.push(chunk)
      eof = result.eof === true
    }
    await client.send('IO.close', { handle }).catch(() => {})
    return chunks
  }

  private async saveProfileArtifact(session: SessionState, view: ViewState, kind: string, name: string, data: Uint8Array | string): Promise<ToolOutput> {
    const artifact = await this.artifacts.save(session.key, kind, name, data)
    const state = await this.cdp(session, view)
    state.profile.artifacts.push(artifact)
    return { ok: true, action: 'profile', viewId: view.viewId, data: asData({ artifact }) }
  }

  private async profileAction(session: SessionState, input: BrowserProfileInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    if (input.action === 'artifacts') {
      return { ok: true, action: 'profile_artifacts', data: asData({ artifacts: this.artifacts.list(session.key) }) }
    }
    if (input.action === 'artifact_read') {
      if (input.artifactId === undefined) fail('INVALID_ARGS', 'artifact_read requires artifactId')
      const maxReadBytes = Math.min(Math.max(input.maxReadBytes ?? this.config.maxOutputChars, 1), this.config.maxOutputChars)
      const result = await this.artifacts.read(session.key, input.artifactId, maxReadBytes)
      return { ok: true, action: 'artifact_read', data: asData({ artifact: result.reference, encoding: 'base64', data: result.data.toString('base64') }) }
    }
    const view = this.view(session, input.viewId)
    if (actor === 'model') {
      const blocked = this.modelWriteBlocked(session, view, 'profile')
      if (blocked !== undefined) return blocked
    }
    if (
      session.providerBinding.kind === 'shared-persistent'
      && (input.action === 'playwright_trace_start' || input.action === 'playwright_trace_stop')
    ) {
      // Playwright Trace属于BrowserContext级能力，会采集共享Context中其他Session的Page；默认共享Provider必须拒绝，避免任务内容跨Session进入同一制品。
      fail(
        'PROFILE_REQUIRES_ISOLATED_CONTEXT',
        'Playwright context tracing requires a named persistent profile so the trace cannot capture pages owned by other sessions. Switch with browser_provider connect provider=managed-persistent profileName=<name>, then retry.',
      )
    }
    const state = await this.cdp(session, view)
    const client = rawCdp(state.session)
    if (input.action === 'trace_start') {
      if (state.profile.traceActive) fail('PROFILE_ALREADY_ACTIVE', 'trace is already active for this view')
      await client.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing'],
        },
      })
      state.profile.traceActive = true
      return { ok: true, action: 'trace_start', viewId: view.viewId, data: asData({ active: true }) }
    }
    if (input.action === 'playwright_trace_start') {
      if (session.playwrightTraceViewId !== undefined) fail('PROFILE_ALREADY_ACTIVE', `Playwright trace is already active for view ${session.playwrightTraceViewId}`)
      await this.sessionContext(session).tracing.start({ screenshots: true, snapshots: true, sources: true })
      session.playwrightTraceViewId = view.viewId
      return { ok: true, action: 'playwright_trace_start', viewId: view.viewId, data: asData({ active: true }) }
    }
    if (input.action === 'playwright_trace_stop') {
      if (session.playwrightTraceViewId === undefined) fail('PROFILE_NOT_ACTIVE', 'Playwright trace is not active for this context')
      const staging = join(this.config.artifactRoot, 'staging')
      await mkdir(staging, { recursive: true })
      const path = join(staging, `${session.key.replace(/[^\w.-]/g, '_')}-${view.viewId}-${Date.now()}.zip`)
      try {
        await this.sessionContext(session).tracing.stop({ path })
        session.playwrightTraceViewId = undefined
        const data = await readFile(path)
        return this.saveProfileArtifact(session, view, 'playwright-trace', `playwright-trace-${view.viewId}.zip`, data)
      } finally {
        await rm(path, { force: true })
      }
    }
    if (input.action === 'trace_stop') {
      if (!state.profile.traceActive) fail('PROFILE_NOT_ACTIVE', 'trace is not active for this view')
      state.profile.traceCompletion = new Promise(resolve => { state.profile.resolveTrace = resolve })
      await client.send('Tracing.end')
      const completion = await Promise.race([
        state.profile.traceCompletion,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('trace completion timed out')), 30000)),
      ])
      const stream = string(completion.stream)
      state.profile.traceActive = false
      state.profile.traceCompletion = undefined
      if (stream === '') fail('PROFILE_FAILED', 'trace completed without a data stream')
      const chunks = await this.readCdpStream(client, stream)
      const artifact = await this.artifacts.saveChunks(session.key, 'trace', `trace-${view.viewId}.json`, chunks)
      state.profile.artifacts.push(artifact)
      return { ok: true, action: 'trace_stop', viewId: view.viewId, data: asData({ artifact }) }
    }
    if (input.action === 'cpu_start') {
      if (state.profile.cpuActive) fail('PROFILE_ALREADY_ACTIVE', 'CPU profile is already active for this view')
      await client.send('Profiler.enable')
      await client.send('Profiler.start')
      state.profile.cpuActive = true
      return { ok: true, action: 'cpu_start', viewId: view.viewId, data: asData({ active: true }) }
    }
    if (input.action === 'cpu_stop') {
      if (!state.profile.cpuActive) fail('PROFILE_NOT_ACTIVE', 'CPU profile is not active for this view')
      const result = await client.send('Profiler.stop')
      state.profile.cpuActive = false
      return this.saveProfileArtifact(session, view, 'cpu-profile', `cpu-${view.viewId}.json`, JSON.stringify(result.profile ?? result))
    }
    if (input.action === 'coverage_start') {
      if (state.profile.jsCoverageActive || state.profile.cssCoverageActive) fail('PROFILE_ALREADY_ACTIVE', 'coverage is already active for this view')
      await view.page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true })
      await view.page.coverage.startCSSCoverage({ resetOnNavigation: false })
      state.profile.jsCoverageActive = true
      state.profile.cssCoverageActive = true
      return { ok: true, action: 'coverage_start', viewId: view.viewId, data: asData({ active: true }) }
    }
    if (input.action === 'coverage_stop') {
      if (!state.profile.jsCoverageActive && !state.profile.cssCoverageActive) fail('PROFILE_NOT_ACTIVE', 'coverage is not active for this view')
      const [js, css] = await Promise.all([
        state.profile.jsCoverageActive ? view.page.coverage.stopJSCoverage() : Promise.resolve([]),
        state.profile.cssCoverageActive ? view.page.coverage.stopCSSCoverage() : Promise.resolve([]),
      ])
      state.profile.jsCoverageActive = false
      state.profile.cssCoverageActive = false
      const summary = {
        javascript: js.map(item => ({ url: item.url, sourceBytes: Buffer.byteLength(item.source ?? ''), functions: item.functions })),
        css: css.map(item => ({ url: item.url, textBytes: Buffer.byteLength(item.text ?? ''), ranges: item.ranges })),
      }
      return this.saveProfileArtifact(session, view, 'coverage', `coverage-${view.viewId}.json`, JSON.stringify(summary))
    }
    if (input.action === 'heap_snapshot') {
      if (state.profile.heapSnapshotChunks !== undefined) fail('PROFILE_ALREADY_ACTIVE', 'heap snapshot is already active for this view')
      state.profile.heapSnapshotChunks = []
      state.profile.heapSnapshotBytes = 0
      state.profile.heapSnapshotOverflow = undefined
      try {
        await client.send('HeapProfiler.enable')
        await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true })
        if (state.profile.heapSnapshotOverflow === true) fail('ARTIFACT_TOO_LARGE', `heap snapshot exceeds the configured ${this.config.maxArtifactBytes} byte limit`)
        const chunks = state.profile.heapSnapshotChunks
        const artifact = await this.artifacts.saveChunks(session.key, 'heap-snapshot', `heap-${view.viewId}.heapsnapshot`, chunks)
        state.profile.artifacts.push(artifact)
        return { ok: true, action: 'heap_snapshot', viewId: view.viewId, data: asData({ artifact }) }
      } finally {
        state.profile.heapSnapshotChunks = undefined
        state.profile.heapSnapshotBytes = undefined
        state.profile.heapSnapshotOverflow = undefined
      }
    }
    if (input.action === 'heap_sampling_start') {
      if (state.profile.heapSamplingActive) fail('PROFILE_ALREADY_ACTIVE', 'heap sampling is already active for this view')
      await client.send('HeapProfiler.enable')
      await client.send('HeapProfiler.startSampling', { samplingInterval: 32768 })
      state.profile.heapSamplingActive = true
      return { ok: true, action: 'heap_sampling_start', viewId: view.viewId, data: asData({ active: true }) }
    }
    if (input.action === 'heap_sampling_stop') {
      if (!state.profile.heapSamplingActive) fail('PROFILE_NOT_ACTIVE', 'heap sampling is not active for this view')
      const result = await client.send('HeapProfiler.stopSampling')
      state.profile.heapSamplingActive = false
      return this.saveProfileArtifact(session, view, 'heap-sampling', `heap-sampling-${view.viewId}.json`, JSON.stringify(result.profile ?? result))
    }
    fail('INVALID_ARGS', `unknown browser_profile action ${JSON.stringify(input.action)}`)
  }

  private providerState(session: SessionState) {
    return {
      active: session.provider,
      ...(session.providerEndpoint === undefined ? {} : { endpoint: session.providerEndpoint }),
      ...(session.persistentProfile === undefined ? {} : { persistentProfile: session.persistentProfile }),
      providers: [
        { provider: 'managed', isolation: 'session-context', connected: session.provider === 'managed' },
        { provider: 'managed-persistent', isolation: session.providerBinding.kind === 'shared-persistent' ? 'shared-plugin-profile' : 'session-profile', connected: session.provider === 'managed-persistent' },
        { provider: 'external-cdp', isolation: 'external-browser', connected: session.provider === 'external-cdp' },
      ],
    }
  }

  private async extensionState(session: SessionState): Promise<{ extensions: BrowserExtensionSummary[]; chromium: Awaited<ReturnType<ChromiumManager['status']>> }> {
    const registry = session.providerBinding.kind === 'shared-persistent' ? this.state.sharedPersistent.extensionRegistry : session.extensionRegistry
    const loadedExtensions = session.providerBinding.kind === 'shared-persistent' ? this.state.sharedPersistent.loadedExtensions : session.loadedExtensions
    const registeredIds = new Set(registry.map(extension => extension.extensionId))
    const loadedById = new Map(loadedExtensions.map(extension => [extension.extensionId, extension]))
    return {
      extensions: [
        ...registry.map((extension) => {
          const loaded = loadedById.get(extension.extensionId)
          return {
            extensionId: extension.extensionId,
            name: extension.name,
            version: extension.version,
            enabled: extension.enabled,
            loaded: loaded !== undefined,
            pendingRestart: extension.enabled
              ? loaded === undefined || loaded.path !== extension.path || loaded.version !== extension.version
              : loaded !== undefined,
            installedAt: extension.installedAt,
            sourceUrl: extension.sourceUrl,
            ...(extension.actionPopup === undefined ? {} : { actionPopup: extension.actionPopup }),
          }
        }),
        ...loadedExtensions
          .filter(extension => !registeredIds.has(extension.extensionId))
          .map(extension => ({
            extensionId: extension.extensionId,
            name: extension.name,
            version: extension.version,
            enabled: false,
            loaded: true,
            pendingRestart: true,
            installedAt: extension.installedAt,
            sourceUrl: extension.sourceUrl,
            ...(extension.actionPopup === undefined ? {} : { actionPopup: extension.actionPopup }),
          })),
      ],
      chromium: await this.chromiumManager.status(),
    }
  }

  private restorableTabs(session: SessionState): { urls: string[]; activeIndex: number; split?: { topIndex: number; bottomIndex: number; focusedPane: BrowserSplitViewPane; ratio: number } } {
    const views = [...session.views.values()].filter(view => view.kind === 'page' && !view.page.isClosed())
    const urls = views.map((view) => {
      const url = view.page.url()
      if (url === 'about:blank') return url
      try {
        return assertUrlAllowed(this.config, url).href
      } catch {
        return 'about:blank'
      }
    })
    const activeIndex = Math.max(0, views.findIndex(view => view.viewId === session.activeViewId))
    const topIndex = views.findIndex(view => view.viewId === session.splitView.topViewId)
    const bottomIndex = views.findIndex(view => view.viewId === session.splitView.bottomViewId)
    return {
      urls: urls.length === 0 ? ['about:blank'] : urls,
      activeIndex,
      ...(session.splitView.enabled && topIndex >= 0 && bottomIndex >= 0 && topIndex !== bottomIndex
        ? { split: { topIndex, bottomIndex, focusedPane: session.splitView.focusedPane, ratio: session.splitView.ratio } }
        : {}),
    }
  }

  private async restoreTabs(session: SessionState, tabs: { urls: string[]; activeIndex: number; split?: { topIndex: number; bottomIndex: number; focusedPane: BrowserSplitViewPane; ratio: number } }): Promise<void> {
    const pages = this.sessionPages(session)
    for (let index = 0; index < tabs.urls.length; index += 1) {
      const page = pages[index] ?? await this.createPage(session)
      const url = tabs.urls[index] as string
      if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
    for (const page of this.sessionPages(session).slice(tabs.urls.length)) await page.close({ runBeforeUnload: false }).catch(() => {})
    const sessionPages = this.sessionPages(session)
    const active = sessionPages[Math.min(tabs.activeIndex, sessionPages.length - 1)]
    if (active !== undefined) {
      const view = [...session.views.values()].find(item => item.page === active)
      if (view !== undefined) {
        session.activeViewId = view.viewId
        await active.bringToFront().catch(() => {})
      }
    }
    const restoredPages = this.sessionPages(session)
    const topPage = tabs.split === undefined ? undefined : restoredPages[tabs.split.topIndex]
    const bottomPage = tabs.split === undefined ? undefined : restoredPages[tabs.split.bottomIndex]
    const topView = topPage === undefined ? undefined : [...session.views.values()].find(item => item.page === topPage)
    const bottomView = bottomPage === undefined ? undefined : [...session.views.values()].find(item => item.page === bottomPage)
    if (tabs.split !== undefined && topView !== undefined && bottomView !== undefined && topView.viewId !== bottomView.viewId) {
      // Context 重建会生成全新 viewId，必须通过标签索引重新映射；直接复用旧 ID会让分屏和人工输入全部变成悬空引用。
      session.splitView.enabled = true
      session.splitView.topViewId = topView.viewId
      session.splitView.bottomViewId = bottomView.viewId
      session.splitView.focusedPane = tabs.split.focusedPane
      session.splitView.ratio = tabs.split.ratio
      session.splitView.changedAt = Date.now()
      session.activeViewId = tabs.split.focusedPane === 'top' ? topView.viewId : bottomView.viewId
      await this.syncScreencasts(session)
    } else {
      session.splitView.enabled = false
      session.splitView.topViewId = undefined
      session.splitView.bottomViewId = undefined
    }
  }

  private async restartPersistentSession(session: SessionState, tabs = this.restorableTabs(session), launchExtensions?: readonly SessionState['extensionRegistry'][number][]): Promise<void> {
    const profileName = session.persistentProfile ?? 'default'
    await this.cleanupProvider(session)
    const persistent = await this.persistentContext(session.sessionId, profileName, launchExtensions)
    session.providerBinding = { kind: 'isolated-persistent', context: persistent.context, profileName }
    session.extensionRegistry = persistent.extensionRegistry
    session.loadedExtensions = persistent.loadedExtensions
    session.loadedExtensionIds = persistent.loadedExtensionIds
    session.provider = 'managed-persistent'
    session.persistentProfile = profileName
    await this.bindContext(session)
    await this.restoreTabs(session, tabs)
  }

  private async restartSharedPersistentContext(
    launchExtensions?: readonly SessionState['extensionRegistry'][number][],
    restorableTabs?: ReadonlyMap<SessionState['key'], ReturnType<BrowserRuntime['restorableTabs']>>,
  ): Promise<void> {
    const shared = this.state.sharedPersistent
    const sessions = this.sharedSessions()
    const restorable = restorableTabs ?? new Map(sessions.map(session => [session.key, this.restorableTabs(session)]))
    const previousContext = shared.context
    shared.restarting = true
    try {
      for (const session of sessions) await this.cleanupProvider(session)
      shared.context = undefined
      shared.pageOwners.clear()
      shared.pendingPageCreation = undefined
      if (previousContext !== undefined) await previousContext.close().catch(() => {})
      await this.launchSharedPersistentContext(launchExtensions)
      this.syncSharedExtensions()
      for (const session of sessions) {
        session.provider = 'managed-persistent'
        session.persistentProfile = 'default'
        await this.bindContext(session)
        const tabs = restorable.get(session.key)
        if (tabs !== undefined) await this.restoreTabs(session, tabs)
      }
      await this.profiles.pruneSharedExtensionDirectories([
        ...shared.extensionRegistry,
        ...shared.loadedExtensions,
      ])
    } finally {
      shared.restarting = false
    }
  }

  private extensionMutationRequiresSharedLock(session: SessionState, input: BrowserExtensionInput): boolean {
    return session.providerBinding.kind === 'shared-persistent'
      && input.action !== 'list'
      && input.action !== 'open_popup'
      && input.action !== 'close_popup'
  }

  private async extensionAction(session: SessionState, input: BrowserExtensionInput): Promise<ToolOutput> {
    if (input.action === 'list') {
      return { ok: true, action: 'extensions', viewId: session.activeViewId, data: asData(await this.extensionState(session)) }
    }
    if (input.action === 'close_popup') {
      const popup = session.extensionPopup
      if (popup !== undefined) await popup.view.page.close({ runBeforeUnload: false }).catch(() => {})
      session.extensionPopup = undefined
      return { ok: true, action: 'extensions_close_popup', viewId: session.activeViewId, data: asData({ closed: popup !== undefined }) }
    }
    if (input.action === 'open_popup') {
      const extensionId = input.extensionId?.trim()
      if (extensionId === undefined || extensionId === '') fail('INVALID_ARGS', 'extension open_popup requires extensionId')
      const extension = this.extensionRegistry(session).find(item => item.extensionId === extensionId)
      if (extension === undefined) fail('UNKNOWN_EXTENSION', `browser extension ${JSON.stringify(extensionId)} is not installed`)
      if (!extension.enabled || !this.loadedExtensionIds(session).has(extensionId)) fail('EXTENSION_NOT_LOADED', 'the extension must be enabled and loaded before its popup can open')
      if (extension.actionPopup === undefined || extension.actionPopup.trim() === '') fail('EXTENSION_POPUP_UNAVAILABLE', 'the extension does not declare an action popup')
      const base = new URL(`chrome-extension://${extensionId}/`)
      const popupUrl = new URL(extension.actionPopup, base)
      if (popupUrl.origin !== base.origin) fail('POLICY_DENIED', 'extension popup must stay inside its own extension origin')
      if (session.extensionPopup !== undefined) await session.extensionPopup.view.page.close({ runBeforeUnload: false }).catch(() => {})
      session.extensionPopup = undefined
      session.openingExtensionPopup = { extensionId, name: extension.name }
      try {
        const page = await this.createPage(session, 'extension-popup')
        const view = this.bindView(session, page, 'extension-popup')
        session.extensionPopup = { extensionId, name: extension.name, view }
        await page.setViewportSize({ width: 420, height: 600 })
        view.viewport.width = 420
        view.viewport.height = 600
        view.viewport.contentWidth = 420
        view.viewport.fittedWidth = 420
        view.viewport.generation += 1
        await page.goto(popupUrl.href, { waitUntil: 'domcontentloaded', timeout: 15000 })
        const size = await page.locator('body').evaluate((body) => ({ width: Math.ceil(Math.max(body.scrollWidth, body.getBoundingClientRect().width)), height: Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)) })).catch(() => ({ width: 420, height: 600 }))
        const width = Math.min(Math.max(size.width, 240), 600)
        const height = Math.min(Math.max(size.height, 180), 720)
        await page.setViewportSize({ width, height })
        view.viewport.width = width
        view.viewport.height = height
        view.viewport.contentWidth = width
        view.viewport.fittedWidth = width
        view.viewport.generation += 1
        await this.syncScreencasts(session)
        return { ok: true, action: 'extensions_open_popup', viewId: session.activeViewId, data: asData({ extensionId, name: extension.name, popupViewId: view.viewId, width, height }) }
      } catch (error) {
        const popup = session.extensionPopup
        session.extensionPopup = undefined
        if (popup !== undefined) await popup.view.page.close({ runBeforeUnload: false }).catch(() => {})
        throw error
      } finally {
        session.openingExtensionPopup = undefined
      }
    }
    const applyMode = input.applyMode ?? 'next_start'
    if (applyMode !== 'next_start' && applyMode !== 'now') fail('INVALID_ARGS', 'extension applyMode must be next_start or now')
    const sharedMode = session.providerBinding.kind === 'shared-persistent'
    const previous = [...this.extensionRegistry(session)]
    let next = previous
    if (input.action === 'install') {
      if (input.extension === undefined || input.extension.trim() === '') fail('INVALID_ARGS', 'extension install requires a Chrome Web Store URL or extension ID')
      const staging = sharedMode
        ? this.profiles.sharedExtensionStagingDirectory('download')
        : this.profiles.extensionStagingDirectory(session.sessionId, 'download')
      let installed: Awaited<ReturnType<typeof downloadChromeWebStoreExtension>>
      try {
        // 品牌 Chrome/Edge 已移除自动化扩展侧载参数；首次安装先准备插件专用 Chromium，同时用其浏览器网络栈作为官方商店下载回退。
        const chromiumExecutablePath = await this.chromiumManager.ensureInstalled()
        installed = await downloadChromeWebStoreExtension(input.extension, staging, chromiumExecutablePath)
        const target = sharedMode
          ? this.profiles.sharedExtensionDirectory(installed.extensionId)
          : this.profiles.extensionDirectory(session.sessionId, installed.extensionId)
        await mkdir(join(target, '..'), { recursive: true })
        await rename(staging, target)
        next = [
          ...previous.filter(extension => extension.extensionId !== installed.extensionId),
          {
            extensionId: installed.extensionId,
            name: installed.name,
            version: installed.version,
            enabled: true,
            installedAt: Date.now(),
            sourceUrl: installed.sourceUrl,
            path: target,
            ...(installed.actionPopup === undefined ? {} : { actionPopup: installed.actionPopup }),
          },
        ]
      } catch (error) {
        await rm(staging, { recursive: true, force: true })
        throw error
      }
    } else if (input.action === 'enable' || input.action === 'disable') {
      const extensionId = input.extensionId?.trim()
      if (extensionId === undefined || extensionId === '') fail('INVALID_ARGS', `extension ${input.action} requires extensionId`)
      if (!previous.some(extension => extension.extensionId === extensionId)) fail('UNKNOWN_EXTENSION', `browser extension ${JSON.stringify(extensionId)} is not installed`)
      next = previous.map(extension => extension.extensionId === extensionId ? { ...extension, enabled: input.action === 'enable' } : extension)
    } else if (input.action === 'uninstall') {
      const extensionId = input.extensionId?.trim()
      if (extensionId === undefined || extensionId === '') fail('INVALID_ARGS', 'extension uninstall requires extensionId')
      if (!previous.some(extension => extension.extensionId === extensionId)) fail('UNKNOWN_EXTENSION', `browser extension ${JSON.stringify(extensionId)} is not installed`)
      next = previous.filter(extension => extension.extensionId !== extensionId)
    } else if (input.action !== 'apply') {
      fail('INVALID_ARGS', `unknown browser extension action ${JSON.stringify(input.action)}`)
    }
    if (input.action !== 'apply') {
      if (sharedMode) {
        await this.profiles.saveSharedExtensions(next)
        this.state.sharedPersistent.extensionRegistry = next
        this.syncSharedExtensions()
      } else {
        await this.profiles.saveExtensions(session.sessionId, next)
        session.extensionRegistry = next
      }
    }
    if (applyMode === 'now' || input.action === 'apply') {
      const tabs = this.restorableTabs(session)
      const sharedTabs = sharedMode
        ? new Map(this.sharedSessions().map(item => [item.key, this.restorableTabs(item)]))
        : undefined
      const previouslyLoaded = [...this.loadedExtensions(session)]
      try {
        if (sharedMode) await this.restartSharedPersistentContext(undefined, sharedTabs)
        else await this.restartPersistentSession(session, tabs)
      } catch (error) {
        if (input.action !== 'apply') {
          if (sharedMode) {
            await this.profiles.saveSharedExtensions(previous)
            this.state.sharedPersistent.extensionRegistry = previous
            this.syncSharedExtensions()
          } else {
            await this.profiles.saveExtensions(session.sessionId, previous)
            session.extensionRegistry = previous
          }
        }
        if (sharedMode) await this.restartSharedPersistentContext(previouslyLoaded, sharedTabs).catch(() => {})
        else await this.restartPersistentSession(session, tabs, previouslyLoaded).catch(() => {})
        throw error
      }
    }
    return { ok: true, action: `extensions_${input.action}`, viewId: session.activeViewId, data: asData(await this.extensionState(session)) }
  }

  private async providerAction(session: SessionState, input: BrowserProviderInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    if (input.action === 'list' || input.action === 'capabilities') {
      return { ok: true, action: 'provider', viewId: session.activeViewId, data: asData(this.providerState(session)) }
    }
    if (input.action === 'disconnect') {
      const current = session.views.get(session.activeViewId)
      if (actor === 'model' && current !== undefined) {
        const blocked = this.modelWriteBlocked(session, current, 'provider_disconnect')
        if (blocked !== undefined) return blocked
      }
      await this.cleanupProvider(session)
      await this.sharedPersistentContext()
      const shared = this.state.sharedPersistent
      session.providerBinding = { kind: 'shared-persistent' }
      session.extensionRegistry = [...shared.extensionRegistry]
      session.loadedExtensions = [...shared.loadedExtensions]
      session.loadedExtensionIds = new Set(shared.loadedExtensionIds)
      session.provider = 'managed-persistent'
      session.persistentProfile = 'default'
      await this.bindContext(session)
      return { ok: true, action: 'provider_disconnect', viewId: session.activeViewId, data: asData(this.providerState(session)) }
    }
    if (input.action !== 'connect' || input.provider === undefined) fail('INVALID_ARGS', 'provider connect requires provider')
    const current = session.views.get(session.activeViewId)
    if (actor === 'model' && current !== undefined) {
      const blocked = this.modelWriteBlocked(session, current, 'provider_connect')
      if (blocked !== undefined) return blocked
    }
    const requestedProfile = input.profileName?.trim() || 'default'
    const alreadyConnected = input.provider === session.provider
      && input.provider !== 'external-cdp'
      && (input.provider !== 'managed-persistent'
        || (requestedProfile === 'default' && session.providerBinding.kind === 'shared-persistent')
        || (session.providerBinding.kind === 'isolated-persistent' && session.providerBinding.profileName === requestedProfile))
    if (alreadyConnected) {
      return { ok: true, action: 'provider_connect', viewId: session.activeViewId, data: asData(this.providerState(session)) }
    }
    await this.cleanupProvider(session)
    try {
      if (input.provider === 'managed') {
        session.providerBinding = { kind: 'isolated-managed', context: await this.managedContext() }
        session.provider = 'managed'
        session.loadedExtensionIds.clear()
      } else if (input.provider === 'managed-persistent') {
        const profileName = requestedProfile
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(profileName)) fail('INVALID_ARGS', 'persistent profileName contains unsupported characters')
        if (profileName === 'default') {
          await this.sharedPersistentContext()
          const shared = this.state.sharedPersistent
          session.providerBinding = { kind: 'shared-persistent' }
          session.extensionRegistry = [...shared.extensionRegistry]
          session.loadedExtensions = [...shared.loadedExtensions]
          session.loadedExtensionIds = new Set(shared.loadedExtensionIds)
        } else {
          const persistent = await this.persistentContext(session.sessionId, profileName)
          session.providerBinding = { kind: 'isolated-persistent', context: persistent.context, profileName }
          session.extensionRegistry = persistent.extensionRegistry
          session.loadedExtensions = persistent.loadedExtensions
          session.loadedExtensionIds = persistent.loadedExtensionIds
        }
        session.provider = 'managed-persistent'
        session.persistentProfile = profileName
      } else {
        if (input.endpoint === undefined) fail('INVALID_ARGS', 'external-cdp connect requires endpoint')
        const endpoint = assertCdpEndpoint(input.endpoint)
        const browser = await chromium.connectOverCDP(endpoint.href, { timeout: this.config.externalCdpTimeoutMs })
        const context = browser.contexts()[0]
        if (context === undefined) {
          await browser.close().catch(() => {})
          fail('PROVIDER_UNAVAILABLE', 'external CDP browser does not expose a default context')
        }
        await this.installSurfaceProbe(context)
        session.providerBinding = { kind: 'external-cdp', context, browser, endpoint: endpoint.origin }
        session.provider = 'external-cdp'
        session.providerBrowser = browser
        session.providerEndpoint = endpoint.origin
      }
      await this.bindContext(session)
      return { ok: true, action: 'provider_connect', viewId: session.activeViewId, data: asData(this.providerState(session)) }
    } catch (error) {
      await this.sharedPersistentContext()
      const shared = this.state.sharedPersistent
      session.providerBinding = { kind: 'shared-persistent' }
      session.extensionRegistry = [...shared.extensionRegistry]
      session.loadedExtensions = [...shared.loadedExtensions]
      session.loadedExtensionIds = new Set(shared.loadedExtensionIds)
      session.provider = 'managed-persistent'
      session.persistentProfile = 'default'
      await this.bindContext(session)
      throw error
    }
  }

  private normalizeAdaptiveViewport(width: number, height: number, minimum: { width: number; height: number } = MIN_ADAPTIVE_VIEWPORT): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height)) fail('INVALID_ARGS', 'adaptive viewport requires finite width and height')
    return {
      width: Math.min(Math.max(Math.round(width), minimum.width), MAX_ADAPTIVE_VIEWPORT.width),
      height: Math.min(Math.max(Math.round(height), minimum.height), MAX_ADAPTIVE_VIEWPORT.height),
    }
  }

  private liveViewport(session: SessionState): { width: number; height: number } {
    if (session.liveView.mode === 'standard') return { width: session.liveView.fixedWidth, height: session.liveView.fixedHeight }
    if (session.liveView.adaptiveWidth === undefined || session.liveView.adaptiveHeight === undefined) return STANDARD_VIEWPORT
    return { width: session.liveView.adaptiveWidth, height: session.liveView.adaptiveHeight }
  }

  private splitPaneView(session: SessionState, pane: BrowserSplitViewPane): ViewState | undefined {
    const viewId = pane === 'top' ? session.splitView.topViewId : session.splitView.bottomViewId
    const view = viewId === undefined ? undefined : session.views.get(viewId)
    return view === undefined || view.page.isClosed() ? undefined : view
  }

  private visibleViewIds(session: SessionState): Set<string> {
    const visible = session.splitView.enabled
      ? new Set([session.splitView.topViewId, session.splitView.bottomViewId].filter((value): value is string => value !== undefined))
      : new Set(session.activeViewId === '' ? [] : [session.activeViewId])
    if (session.extensionPopup !== undefined) visible.add(session.extensionPopup.view.viewId)
    return visible
  }

  private splitPaneForView(session: SessionState, viewId: string): BrowserSplitViewPane | undefined {
    if (!session.splitView.enabled) return undefined
    if (session.splitView.topViewId === viewId) return 'top'
    if (session.splitView.bottomViewId === viewId) return 'bottom'
    return undefined
  }

  private async syncScreencasts(session: SessionState): Promise<void> {
    const visible = this.visibleViewIds(session)
    const recorder = this.recorder.status(session.sessionId, session.key)
    const recorderVisible = recorder.mode === 'deep' && recorder.status === 'recording'
    await Promise.all([...session.views.values()].map(async view => {
      const isVisible = visible.has(view.viewId)
      if (session.liveView.open && isVisible) await this.ensureScreencast(session, view, 'live-view')
      else await this.releaseScreencast(view, 'live-view')
      if (recorderVisible && isVisible) await this.ensureScreencast(session, view, 'recorder')
      else await this.releaseScreencast(view, 'recorder')
    }))
  }

  private splitSnapshot(session: SessionState) {
    return {
      enabled: session.splitView.enabled,
      focusedPane: session.splitView.focusedPane,
      ratio: session.splitView.ratio,
      changedAt: session.splitView.changedAt,
      ...(session.splitView.topViewId === undefined ? {} : { topViewId: session.splitView.topViewId }),
      ...(session.splitView.bottomViewId === undefined ? {} : { bottomViewId: session.splitView.bottomViewId }),
    }
  }

  private async splitViewAction(session: SessionState, input: BrowserSplitViewInput): Promise<ToolOutput> {
    const current = session.views.get(session.activeViewId) ?? [...session.views.values()].find(view => view.kind === 'page' && !view.page.isClosed())
    if (input.action === 'status') return { ok: true, action: 'split_view', viewId: current?.viewId, data: asData({ ...this.splitSnapshot(session), changed: false }) }
    if (current === undefined) return { ok: false, action: 'split_view', data: asData({ code: 'NO_ACTIVE_TAB', recoverable: true, message: 'Split view requires at least one browser tab.' }) }
    let changed = false
    if (input.action === 'open') {
      let second = [...session.views.values()].find(view => view.kind === 'page' && !view.page.isClosed() && view.viewId !== current.viewId)
      if (second === undefined) second = this.bindView(session, await this.createPage(session))
      session.splitView.enabled = true
      session.splitView.topViewId = current.viewId
      session.splitView.bottomViewId = second.viewId
      session.splitView.focusedPane = 'top'
      session.activeViewId = current.viewId
      changed = true
    } else if (input.action === 'close') {
      if (session.splitView.enabled) {
        const focused = this.splitPaneView(session, session.splitView.focusedPane) ?? current
        session.splitView.enabled = false
        session.splitView.topViewId = undefined
        session.splitView.bottomViewId = undefined
        session.activeViewId = focused.viewId
        changed = true
      }
    } else if (input.action === 'swap') {
      if (!session.splitView.enabled) fail('INVALID_ARGS', 'split view is not open')
      const top = session.splitView.topViewId
      session.splitView.topViewId = session.splitView.bottomViewId
      session.splitView.bottomViewId = top
      session.splitView.focusedPane = session.splitView.focusedPane === 'top' ? 'bottom' : 'top'
      changed = true
    } else if (input.action === 'assign') {
      if (!session.splitView.enabled || input.pane === undefined || input.viewId === undefined) fail('INVALID_ARGS', 'split assign requires an open split, pane, and viewId')
      const target = this.view(session, input.viewId)
      const otherPane: BrowserSplitViewPane = input.pane === 'top' ? 'bottom' : 'top'
      const other = this.splitPaneView(session, otherPane)
      if (other?.viewId === target.viewId) {
        session.splitView.focusedPane = otherPane
      } else {
        if (input.pane === 'top') session.splitView.topViewId = target.viewId
        else session.splitView.bottomViewId = target.viewId
        session.splitView.focusedPane = input.pane
      }
      session.activeViewId = target.viewId
      changed = true
    } else if (input.action === 'focus') {
      if (!session.splitView.enabled || input.pane === undefined) fail('INVALID_ARGS', 'split focus requires an open split and pane')
      const target = this.splitPaneView(session, input.pane)
      if (target === undefined) fail('UNKNOWN_VIEW', 'split pane does not contain a live tab')
      changed = session.splitView.focusedPane !== input.pane
      session.splitView.focusedPane = input.pane
      session.activeViewId = target.viewId
      await target.page.bringToFront()
    } else if (input.action === 'ratio') {
      if (!session.splitView.enabled || input.ratio === undefined || !Number.isFinite(input.ratio)) fail('INVALID_ARGS', 'split ratio requires an open split and finite ratio')
      const ratio = Math.min(Math.max(input.ratio, 0.4), 0.6)
      changed = session.splitView.ratio !== ratio
      session.splitView.ratio = ratio
      if (changed) await this.profiles.saveSplitViewRatio(session.sessionId, ratio)
    } else if (input.action === 'resize') {
      if (!session.splitView.enabled || input.pane === undefined || input.width === undefined || input.height === undefined) fail('INVALID_ARGS', 'split resize requires pane, width, and height')
      const target = this.splitPaneView(session, input.pane)
      if (target === undefined) fail('UNKNOWN_VIEW', 'split pane does not contain a live tab')
      const viewport = this.normalizeAdaptiveViewport(input.width, input.height, MIN_SPLIT_ADAPTIVE_VIEWPORT)
      const pane = session.splitView.panes[input.pane]
      changed = pane.adaptiveWidth !== viewport.width || pane.adaptiveHeight !== viewport.height
      pane.adaptiveWidth = viewport.width
      pane.adaptiveHeight = viewport.height
      if (changed && session.liveView.mode === 'adaptive') await this.applyLiveViewport(session, target)
    } else fail('INVALID_ARGS', `unknown browser_split_view action ${JSON.stringify(input.action)}`)
    if (changed) session.splitView.changedAt = Date.now()
    await this.syncScreencasts(session)
    return { ok: true, action: 'split_view', viewId: session.activeViewId, data: asData({ ...this.splitSnapshot(session), changed }) }
  }

  private async setViewViewport(session: SessionState, view: ViewState, width: number, height: number): Promise<void> {
    if (view.viewport.width === width && view.viewport.height === height) return
    const state = await this.cdp(session, view)
    await rawCdp(state.session).send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: view.viewport.deviceScaleFactor, mobile: view.viewport.mobile })
    view.viewport.width = width
    view.viewport.height = height
    view.viewport.generation += 1
    state.latestFrame = undefined
  }

  private async clearAdaptiveFit(view: ViewState): Promise<void> {
    const removed = await view.page.evaluate(attribute => {
      const style = document.querySelector(`style[${attribute}]`)
      const elements = document.querySelectorAll(`[${attribute}]`)
      const changed = style !== null || elements.length > 0
      style?.remove()
      elements.forEach(element => element.removeAttribute(attribute))
      return changed
    }, ADAPTIVE_REFLOW_ATTRIBUTE).catch(() => false)
    const changed = removed || view.viewport.reflowedElements > 0
    view.viewport.contentWidth = view.viewport.width
    view.viewport.fittedWidth = view.viewport.width
    view.viewport.reflowedElements = 0
    view.viewport.fitDocumentGeneration = -1
    if (!changed) return
    view.viewport.generation += 1
    if (view.cdp !== undefined) view.cdp.latestFrame = undefined
  }

  private async applyAdaptiveFit(session: SessionState, view: ViewState): Promise<void> {
    const result = await view.page.evaluate(({ attribute, viewportWidth }) => {
      document.querySelector(`style[${attribute}]`)?.remove()
      document.querySelectorAll(`[${attribute}]`).forEach(element => element.removeAttribute(attribute))
      const root = document.documentElement
      if (root === null) return { contentWidth: viewportWidth, fittedWidth: viewportWidth, reflowedElements: 0 }
      const body = document.body
      const contentWidth = Math.max(root.clientWidth, root.scrollWidth, body?.scrollWidth ?? 0, viewportWidth)
      if (contentWidth <= viewportWidth + 1) {
        return { contentWidth, fittedWidth: contentWidth, reflowedElements: 0 }
      }

      const allowed = new Set(['DIV', 'MAIN', 'SECTION', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'ARTICLE', 'FORM'])
      const style = document.createElement('style')
      style.setAttribute(attribute, '')
      style.textContent = `
        html, body {
          min-width: 0 !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
        [${attribute}="normal"] {
          min-width: 0 !important;
          max-width: 100% !important;
          width: 100% !important;
          box-sizing: border-box !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
        [${attribute}="absolute"] {
          min-width: 0 !important;
          max-width: 100% !important;
          left: 0 !important;
          right: 0 !important;
          width: auto !important;
          box-sizing: border-box !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
      `
      ;(document.head ?? root).append(style)

      let previousWidth = contentWidth
      let reflowedElements = 0
      for (let pass = 0; pass < 3; pass += 1) {
        const candidates = [...document.querySelectorAll('body *')].filter(element => {
          if (!(element instanceof HTMLElement) || !allowed.has(element.tagName) || element.hasAttribute(attribute)) return false
          const rect = element.getBoundingClientRect()
          const computed = getComputedStyle(element)
          if (computed.display === 'none' || rect.width <= 0) return false
          const minWidth = Number.parseFloat(computed.minWidth)
          return (Number.isFinite(minWidth) && minWidth > viewportWidth + 1)
            || rect.width > viewportWidth + 1
            || (rect.right > viewportWidth + 1 && rect.width > viewportWidth * 0.75)
        })
        const candidateSet = new Set(candidates)
        const outermost = candidates.filter(element => {
          let parent = element.parentElement
          while (parent !== null) {
            if (candidateSet.has(parent)) return false
            parent = parent.parentElement
          }
          return true
        })
        if (outermost.length === 0) break
        for (const element of outermost) {
          const position = getComputedStyle(element).position
          element.setAttribute(attribute, position === 'absolute' || position === 'fixed' ? 'absolute' : 'normal')
        }
        reflowedElements += outermost.length
        root.getBoundingClientRect()
        const currentWidth = Math.max(root.clientWidth, root.scrollWidth, body?.scrollWidth ?? 0, viewportWidth)
        if (currentWidth >= previousWidth - 1) break
        previousWidth = currentWidth
        if (currentWidth <= viewportWidth + 1) break
      }
      const fittedWidth = Math.max(root.clientWidth, root.scrollWidth, body?.scrollWidth ?? 0, viewportWidth)
      return {
        contentWidth,
        fittedWidth,
        reflowedElements,
      }
    }, { attribute: ADAPTIVE_REFLOW_ATTRIBUTE, viewportWidth: view.viewport.width }).catch(() => undefined)
    if (result === undefined) return
    const changed = view.viewport.contentWidth !== result.contentWidth
      || view.viewport.fittedWidth !== result.fittedWidth
      || view.viewport.reflowedElements !== result.reflowedElements
    view.viewport.contentWidth = result.contentWidth
    view.viewport.fittedWidth = result.fittedWidth
    view.viewport.reflowedElements = result.reflowedElements
    view.viewport.fitDocumentGeneration = view.documentGeneration
    if (!changed) return
    // 强制重排会改变实况中的元素位置和尺寸，必须使旧帧身份失效，避免人工点击落到重排前的坐标。
    view.viewport.generation += 1
    if (view.cdp !== undefined) {
      const state = view.cdp
      state.latestFrame = undefined
      // 静态页面重排后不一定产生新的合成事件；已启动的Screencast必须重新开始，强制Chromium发送当前Viewport代际的首帧，避免面板永久停留在空画面。
      if (state.screencastStarted) await this.restartScreencast(session, view)
    }
  }

  private async applyLiveViewport(session: SessionState, view: ViewState): Promise<void> {
    const pane = this.splitPaneForView(session, view.viewId)
    const paneSize = pane === undefined ? undefined : session.splitView.panes[pane]
    // 自适应分屏必须使用每个窗格自己的真实尺寸；共用 Session 尺寸会让上、下网页互相覆盖 Viewport。
    const viewport = session.liveView.mode === 'adaptive' && paneSize?.adaptiveWidth !== undefined && paneSize.adaptiveHeight !== undefined
      ? { width: paneSize.adaptiveWidth, height: paneSize.adaptiveHeight }
      : this.liveViewport(session)
    await this.setViewViewport(session, view, viewport.width, viewport.height)
    if (session.liveView.mode === 'adaptive') await this.applyAdaptiveFit(session, view)
    else await this.clearAdaptiveFit(view)
  }

  private async applyVisibleLiveViewports(session: SessionState): Promise<void> {
    const visible = this.visibleViewIds(session)
    await Promise.all([...visible].map(async viewId => {
      const view = session.views.get(viewId)
      if (view !== undefined && !view.page.isClosed()) await this.applyLiveViewport(session, view)
    }))
  }

  private liveViewState(session: SessionState, view: ViewState) {
    return {
      mode: session.liveView.mode,
      width: view.viewport.width,
      height: view.viewport.height,
      viewportGeneration: view.viewport.generation,
      reflowed: view.viewport.reflowedElements > 0,
      contentWidth: view.viewport.contentWidth,
      fittedWidth: view.viewport.fittedWidth,
      reflowedElements: view.viewport.reflowedElements,
      changedAt: session.liveView.changedAt,
      standard: STANDARD_VIEWPORT,
      adaptive: session.liveView.adaptiveWidth === undefined || session.liveView.adaptiveHeight === undefined
        ? null
        : { width: session.liveView.adaptiveWidth, height: session.liveView.adaptiveHeight },
    }
  }

  private async liveViewAction(session: SessionState, input: BrowserLiveViewInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    if (input.action === 'status') return { ok: true, action: 'live_view', viewId: view.viewId, data: asData({ ...this.liveViewState(session, view), changed: false }) }
    if (actor === 'model' && (input.action === 'standard' || input.action === 'adaptive')) {
      const blocked = this.modelWriteBlocked(session, view, 'live_view')
      if (blocked !== undefined) return blocked
    }
    if (input.action === 'initialize') {
      if (!session.liveView.initialized) {
        session.liveView.mode = input.mode ?? 'adaptive'
        session.liveView.initialized = true
        session.liveView.changedAt = Date.now()
      }
      if (input.width !== undefined && input.height !== undefined) {
        const viewport = this.normalizeAdaptiveViewport(input.width, input.height)
        session.liveView.adaptiveWidth = viewport.width
        session.liveView.adaptiveHeight = viewport.height
      }
      await this.applyVisibleLiveViewports(session)
      return { ok: true, action: 'live_view', viewId: view.viewId, data: asData({ ...this.liveViewState(session, view), changed: false }) }
    }
    if (input.action === 'resize') {
      if (input.width === undefined || input.height === undefined) fail('INVALID_ARGS', 'live view resize requires width and height')
      const viewport = this.normalizeAdaptiveViewport(input.width, input.height)
      const changed = session.liveView.adaptiveWidth !== viewport.width || session.liveView.adaptiveHeight !== viewport.height
      session.liveView.adaptiveWidth = viewport.width
      session.liveView.adaptiveHeight = viewport.height
      if (changed && session.liveView.mode === 'adaptive') {
        session.liveView.changedAt = Date.now()
        await this.applyVisibleLiveViewports(session)
      }
      return { ok: true, action: 'live_view', viewId: view.viewId, data: asData({ ...this.liveViewState(session, view), changed }) }
    }
    const previousMode = session.liveView.mode
    const previousWidth = view.viewport.width
    const previousHeight = view.viewport.height
    if (input.action === 'standard') {
      session.liveView.mode = 'standard'
      session.liveView.initialized = true
      session.liveView.fixedWidth = STANDARD_VIEWPORT.width
      session.liveView.fixedHeight = STANDARD_VIEWPORT.height
    } else if (input.action === 'adaptive') {
      if (input.width !== undefined && input.height !== undefined) {
        const viewport = this.normalizeAdaptiveViewport(input.width, input.height)
        session.liveView.adaptiveWidth = viewport.width
        session.liveView.adaptiveHeight = viewport.height
      }
      if (session.liveView.adaptiveWidth === undefined || session.liveView.adaptiveHeight === undefined) {
        return { ok: false, action: 'live_view', viewId: view.viewId, data: asData({ code: 'ADAPTIVE_SIZE_UNAVAILABLE', recoverable: true, message: 'Adaptive mode requires an open live panel to report its available size.', next: { tool: 'browser_live_view', arguments: { action: 'standard', viewId: view.viewId } } }) }
      }
      session.liveView.mode = 'adaptive'
      session.liveView.initialized = true
    } else fail('INVALID_ARGS', `unknown browser_live_view action ${JSON.stringify(input.action)}`)
    session.liveView.changedAt = Date.now()
    await this.applyVisibleLiveViewports(session)
    const changed = previousMode !== session.liveView.mode || previousWidth !== view.viewport.width || previousHeight !== view.viewport.height
    return { ok: true, action: 'live_view', viewId: view.viewId, data: asData({ ...this.liveViewState(session, view), changed }) }
  }

  private async emulateAction(session: SessionState, input: BrowserEmulateInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    if (actor === 'model') {
      const blocked = this.modelWriteBlocked(session, view, 'emulate')
      if (blocked !== undefined) return blocked
    }
    const state = await this.cdp(session, view)
    const client = rawCdp(state.session)
    if (input.action === 'viewport') {
      if (input.width === undefined || input.height === undefined) fail('INVALID_ARGS', 'viewport requires width and height')
      await this.clearAdaptiveFit(view)
      await client.send('Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: input.deviceScaleFactor ?? 1, mobile: input.mobile ?? false })
      view.viewport.width = input.width
      view.viewport.height = input.height
      view.viewport.deviceScaleFactor = input.deviceScaleFactor ?? 1
      view.viewport.mobile = input.mobile ?? false
      view.viewport.contentWidth = input.width
      view.viewport.fittedWidth = input.width
      view.viewport.reflowedElements = 0
      view.viewport.fitDocumentGeneration = -1
      view.viewport.generation += 1
      state.latestFrame = undefined
      session.liveView.mode = 'standard'
      session.liveView.initialized = true
      session.liveView.fixedWidth = input.width
      session.liveView.fixedHeight = input.height
      session.liveView.changedAt = Date.now()
    } else if (input.action === 'device') {
      if (input.device === undefined) fail('INVALID_ARGS', 'device requires device')
      const descriptor = devices[input.device]
      if (descriptor === undefined) fail('INVALID_ARGS', `unknown Playwright device ${JSON.stringify(input.device)}`)
      await this.clearAdaptiveFit(view)
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
        deviceScaleFactor: descriptor.deviceScaleFactor,
        mobile: descriptor.isMobile,
        screenOrientation: descriptor.viewport.width > descriptor.viewport.height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      })
      await client.send('Emulation.setUserAgentOverride', { userAgent: descriptor.userAgent })
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: descriptor.hasTouch })
      view.viewport.width = descriptor.viewport.width
      view.viewport.height = descriptor.viewport.height
      view.viewport.deviceScaleFactor = descriptor.deviceScaleFactor
      view.viewport.mobile = descriptor.isMobile
      view.viewport.contentWidth = descriptor.viewport.width
      view.viewport.fittedWidth = descriptor.viewport.width
      view.viewport.reflowedElements = 0
      view.viewport.fitDocumentGeneration = -1
      view.viewport.generation += 1
      state.latestFrame = undefined
      session.liveView.mode = 'standard'
      session.liveView.initialized = true
      session.liveView.fixedWidth = descriptor.viewport.width
      session.liveView.fixedHeight = descriptor.viewport.height
      session.liveView.changedAt = Date.now()
    } else if (input.action === 'locale') {
      if (input.locale === undefined) fail('INVALID_ARGS', 'locale requires locale')
      await client.send('Emulation.setLocaleOverride', { locale: input.locale })
    } else if (input.action === 'timezone') {
      if (input.timezoneId === undefined) fail('INVALID_ARGS', 'timezone requires timezoneId')
      await client.send('Emulation.setTimezoneOverride', { timezoneId: input.timezoneId })
    } else if (input.action === 'network' || input.action === 'offline') {
      const offline = input.action === 'offline' ? input.offline ?? true : input.offline ?? false
      await client.send('Network.enable')
      await client.send('Network.emulateNetworkConditions', {
        offline,
        latency: input.latencyMs ?? 0,
        downloadThroughput: input.downloadKbps === undefined ? -1 : Math.round(input.downloadKbps * 1024 / 8),
        uploadThroughput: input.uploadKbps === undefined ? -1 : Math.round(input.uploadKbps * 1024 / 8),
      })
    } else if (input.action === 'cpu') {
      await client.send('Emulation.setCPUThrottlingRate', { rate: Math.max(input.rate ?? 1, 1) })
    } else if (input.action === 'permissions') {
      if (input.permissions === undefined) fail('INVALID_ARGS', 'permissions requires permissions')
      await this.sessionContext(session).grantPermissions(input.permissions, input.origin === undefined ? undefined : { origin: input.origin })
    } else if (input.action === 'reset') {
      await this.clearAdaptiveFit(view)
      await Promise.all([
        client.send('Emulation.clearDeviceMetricsOverride').catch(() => ({})),
        client.send('Emulation.setLocaleOverride', { locale: '' }).catch(() => ({})),
        client.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => ({})),
        client.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => ({})),
        client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => ({})),
        this.sessionContext(session).clearPermissions(),
      ])
      view.viewport.width = STANDARD_VIEWPORT.width
      view.viewport.height = STANDARD_VIEWPORT.height
      view.viewport.deviceScaleFactor = 1
      view.viewport.mobile = false
      view.viewport.contentWidth = STANDARD_VIEWPORT.width
      view.viewport.fittedWidth = STANDARD_VIEWPORT.width
      view.viewport.reflowedElements = 0
      view.viewport.fitDocumentGeneration = -1
      view.viewport.generation += 1
      state.latestFrame = undefined
      session.liveView.mode = 'standard'
      session.liveView.initialized = true
      session.liveView.fixedWidth = STANDARD_VIEWPORT.width
      session.liveView.fixedHeight = STANDARD_VIEWPORT.height
      session.liveView.changedAt = Date.now()
    } else fail('INVALID_ARGS', `unknown browser_emulate action ${JSON.stringify(input.action)}`)
    return { ok: true, action: 'emulate', viewId: view.viewId, data: asData({ action: input.action }) }
  }

  private safeRemoteResult(value: unknown): unknown {
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (key, item) => {
      if (/token|secret|password|cookie|authorization/i.test(key)) return '[REDACTED]'
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
    if (json === undefined) return null
    return json.length > this.config.maxOutputChars ? `${json.slice(0, this.config.maxOutputChars)}…` : JSON.parse(json)
  }

  private async evaluateAction(session: SessionState, input: BrowserEvaluateInput): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    const state = await this.cdp(session, view)
    const client = rawCdp(state.session)
    let result: Record<string, unknown>
    if (input.action === 'paused_frame') {
      const callFrameId = input.callFrameId ?? state.callFrames[0]?.callFrameId
      if (callFrameId === undefined || !state.paused) fail('DEBUGGER_NOT_PAUSED', 'paused_frame evaluation requires a paused call frame')
      result = await client.send('Debugger.evaluateOnCallFrame', { callFrameId, expression: input.expression, returnByValue: true, awaitPromise: input.awaitPromise ?? true, silent: true })
    } else if (input.action === 'isolated') {
      await client.send('Page.enable')
      await client.send('Runtime.enable')
      const tree = await client.send('Page.getFrameTree')
      const frameId = string(record(record(tree.frameTree).frame).id)
      const world = await client.send('Page.createIsolatedWorld', { frameId, worldName: 'dsh-browser-tools', grantUniveralAccess: false })
      result = await client.send('Runtime.evaluate', { expression: input.expression, contextId: number(world.executionContextId), returnByValue: true, awaitPromise: input.awaitPromise ?? true, silent: true })
    } else if (input.action === 'main_world') {
      result = await client.send('Runtime.evaluate', { expression: input.expression, returnByValue: true, awaitPromise: input.awaitPromise ?? true, silent: true })
    } else fail('INVALID_ARGS', `unknown browser_evaluate action ${JSON.stringify(input.action)}`)
    if (result.exceptionDetails !== undefined) return { ok: false, action: 'evaluate', viewId: view.viewId, data: asData({ code: 'EVALUATION_FAILED', recoverable: false, exception: this.safeRemoteResult(result.exceptionDetails) }) }
    const remote = record(result.result)
    return {
      ok: true,
      action: 'evaluate',
      viewId: view.viewId,
      data: asData({
        ...(typeof remote.type === 'string' ? { type: remote.type } : {}),
        ...(typeof remote.subtype === 'string' ? { subtype: remote.subtype } : {}),
        value: this.safeRemoteResult(remote.value ?? remote.description ?? null),
      }),
    }
  }

  private async takeoverAction(session: SessionState, input: BrowserTakeoverInput): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    if (input.action === 'request') {
      if (session.control.owner !== 'user') {
        session.diagnosticPanel.takeover = {
          startedAt: Date.now(),
          startedSequence: this.journal.cursor(session.key).sequence,
          viewId: view.viewId,
          documentGeneration: view.documentGeneration,
          navigationId: view.navigationId,
        }
      }
      session.control.owner = 'user'
      session.control.pending = false
      session.control.changedAt = Date.now()
    } else if (input.action === 'return') {
      this.finishPanelTakeover(session, view)
      session.control.owner = 'model'
      session.control.pending = false
      session.control.changedAt = Date.now()
    } else if (input.action === 'cancel') {
      session.control.pending = false
      session.control.changedAt = Date.now()
    } else if (input.action !== 'status') fail('INVALID_ARGS', `unknown browser_takeover action ${JSON.stringify(input.action)}`)
    return { ok: true, action: 'takeover', viewId: view.viewId, data: asData(session.control) }
  }

  private async userInputAction(session: SessionState, input: BrowserUserInput): Promise<ToolOutput> {
    if (!this.visibleViewIds(session).has(input.viewId)) {
      return { ok: false, action: 'user_input', viewId: input.viewId, data: asData({ code: 'STALE_LIVE_VIEW', recoverable: true, message: 'The active browser view changed before the user input was delivered. Wait for the newest frame and try again.' }) }
    }
    const view = this.view(session, input.viewId)
    const pane = this.splitPaneForView(session, view.viewId)
    if (pane !== undefined) {
      // 点击或键盘输入任一窗格时同步焦点，保证地址栏、调试面板和后续未显式 viewId 的模型工具都指向用户刚操作的页面。
      session.splitView.focusedPane = pane
      session.activeViewId = view.viewId
    }
    const popupInput = session.extensionPopup?.view.viewId === input.viewId
    if (session.control.owner !== 'user' && !popupInput) fail('POLICY_DENIED', 'browser user input requires active user takeover')
    const state = await this.cdp(session, view)
    const client = rawCdp(state.session)
    const frame = state.latestFrame
    // 人工接管按远程桌面语义工作：坐标由同一Viewport映射，动画换帧不会改变坐标系。仍严格校验View、Screencast流和Viewport代际，防止跨标签、重连或缩放后的旧坐标被派发。
    if (
      frame === undefined
      || frame.streamGeneration !== input.streamGeneration
      || frame.viewportGeneration !== input.viewportGeneration
      || view.viewport.generation !== input.viewportGeneration
    ) {
      return { ok: false, action: 'user_input', viewId: view.viewId, data: asData({ code: 'STALE_LIVE_VIEW', recoverable: true, message: 'The live view changed before the user input was delivered. Wait for the newest frame and try again.' }) }
    }
    const coordinateInput = input.action === 'mouse_click' || input.action === 'mouse_down' || input.action === 'mouse_move' || input.action === 'mouse_up' || input.action === 'mouse_wheel'
    if (coordinateInput && (input.x < 0 || input.x >= view.viewport.width || input.y < 0 || input.y >= view.viewport.height)) {
      return { ok: false, action: 'user_input', viewId: view.viewId, data: asData({ code: 'INPUT_OUT_OF_RANGE', recoverable: true, message: 'The pointer coordinate is outside the current browser viewport.' }) }
    }
    if (input.action === 'mouse_click') {
      const button = input.button ?? 'left'
      const clickCount = Math.min(Math.max(input.clickCount ?? 1, 1), 3)
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button, clickCount })
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button, clickCount })
    } else if (input.action === 'mouse_down') {
      const button = input.button ?? 'left'
      const clickCount = Math.min(Math.max(input.clickCount ?? 1, 1), 3)
      // 每个View只允许一个人工指针手势。新的按下覆盖旧状态前先以当前坐标释放旧按钮，避免异常中断后远端页面永久停留在按下状态。
      if (view.userPointer !== undefined) {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: view.userPointer.button, clickCount: view.userPointer.clickCount }).catch(() => {})
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button, clickCount })
      view.userPointer = { button, clickCount, streamGeneration: input.streamGeneration, viewportGeneration: input.viewportGeneration }
    } else if (input.action === 'mouse_move') {
      const pointer = view.userPointer
      if (pointer === undefined || pointer.streamGeneration !== input.streamGeneration || pointer.viewportGeneration !== input.viewportGeneration) {
        return { ok: false, action: 'user_input', viewId: view.viewId, data: asData({ code: 'POINTER_GESTURE_NOT_ACTIVE', recoverable: true, message: 'The pointer drag is no longer active. Press again before moving.' }) }
      }
      const buttons = pointer.button === 'left' ? 1 : pointer.button === 'right' ? 2 : 4
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: input.x, y: input.y, button: pointer.button, buttons })
    } else if (input.action === 'mouse_up') {
      const pointer = view.userPointer
      if (pointer === undefined || pointer.streamGeneration !== input.streamGeneration || pointer.viewportGeneration !== input.viewportGeneration) {
        return { ok: false, action: 'user_input', viewId: view.viewId, data: asData({ code: 'POINTER_GESTURE_NOT_ACTIVE', recoverable: true, message: 'The pointer drag is no longer active. Press again before releasing.' }) }
      }
      try {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: pointer.button, clickCount: pointer.clickCount })
      } finally {
        view.userPointer = undefined
      }
    } else if (input.action === 'mouse_wheel') {
      const deltaX = Math.min(Math.max(input.deltaX, -2000), 2000)
      const deltaY = Math.min(Math.max(input.deltaY, -2000), 2000)
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX, deltaY })
    } else if (input.action === 'key_press') {
      // Playwright使用“Control+Shift+A”形式表达组合键。修饰键由协议单独传入后在Host统一去重和排序；Ctrl+C/X继续由托管Chromium处理，Ctrl+V与Win+V由Client接收最终PasteEvent后走受限paste动作。
      const modifiers = [...new Set(input.modifiers ?? [])]
      const chord = [...modifiers, input.key].join('+')
      await view.page.keyboard.press(chord)
    } else if (input.action === 'insert_text') {
      await client.send('Input.insertText', { text: input.text })
    } else if (input.action === 'composition_commit') {
      // CDP 的 imeSetComposition 负责让远端 Chromium 产生真实 Composition 生命周期；随后先清空候选
      // 再用 insertText 提交最终正文。正文只在本次内存 RPC 中存在，返回值、Recorder 和 Input Trace
      // 仍只包含动作类型、字符类别与长度，不记录用户实际组合文本。
      const selection = [...input.text].length
      await client.send('Input.imeSetComposition', {
        text: input.text,
        selectionStart: selection,
        selectionEnd: selection,
      })
      await client.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      })
      await client.send('Input.insertText', { text: input.text })
    } else {
      const files = input.files ?? []
      const decodedFiles = files.map(file => ({ ...file, bytes: Buffer.from(file.data, 'base64') }))
      const textBytes = Buffer.byteLength(input.text ?? '') + Buffer.byteLength(input.html ?? '') + Buffer.byteLength(input.uriList ?? '')
      const fileBytes = decodedFiles.reduce((total, file) => total + file.bytes.byteLength, 0)
      if (decodedFiles.some(file => file.bytes.byteLength > 8 * 1024 * 1024) || textBytes + fileBytes > 16 * 1024 * 1024) {
        fail('CLIPBOARD_TOO_LARGE', 'clipboard paste exceeds the 8MB per-file or 16MB total limit')
      }
      const pasteResult = await view.page.evaluate(({ text, html, uriList, files }) => {
        const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
        const transfer = new DataTransfer()
        if (text !== undefined && text !== '') transfer.setData('text/plain', text)
        if (html !== undefined && html !== '') transfer.setData('text/html', html)
        if (uriList !== undefined && uriList !== '') transfer.setData('text/uri-list', uriList)
        for (const file of files) {
          const binary = atob(file.data)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          transfer.items.add(new File([bytes], file.name, { type: file.mediaType }))
        }
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer })
        target.dispatchEvent(event)
        return { handled: event.defaultPrevented, target: target.tagName.toLowerCase() }
      }, { text: input.text, html: input.html, uriList: input.uriList, files })
      if (!pasteResult.handled && input.text !== undefined && input.text !== '') await client.send('Input.insertText', { text: input.text })
      return { ok: true, action: 'user_input', viewId: view.viewId, data: asData({ action: input.action, formats: [input.text === undefined ? undefined : 'text/plain', input.html === undefined ? undefined : 'text/html', input.uriList === undefined ? undefined : 'text/uri-list'].filter(Boolean), files: files.length, bytes: textBytes + fileBytes, handled: pasteResult.handled, target: pasteResult.target }) }
    }
    return { ok: true, action: 'user_input', viewId: view.viewId, data: asData({ action: input.action }) }
  }

  private inputTraceAction(input: BrowserUserInput): InputTraceRecord['action'] {
    if (input.action === 'insert_text') return 'insert-text'
    if (input.action === 'composition_commit') return 'composition'
    if (input.action === 'paste') return 'paste'
    if (input.action === 'key_press') return input.composing ? 'composition' : 'key-press'
    if (input.action === 'mouse_wheel') return 'wheel'
    return 'pointer'
  }

  private async beginInputObservation(view: ViewState, inputTraceId: string): Promise<{
    sensitivity: ReturnType<typeof inputSensitivity>
    initialLength: number
  }> {
    const snapshot = await view.page.evaluate((traceId) => {
      const key = '__dshBrowserInputTraces'
      const root = globalThis as typeof globalThis & { [key: string]: Record<string, unknown> }
      const traces = root[key] as Record<string, { target: Element | null; initialLength: number; events: Array<{ type: string; composing: boolean; defaultPrevented: boolean; inputType: string; length: number }>; listeners: Array<[string, EventListener]> }> | undefined ?? {}
      root[key] = traces
      const target = document.activeElement
      const lengthOf = (element: Element | null) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.length
        if (element instanceof HTMLElement && element.isContentEditable) return (element.textContent ?? '').length
        return 0
      }
      const events: Array<{ type: string; composing: boolean; defaultPrevented: boolean; inputType: string; length: number }> = []
      const listeners: Array<[string, EventListener]> = []
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'change']) {
        const listener: EventListener = event => {
          const input = event as InputEvent
          queueMicrotask(() => events.push({
            type,
            composing: input.isComposing === true,
            defaultPrevented: event.defaultPrevented,
            inputType: typeof input.inputType === 'string' ? input.inputType.slice(0, 80) : '',
            length: lengthOf(event.target instanceof Element ? event.target : target),
          }))
        }
        document.addEventListener(type, listener, true)
        listeners.push([type, listener])
      }
      const initialLength = lengthOf(target)
      traces[traceId] = { target, initialLength, events, listeners }
      const element = target instanceof HTMLElement ? target : null
      return {
        inputType: element instanceof HTMLInputElement ? element.type : '',
        autocomplete: element?.getAttribute('autocomplete') ?? '',
        name: element?.getAttribute('name') ?? '',
        id: element?.id ?? '',
        ariaLabel: element?.getAttribute('aria-label') ?? '',
        initialLength,
      }
    }, inputTraceId)
    return { sensitivity: inputSensitivity(snapshot), initialLength: snapshot.initialLength }
  }

  private async finishInputObservation(view: ViewState, inputTraceId: string): Promise<{
    observed: boolean
    composing: boolean
    prevented: boolean
    beforeInputObserved: boolean
    compositionStarted: boolean
    compositionUpdated: boolean
    compositionEnded: boolean
    events: Array<{ type: string; composing: boolean; defaultPrevented: boolean; inputType: string; length: number }>
    targetReplaced: boolean
    focusLost: boolean
    initialLength: number
    finalLength: number
  }> {
    return view.page.evaluate((traceId) => {
      const key = '__dshBrowserInputTraces'
      const root = globalThis as typeof globalThis & { [key: string]: Record<string, unknown> }
      const traces = root[key] as Record<string, { target: Element | null; initialLength: number; events: Array<{ type: string; composing: boolean; defaultPrevented: boolean; inputType: string; length: number }>; listeners: Array<[string, EventListener]> }> | undefined
      const trace = traces?.[traceId]
      const lengthOf = (element: Element | null) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.length
        if (element instanceof HTMLElement && element.isContentEditable) return (element.textContent ?? '').length
        return 0
      }
      if (trace === undefined) return {
        observed: false,
        composing: false,
        prevented: false,
        beforeInputObserved: false,
        compositionStarted: false,
        compositionUpdated: false,
        compositionEnded: false,
        events: [],
        targetReplaced: false,
        focusLost: false,
        initialLength: 0,
        finalLength: 0,
      }
      for (const [type, listener] of trace.listeners) document.removeEventListener(type, listener, true)
      delete traces?.[traceId]
      const finalTarget = document.activeElement
      const targetReplaced = trace.target !== null && !trace.target.isConnected
      const focusLost = trace.target !== null && finalTarget !== trace.target
      return {
        observed: trace.events.length > 0,
        composing: trace.events.some(event => event.composing || event.type === 'compositionstart') && !trace.events.some(event => event.type === 'compositionend'),
        prevented: trace.events.some(event => event.type === 'beforeinput' && event.defaultPrevented),
        beforeInputObserved: trace.events.some(event => event.type === 'beforeinput'),
        compositionStarted: trace.events.some(event => event.type === 'compositionstart'),
        compositionUpdated: trace.events.some(event => event.type === 'compositionupdate'),
        compositionEnded: trace.events.some(event => event.type === 'compositionend'),
        events: trace.events.slice(0, 32),
        targetReplaced,
        focusLost,
        initialLength: trace.initialLength,
        finalLength: lengthOf(finalTarget),
      }
    }, inputTraceId)
  }

  private visualCaptureState(session: SessionState) {
    const states = [...session.views.values()].map(view => view.cdp).filter((state): state is NonNullable<ViewState['cdp']> => state !== undefined)
    return {
      activeViewCount: states.filter(state => state.screencastConsumers.size > 0).length,
      startedViewCount: states.filter(state => state.screencastStarted).length,
      liveViewConsumerCount: states.filter(state => state.screencastConsumers.has('live-view')).length,
      recorderConsumerCount: states.filter(state => state.screencastConsumers.has('recorder')).length,
    }
  }

  private async recorderAction(session: SessionState, input: BrowserRecorderInput): Promise<ToolOutput> {
    if (input.action === 'status') return { ok: true, action: 'recorder_status', viewId: session.activeViewId, data: asData({ ...this.recorder.status(session.sessionId, session.key), visualCapture: this.visualCaptureState(session) }) }
    if (input.action === 'start') {
      const mode = input.mode ?? 'rolling'
      const snapshot = this.recorder.setMode(session.sessionId, session.key, mode)
      await this.syncScreencasts(session)
      return { ok: true, action: 'recorder_start', viewId: session.activeViewId, data: asData(snapshot) }
    }
    if (input.action === 'pause') {
      const snapshot = this.recorder.pause(session.key)
      await this.syncScreencasts(session)
      return { ok: true, action: 'recorder_pause', viewId: session.activeViewId, data: asData(snapshot) }
    }
    if (input.action === 'resume') {
      const snapshot = this.recorder.resume(session.key)
      await this.syncScreencasts(session)
      return { ok: true, action: 'recorder_resume', viewId: session.activeViewId, data: asData(snapshot) }
    }
    if (input.action === 'clear') {
      this.recorder.clearSession(session.key, true)
      this.inputTraces.clearSession(session.key)
      return { ok: true, action: 'recorder_clear', viewId: session.activeViewId, data: asData(this.recorder.status(session.sessionId, session.key)) }
    }
    if (input.action === 'stop') {
      const snapshot = this.recorder.setMode(session.sessionId, session.key, 'off')
      await this.syncScreencasts(session)
      return { ok: true, action: 'recorder_stop', viewId: session.activeViewId, data: asData(snapshot) }
    }
    if (input.action === 'mark') {
      const incident = this.recorder.mark(session.key)
      return { ok: true, action: 'recorder_mark', viewId: session.activeViewId, data: asData({ incident, recorder: this.recorder.snapshot(session.key) }) }
    }
    if (input.action === 'complete') {
      if (input.incidentId === undefined || input.incidentId.trim() === '') fail('INVALID_ARGS', 'recorder complete requires incidentId')
      const incident = this.recorder.complete(session.key, input.incidentId)
      return { ok: true, action: 'recorder_complete', viewId: session.activeViewId, data: asData({ incident, recorder: this.recorder.snapshot(session.key) }) }
    }
    fail('INVALID_ARGS', `unknown browser recorder action ${JSON.stringify(input.action)}`)
  }

  private async ensureDebugger(session: SessionState, view: ViewState) {
    const state = await this.cdp(session, view)
    if (!state.debuggerEnabled) {
      const client = rawCdp(state.session)
      await client.send('Runtime.enable')
      await client.send('Debugger.enable')
      state.debuggerEnabled = true
    }
    return state
  }

  private async ensureScreencast(session: SessionState, view: ViewState, consumer: 'live-view' | 'recorder'): Promise<void> {
    const state = await this.cdp(session, view)
    state.screencastConsumers.add(consumer)
    if (state.screencastStarted) return
    const client = rawCdp(state.session)
    await client.send('Page.enable')
    // 静止页面通常只产生一张初始合成帧，因此CDP仍请求每一帧；事件接收层按30FPS时间预算保留有效帧，既不丢首帧，也避免高刷新动画页重复复制未展示JPEG。
    // 最大自适应Viewport允许到1920×1200；Screencast采用同一上限可避免独立浏览器把1280宽帧放大后文字发糊。JPEG 85在细字清晰度、双页帧体积和实时编码压力之间保持均衡。
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 })
    state.screencastStarted = true
  }

  private async releaseScreencast(view: ViewState, consumer: 'live-view' | 'recorder'): Promise<void> {
    const state = view.cdp
    if (state === undefined) return
    state.screencastConsumers.delete(consumer)
    if (!state.screencastStarted || state.screencastConsumers.size > 0) return
    // 物理Screencast由多个上层功能共享；只有最后一个消费者释放后才能停止，否则关闭面板会误停Deep Recorder，停止Recorder也会让仍打开的实况黑屏。
    await rawCdp(state.session).send('Page.stopScreencast').catch(() => {})
    state.screencastStarted = false
    state.latestFrame = undefined
  }

  private async restartScreencast(session: SessionState, view: ViewState): Promise<void> {
    const state = view.cdp
    if (state === undefined || !state.screencastStarted || state.screencastConsumers.size === 0) return
    // Viewport或自适应重排改变帧坐标代际时需要重启物理流，但消费者所有权保持不变，重启过程不能把任一功能从集合中移除。
    await rawCdp(state.session).send('Page.stopScreencast').catch(() => {})
    state.screencastStarted = false
    const consumer = state.screencastConsumers.values().next().value as 'live-view' | 'recorder'
    await this.ensureScreencast(session, view, consumer)
  }

  private async forceStopScreencast(view: ViewState): Promise<void> {
    const state = view.cdp
    if (state === undefined) return
    // View、CDP Session或Provider销毁属于终止边界；此时清空全部消费者，防止迁移后的旧View继续持有视觉采集所有权。
    state.screencastConsumers.clear()
    if (state.screencastStarted) await rawCdp(state.session).send('Page.stopScreencast').catch(() => {})
    state.screencastStarted = false
    state.latestFrame = undefined
  }

  private debuggerState(view: ViewState) {
    const state = view.cdp
    return {
      attached: state?.debuggerEnabled ?? false,
      paused: state?.paused ?? false,
      ...(state?.reason === undefined ? {} : { reason: state.reason }),
      callFrames: state?.callFrames ?? [],
      scripts: [...(state?.scripts.values() ?? [])].filter(item => item.url !== '').slice(-500),
      breakpoints: [...(state?.breakpoints.values() ?? [])],
    }
  }

  private async debuggerAction(session: SessionState, input: BrowserDebuggerInput, actor: 'model' | 'user' = 'model'): Promise<ToolOutput> {
    const view = this.view(session, input.viewId)
    if (actor === 'model' && /^(detach|pause|resume|step_over|step_into|step_out|set_breakpoint|remove_breakpoint)$/.test(input.action)) {
      const blocked = this.modelWriteBlocked(session, view, 'debugger')
      if (blocked !== undefined) return blocked
    }
    if (input.action === 'attach') {
      await this.ensureDebugger(session, view)
    } else if (input.action === 'detach') {
      const state = view.cdp
      if (state !== undefined) {
        state.contextAdapter?.dispose()
        this.contextIdentities.invalidateSession(session.key, session.contextGeneration)
        await this.forceStopScreencast(view)
        await rawCdp(state.session).detach().catch(() => {})
        view.cdp = undefined
        if (this.debugSessions.get(session.key)?.viewId === view.viewId) this.debugSessions.invalidate(session.key)
        view.viewport.generation += 1
        await this.syncScreencasts(session)
      }
    } else {
      const state = await this.ensureDebugger(session, view)
      const client = rawCdp(state.session)
      if (input.action === 'pause') await client.send('Debugger.pause')
      else if (/^(resume|step_over|step_into|step_out)$/.test(input.action) && !state.paused) {
        return { ok: false, action: 'debugger', viewId: view.viewId, data: asData({ code: 'DEBUGGER_NOT_PAUSED', recoverable: true, message: 'The page is not paused.', next: { tool: 'browser_debugger', arguments: { action: 'pause', viewId: view.viewId } } }) }
      } else if (input.action === 'resume') await client.send('Debugger.resume')
      else if (input.action === 'step_over') await client.send('Debugger.stepOver')
      else if (input.action === 'step_into') await client.send('Debugger.stepInto')
      else if (input.action === 'step_out') await client.send('Debugger.stepOut')
      else if (input.action === 'set_breakpoint') {
        if (input.url === undefined || input.lineNumber === undefined) fail('INVALID_ARGS', 'set_breakpoint requires url and lineNumber')
        const result = await client.send('Debugger.setBreakpointByUrl', { url: input.url, lineNumber: input.lineNumber, columnNumber: input.columnNumber ?? 0 })
        const breakpointId = string(result.breakpointId)
        state.breakpoints.set(breakpointId, { breakpointId, url: input.url, lineNumber: input.lineNumber, columnNumber: input.columnNumber ?? 0 })
      } else if (input.action === 'remove_breakpoint') {
        if (input.breakpointId === undefined) fail('INVALID_ARGS', 'remove_breakpoint requires breakpointId')
        await client.send('Debugger.removeBreakpoint', { breakpointId: input.breakpointId })
        state.breakpoints.delete(input.breakpointId)
      } else if (input.action === 'scope_variables') {
        if (input.callFrameId === undefined || input.scopeNumber === undefined) fail('INVALID_ARGS', 'scope_variables requires callFrameId and scopeNumber')
        const frame = state.callFrames.find(item => item.callFrameId === input.callFrameId)
        const objectId = frame?.scopes[input.scopeNumber]?.objectId
        if (objectId === undefined) return { ok: false, action: 'scope_variables', viewId: view.viewId, data: asData({ code: 'UNKNOWN_SCOPE', recoverable: true, message: 'The requested scope is no longer available.', next: { tool: 'browser_debugger', arguments: { action: 'call_frames', viewId: view.viewId } } }) }
        const result = await client.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true })
        const properties = (Array.isArray(result.result) ? result.result : []).map(value => {
          const property = record(value)
          const remote = record(property.value)
          const name = string(property.name)
          const sensitive = /token|secret|password|cookie|authorization/i.test(name)
          return { name, value: sensitive ? '[REDACTED]' : remote.value ?? remote.description ?? remote.type ?? null }
        })
        return { ok: true, action: 'scope_variables', viewId: view.viewId, data: asData({ properties }) }
      } else if (input.action === 'script_source' || input.action === 'source_map') {
        if (input.scriptId === undefined) fail('INVALID_ARGS', `${input.action} requires scriptId`)
        const script = state.scripts.get(input.scriptId)
        if (script === undefined) return { ok: false, action: 'script_source', viewId: view.viewId, data: asData({ code: 'UNKNOWN_SCRIPT', recoverable: true, message: 'The script is no longer available.', next: { tool: 'browser_debugger', arguments: { action: 'scripts', viewId: view.viewId } } }) }
        const result = await client.send('Debugger.getScriptSource', { scriptId: input.scriptId })
        const source = string(result.scriptSource)
        const sourceMapMatch = /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source)
        const sourceMapUrl = sourceMapMatch?.[1]
        if (input.action === 'source_map') {
          if (sourceMapUrl === undefined) return { ok: false, action: 'source_map', viewId: view.viewId, data: asData({ code: 'SOURCE_MAP_NOT_DECLARED', recoverable: false, message: 'The script does not declare sourceMappingURL.' }) }
          let data: Buffer
          let name = `source-map-${input.scriptId}.map`
          if (sourceMapUrl.startsWith('data:')) {
            const match = /^data:([^,]*?),(.*)$/s.exec(sourceMapUrl)
            if (match === null) fail('PROFILE_FAILED', 'source map data URL is invalid')
            data = /;base64(?:;|$)/i.test(match[1] ?? '') ? Buffer.from(match[2] ?? '', 'base64') : Buffer.from(decodeURIComponent(match[2] ?? ''))
          } else {
            if (script.url === '') fail('PROFILE_FAILED', 'relative source map cannot be resolved for an anonymous script')
            const url = assertUrlAllowed(this.config, new URL(sourceMapUrl, script.url).href)
            const response = await this.sessionContext(session).request.get(url.href, { failOnStatusCode: false })
            if (!response.ok()) fail('PROFILE_FAILED', `source map request failed with HTTP ${response.status()}`)
            data = await response.body()
            name = basename(url.pathname) || name
          }
          const artifact = await this.artifacts.save(session.key, 'source-map', name, data)
          state.profile.artifacts.push(artifact)
          let sourceMap: unknown
          try {
            sourceMap = JSON.parse(data.toString('utf8'))
          } catch {
            sourceMap = undefined
          }
          const resolvedSourceMapUrl = sourceMapUrl.startsWith('data:') ? `${script.url}#inline-source-map` : new URL(sourceMapUrl, script.url).href
          const build = this.builds.bindSource(session.key, input.scriptId, { source, sourceMapUrl: resolvedSourceMapUrl, ...(sourceMap === undefined ? {} : { sourceMap }) })
          const registered = this.builds.script(session.key, input.scriptId)
          Object.assign(script, {
            buildId: build.buildId,
            ...(registered?.scriptSha256 === undefined ? {} : { scriptSha256: registered.scriptSha256 }),
            ...(registered?.sourceMapSha256 === undefined ? {} : { sourceMapSha256: registered.sourceMapSha256 }),
          })
          return { ok: true, action: 'source_map', viewId: view.viewId, data: asData({ script, build, artifact }) }
        }
        const build = this.builds.bindSource(session.key, input.scriptId, { source, ...(sourceMapUrl === undefined ? {} : { sourceMapUrl: sourceMapUrl.startsWith('data:') ? `${script.url}#inline-source-map` : new URL(sourceMapUrl, script.url).href }) })
        const registered = this.builds.script(session.key, input.scriptId)
        Object.assign(script, { buildId: build.buildId, ...(registered?.scriptSha256 === undefined ? {} : { scriptSha256: registered.scriptSha256 }) })
        const sourceMapReference = sourceMapUrl === undefined
          ? {}
          : sourceMapUrl.startsWith('data:')
            ? { sourceMapUrl: '[INLINE_DATA_URL]' }
            : script.url === ''
              ? { sourceMapUrl: sourceMapUrl.slice(0, 500) }
              : { sourceMapUrl: redactUrl(new URL(sourceMapUrl, script.url).href) }
        if (Buffer.byteLength(source) > this.config.maxOutputChars) {
          const artifact = await this.artifacts.save(session.key, 'script-source', `script-${input.scriptId}.js`, source)
          state.profile.artifacts.push(artifact)
          return { ok: true, action: 'script_source', viewId: view.viewId, data: asData({ script, build, bytes: Buffer.byteLength(source), artifact, ...sourceMapReference }) }
        }
        return { ok: true, action: 'script_source', viewId: view.viewId, data: asData({ script, build, bytes: Buffer.byteLength(source), source, ...sourceMapReference }) }
      } else if (input.action !== 'call_frames' && input.action !== 'scripts') {
        fail('INVALID_ARGS', `unknown browser_debugger action ${JSON.stringify(input.action)}`)
      }
    }
    return { ok: true, action: 'debugger', viewId: view.viewId, data: asData(this.debuggerState(view)) }
  }

  private recordRequest(session: SessionState, view: ViewState, request: Request): void {
    const item = { method: request.method(), url: redactUrl(request.url()), type: request.resourceType(), time: Date.now() }
    view.network.push(item)
    this.legacyRequests.set(request, item)
    if (view.network.length > 300) view.network.splice(0, view.network.length - 300)
    let navigationId = view.navigationId
    if (request.isNavigationRequest() && request.frame() === view.page.mainFrame()) {
      if (request.redirectedFrom() === null || view.pendingNavigationId === undefined) {
        view.navigationGeneration += 1
        view.pendingNavigationId = `${view.viewId}-n${view.navigationGeneration}`
      }
      navigationId = view.pendingNavigationId
    }
    const frameIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.contextForFrame(request.frame()) : {}
    if (view.cdp?.contextAdapter?.isEnabled()) view.cdp.contextAdapter.registerResource(request.url(), frameIdentity)
    this.journal.startNetwork({
      sessionId: session.sessionId,
      sessionKey: session.key,
      viewId: view.viewId,
      contextGeneration: session.contextGeneration,
      documentGeneration: view.documentGeneration,
      navigationId,
      ...frameIdentity,
      request,
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      ...(request.redirectedFrom() === null ? {} : { redirectFrom: request.redirectedFrom() as Request }),
    })
  }

  private async inspectElement(view: ViewState, ref: string): Promise<ElementEvidence> {
    const handle = this.ref(view, ref)
    const ownerFrame = await handle.ownerFrame().catch(() => null)
    const frameIdentity = ownerFrame === null || view.cdp?.contextAdapter?.isEnabled() !== true ? {} : view.cdp.contextAdapter.contextForFrame(ownerFrame)
    const connected = await handle.evaluate(node => node.isConnected).catch(() => false)
    if (!connected) fail('STALE_REF', `browser ref ${JSON.stringify(ref)} is detached; take a new snapshot or query`)
    const evidence = await handle.evaluate((node) => {
      if (!(node instanceof Element)) throw new Error('browser diagnose inspect requires an Element ref')
      const summarize = (element: Element) => {
        const elementRect = element.getBoundingClientRect()
        const elementStyle = getComputedStyle(element)
        const className = typeof element.className === 'string' ? element.className : element.getAttribute('class') ?? ''
        return {
          tag: element.tagName.toLowerCase(),
          ...(element.id === '' ? {} : { id: element.id.slice(0, 120) }),
          ...(className === '' ? {} : { className: className.slice(0, 200) }),
          ...(element.getAttribute('role') === null ? {} : { role: element.getAttribute('role')?.slice(0, 80) }),
          ...((element.getAttribute('aria-label') || element.getAttribute('title') || '').trim() === ''
            ? {}
            : { accessibleName: (element.getAttribute('aria-label') || element.getAttribute('title') || '').trim().slice(0, 200) }),
          box: { x: elementRect.x, y: elementRect.y, width: elementRect.width, height: elementRect.height },
          styles: {
            display: elementStyle.display,
            visibility: elementStyle.visibility,
            opacity: elementStyle.opacity,
            pointerEvents: elementStyle.pointerEvents,
            position: elementStyle.position,
            zIndex: elementStyle.zIndex,
          },
        }
      }
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const clippingAncestors = []
      const stackingContexts = []
      let ancestor = node.parentElement
      while (ancestor !== null && (clippingAncestors.length < 8 || stackingContexts.length < 8)) {
        const ancestorStyle = getComputedStyle(ancestor)
        if (clippingAncestors.length < 8 && /hidden|clip|scroll|auto/.test(`${ancestorStyle.overflowX} ${ancestorStyle.overflowY}`)) {
          const ancestorRect = ancestor.getBoundingClientRect()
          clippingAncestors.push({
            tag: ancestor.tagName.toLowerCase(),
            ...(ancestor.id === '' ? {} : { id: ancestor.id.slice(0, 120) }),
            ...(typeof ancestor.className !== 'string' || ancestor.className === '' ? {} : { className: ancestor.className.slice(0, 200) }),
            overflowX: ancestorStyle.overflowX,
            overflowY: ancestorStyle.overflowY,
            box: { x: ancestorRect.x, y: ancestorRect.y, width: ancestorRect.width, height: ancestorRect.height },
          })
        }
        if (stackingContexts.length < 8 && ((ancestorStyle.position !== 'static' && ancestorStyle.zIndex !== 'auto')
          || ancestorStyle.transform !== 'none'
          || ancestorStyle.filter !== 'none'
          || ancestorStyle.isolation === 'isolate'
          || Number(ancestorStyle.opacity) < 1)) {
          stackingContexts.push(summarize(ancestor))
        }
        ancestor = ancestor.parentElement
      }
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      const centerInsideViewport = center.x >= 0 && center.y >= 0 && center.x < innerWidth && center.y < innerHeight
      const topNode = centerInsideViewport ? document.elementFromPoint(center.x, center.y) : null
      const topElement = topNode instanceof Element ? topNode : null
      const nodeRoot = node.getRootNode()
      const retargetedHost = nodeRoot instanceof ShadowRoot ? nodeRoot.host : null
      const targetMatches = topElement !== null && (topElement === node || node.contains(topElement) || topElement === retargetedHost)
      const occlusionChain = []
      let occluder = targetMatches ? null : topElement
      while (occluder !== null && occlusionChain.length < 8) {
        occlusionChain.push(summarize(occluder))
        occluder = occluder.parentElement
      }
      const selectorHints = []
      if (node.id !== '') selectorHints.push(`#${CSS.escape(node.id)}`)
      for (const attribute of ['data-testid', 'data-test', 'data-qa']) {
        const value = node.getAttribute(attribute)
        if (value !== null && value !== '') selectorHints.push(`[${attribute}=${JSON.stringify(value.slice(0, 120))}]`)
      }
      const role = node.getAttribute('role')
      const accessibleName = (node.getAttribute('aria-label') || node.getAttribute('title') || (node instanceof HTMLInputElement ? node.placeholder : '') || '').trim().slice(0, 200)
      if (role !== null && role !== '') selectorHints.push(`[role=${JSON.stringify(role.slice(0, 80))}]`)
      if (accessibleName !== '') selectorHints.push(`[aria-label=${JSON.stringify(accessibleName)}]`)
      if (selectorHints.length === 0) selectorHints.push(node.tagName.toLowerCase())
      const canvas = node instanceof HTMLCanvasElement
        ? {
            cssWidth: rect.width,
            cssHeight: rect.height,
            backingWidth: node.width,
            backingHeight: node.height,
            deviceScaleFactor: devicePixelRatio,
            backingScaleX: rect.width === 0 ? null : node.width / rect.width,
            backingScaleY: rect.height === 0 ? null : node.height / rect.height,
            centerLocalPoint: { x: center.x - rect.left, y: center.y - rect.top },
          }
        : undefined
      const matrix = (value: DOMMatrix | SVGMatrix | null) => value === null ? undefined : { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f }
      const rootGenerationsKey = '__dshShadowRootGenerations'
      const rootCounterKey = '__dshShadowRootCounter'
      const globals = globalThis as typeof globalThis & { [key: string]: unknown }
      const rootGenerations = globals[rootGenerationsKey] instanceof WeakMap
        ? globals[rootGenerationsKey] as WeakMap<ShadowRoot, number>
        : new WeakMap<ShadowRoot, number>()
      globals[rootGenerationsKey] = rootGenerations
      let rootCounter = typeof globals[rootCounterKey] === 'number' ? globals[rootCounterKey] as number : 0
      const shadowHosts: Array<{ tag: string; id?: string }> = []
      const slotPath: Array<{ name: string; assigned: boolean }> = []
      const composedTreePath: string[] = []
      const maxShadowDepth = 8
      let shadowDepth = 0
      let rootGeneration = 0
      let current: Node | null = node
      while (current !== null && shadowDepth < maxShadowDepth) {
        if (current instanceof Element) {
          composedTreePath.push(current.tagName.toLowerCase())
          if (current.assignedSlot !== null) slotPath.push({ name: current.assignedSlot.name, assigned: true })
        }
        const root = current.getRootNode()
        if (!(root instanceof ShadowRoot)) break
        shadowDepth += 1
        let generation = rootGenerations.get(root)
        if (generation === undefined) {
          generation = ++rootCounter
          rootGenerations.set(root, generation)
        }
        rootGeneration = generation
        shadowHosts.push({ tag: root.host.tagName.toLowerCase(), ...(root.host.id === '' ? {} : { id: root.host.id.slice(0, 120) }) })
        current = root.host
      }
      const shadowTruncated = current !== null && current.getRootNode() instanceof ShadowRoot
      globals[rootCounterKey] = rootCounter
      const ownerSvg = node instanceof SVGElement ? node.ownerSVGElement ?? (node instanceof SVGSVGElement ? node : null) : null
      const ownerViewBox = ownerSvg?.viewBox?.baseVal
      const svgSurface = node instanceof SVGGraphicsElement
        ? {
            rendererType: 'svg' as const,
            tag: node.tagName.toLowerCase(),
            localBBox: (() => { try { const box = node.getBBox(); return { x: box.x, y: box.y, width: box.width, height: box.height } } catch { return undefined } })(),
            clientRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ...(matrix(node.getCTM()) === undefined ? {} : { ctm: matrix(node.getCTM()) }),
            ...(matrix(node.getScreenCTM()) === undefined ? {} : { screenCtm: matrix(node.getScreenCTM()) }),
            ...(ownerViewBox === undefined ? {} : { viewBox: { x: ownerViewBox.x, y: ownerViewBox.y, width: ownerViewBox.width, height: ownerViewBox.height } }),
            ...(ownerSvg?.preserveAspectRatio?.baseVal === undefined ? {} : { preserveAspectRatio: ownerSvg.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet' }),
            fill: style.fill,
            stroke: style.stroke,
            pointerEvents: style.pointerEvents,
            ...(style.clipPath === 'none' ? {} : { clipPath: style.clipPath }),
            ...(style.mask === 'none' ? {} : { mask: style.mask }),
            ...(style.filter === 'none' ? {} : { filter: style.filter }),
            pointerHit: targetMatches,
          }
        : undefined
      const canvasSurface = node instanceof HTMLCanvasElement
        ? {
            rendererType: 'canvas' as const,
            capabilityLevel: 'surface-only' as const,
            contextType: (node.getContext('2d') !== null ? '2d' : 'unknown') as '2d' | 'unknown',
            cssWidth: rect.width,
            cssHeight: rect.height,
            backingWidth: node.width,
            backingHeight: node.height,
            deviceScaleFactor: devicePixelRatio,
            backingScaleX: rect.width === 0 ? null : node.width / rect.width,
            backingScaleY: rect.height === 0 ? null : node.height / rect.height,
            coordinate: {
              viewportPoint: center,
              canvasCssPoint: { x: center.x - rect.left, y: center.y - rect.top },
              canvasBackingPoint: {
                x: rect.width === 0 ? 0 : (center.x - rect.left) * node.width / rect.width,
                y: rect.height === 0 ? 0 : (center.y - rect.top) * node.height / rect.height,
              },
              inBounds: center.x >= rect.left && center.x < rect.right && center.y >= rect.top && center.y < rect.bottom,
            },
          }
        : undefined
      const shadowSurface = shadowDepth > 0
        ? {
            rendererType: 'shadow-dom' as const,
            rootType: 'open' as const,
            capability: 'open-inspectable' as const,
            depth: shadowDepth,
            maxDepth: maxShadowDepth,
            truncated: shadowTruncated,
            ...(shadowTruncated ? { degradationReason: 'max-shadow-depth-exceeded' as const } : {}),
            rootGeneration,
            shadowHosts,
            slotPath,
            composedTreePath,
            ...(topElement === null ? {} : { retargetedTarget: { tag: topElement.tagName.toLowerCase(), ...(topElement.id === '' ? {} : { id: topElement.id.slice(0, 120) }) } }),
            shadowTargetMatches: targetMatches,
          }
        : undefined
      const shadowHostModes = globals.__dshShadowHostModes instanceof WeakMap ? globals.__dshShadowHostModes as WeakMap<Element, ShadowRootMode> : undefined
      const shadowHostMode = shadowHostModes?.get(node)
      const shadowHostSurface = shadowSurface === undefined && shadowHostMode !== undefined
        ? {
            rendererType: 'shadow-dom' as const,
            rootType: shadowHostMode,
            capability: shadowHostMode === 'open' ? 'open-inspectable' as const : 'host-only' as const,
            depth: 0,
            maxDepth: maxShadowDepth,
            truncated: false,
            rootGeneration: 0,
            shadowHosts: [{ tag: node.tagName.toLowerCase(), ...(node.id === '' ? {} : { id: node.id.slice(0, 120) }) }],
            slotPath: [],
            composedTreePath: [node.tagName.toLowerCase()],
            ...(topElement === null ? {} : { retargetedTarget: { tag: topElement.tagName.toLowerCase(), ...(topElement.id === '' ? {} : { id: topElement.id.slice(0, 120) }) } }),
            shadowTargetMatches: targetMatches,
          }
        : undefined
      const surface = shadowSurface ?? shadowHostSurface ?? svgSurface ?? canvasSurface ?? { rendererType: 'html' as const }
      let portalRoot: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
      while (portalRoot !== null && !['fixed', 'absolute'].includes(getComputedStyle(portalRoot).position)) {
        portalRoot = portalRoot.parentElement
      }
      const portal = portalRoot === null
        ? undefined
        : {
            candidate: true,
            root: summarize(portalRoot),
            overflow: {
              top: Math.max(0, -rect.top),
              right: Math.max(0, rect.right - innerWidth),
              bottom: Math.max(0, rect.bottom - innerHeight),
              left: Math.max(0, -rect.left),
            },
          }
      return {
        identityBase: {
          tag: node.tagName.toLowerCase(),
          ...(role === null || role === '' ? {} : { role: role.slice(0, 80) }),
          ...(accessibleName === '' ? {} : { accessibleName }),
          selectorHints: selectorHints.slice(0, 5),
        },
        textFingerprintSource: (node.textContent || '').trim().slice(0, 500),
        visible,
        viewportIntersection: visible && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          position: style.position,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          width: style.width,
          zIndex: style.zIndex,
          transform: style.transform,
          filter: style.filter,
          isolation: style.isolation,
        },
        clippingAncestors,
        stackingContexts,
        hitTest: {
          point: center,
          topElement: topElement === null ? null : summarize(topElement),
          targetMatches,
          occlusionChain,
        },
        ...(canvas === undefined ? {} : { canvas }),
        ...(portal === undefined ? {} : { portal }),
        surface,
      }
    })
    const { identityBase, textFingerprintSource, ...details } = evidence
    const textFingerprint = textFingerprintSource === ''
      ? undefined
      : createHash('sha256').update(textFingerprintSource).digest('hex').slice(0, 20)
    return {
      ref,
      identity: {
        resolution: 'resolved-by-ref',
        ref,
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...frameIdentity,
        ...identityBase,
        ...(textFingerprint === undefined ? {} : { textFingerprint }),
      },
      ...details,
    }
  }

  private async refreshApplications(session: SessionState, view: ViewState): Promise<ApplicationIdentity[]> {
    const contextTopology = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.snapshot() : undefined
    const mainFrame = contextTopology?.frames.find(frame => frame.mainFrame && frame.viewId === view.viewId)
    const shell = this.applications.upsert(session.key, {
      viewId: view.viewId,
      kind: 'shell',
      name: await view.page.title().catch(() => 'Shell') || 'Shell',
      origin: (() => { try { return new URL(view.page.url()).origin } catch { return undefined } })(),
      ...(mainFrame?.frameId === undefined ? {} : { frameId: mainFrame.frameId }),
      signals: ['confirmed-main-frame', 'active-browser-view'],
      counterEvidence: [],
      confidence: mainFrame === undefined ? 'candidate' : 'confirmed',
    })
    const buildTopology = this.builds.snapshot(session.key)
    for (const build of buildTopology.builds.filter(build => build.active && (mainFrame?.frameId === undefined || build.frameId === mainFrame.frameId))) this.applications.bindBuild(session.key, shell.applicationId, build.buildId)
    for (const frame of contextTopology?.frames.filter(frame => frame.viewId === view.viewId && !frame.mainFrame && frame.attached) ?? []) {
      const target = contextTopology?.targets.find(target => target.targetId === frame.targetId)
      const application = this.applications.upsert(session.key, {
        viewId: view.viewId,
        kind: frame.oopif ? 'iframe' : 'iframe',
        name: frame.name || (() => { try { return new URL(frame.url).hostname } catch { return 'iframe application' } })(),
        origin: frame.origin,
        frameId: frame.frameId,
        signals: [frame.oopif ? 'confirmed-oopif-frame' : 'confirmed-frame', target === undefined ? 'target-unavailable' : 'target-associated'],
        counterEvidence: target === undefined ? ['Target identity is unavailable.'] : [],
        confidence: frame.confidence,
      })
      for (const build of buildTopology.builds.filter(build => build.active && build.frameId === frame.frameId)) this.applications.bindBuild(session.key, application.applicationId, build.buildId)
    }
    const roots = await view.page.locator('[data-dsh-application]').evaluateAll(elements => elements.slice(0, 24).map((element, index) => {
      const name = element.getAttribute('data-dsh-application')?.trim() || `application-${index + 1}`
      const kind = element.getAttribute('data-dsh-application-kind')
      const remoteEntry = element.getAttribute('data-remote-entry')
      const selector = element.id !== '' ? `#${CSS.escape(element.id)}` : `[data-dsh-application=${JSON.stringify(name)}]`
      return { name, kind, remoteEntry, selector }
    }))
    for (const root of roots) {
      const moduleFederation = root.kind === 'module-federation'
      this.applications.upsert(session.key, {
        viewId: view.viewId,
        kind: moduleFederation ? 'module-federation' : 'root',
        name: root.name,
        rootSelector: root.selector,
        signals: ['explicit-application-root', ...(root.remoteEntry === null ? [] : ['explicit-remote-entry'])],
        counterEvidence: moduleFederation && root.remoteEntry === null ? ['Module Federation kind is declared without a remoteEntry signal.'] : [],
        confidence: moduleFederation && root.remoteEntry === null ? 'candidate' : 'confirmed',
      })
    }
    return this.applications.snapshot(session.key).applications
  }

  private async elementApplication(session: SessionState, view: ViewState, ref: string): Promise<ElementEvidence['application']> {
    const applications = await this.refreshApplications(session, view)
    const handle = this.ref(view, ref)
    const selector = await handle.evaluate(node => {
      if (!(node instanceof Element)) return undefined
      let current: Element | null = node
      while (current !== null) {
        const root = current.closest('[data-dsh-application]')
        if (root !== null) {
          const name = root.getAttribute('data-dsh-application')?.trim()
          if (name === undefined || name === '') return undefined
          return root.id !== '' ? `#${CSS.escape(root.id)}` : `[data-dsh-application=${JSON.stringify(name)}]`
        }
        const tree = current.getRootNode()
        current = tree instanceof ShadowRoot ? tree.host : null
      }
      return undefined
    })
    const application = selector === undefined
      ? applications.find(value => value.kind === 'shell' && value.active)
      : applications.find(value => value.rootSelector === selector && value.active)
    return application === undefined ? undefined : { applicationId: application.applicationId, kind: application.kind, name: application.name, confidence: application.confidence }
  }

  private debugSessionView(session: SessionState, input: BrowserDiagnoseInput): { record: ReturnType<DebugSessionStore['require']>; view: ViewState } {
    const debugSession = this.debugSessions.get(session.key)
    if (debugSession === undefined) fail('INVALID_ARGS', 'browser diagnose session is not active; call browser_diagnose with action start')
    if (debugSession.contextGeneration !== session.contextGeneration) {
      this.debugSessions.invalidate(session.key)
      fail('INVALID_ARGS', 'browser diagnose session became stale after the browser context changed; start a new diagnose session')
    }
    const requestedViewId = input.viewId?.trim()
    if (requestedViewId !== undefined && requestedViewId !== '' && requestedViewId !== debugSession.viewId) {
      fail('INVALID_ARGS', `browser diagnose session is bound to view ${debugSession.viewId}`)
    }
    const view = session.views.get(debugSession.viewId)
    if (view === undefined || view.page.isClosed()) {
      this.debugSessions.invalidate(session.key)
      fail('UNKNOWN_VIEW', 'browser diagnose target view is no longer available; start a new diagnose session')
    }
    return { record: debugSession, view }
  }

  private checkpointCursor(sessionKey: string): number {
    const checkpoints = this.debugSessions.checkpoints(sessionKey)
    return checkpoints.at(-1)?.cursor.sequence ?? this.debugSessions.require(sessionKey).startedCursor.sequence
  }

  private diagnosticContext(session: SessionState, view: ViewState, debugSession: ReturnType<DebugSessionStore['require']>) {
    const contextIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.mainContext() : {}
    return {
      schemaVersion: 2 as const,
      debugSessionId: debugSession.debugSessionId,
      dshSessionId: debugSession.dshSessionId,
      viewId: view.viewId,
      contextGeneration: session.contextGeneration,
      documentGeneration: view.documentGeneration,
      navigationId: view.navigationId,
      ...contextIdentity,
      status: debugSession.status,
    }
  }

  private panelDiagnosticSnapshot(session: SessionState, view: ViewState): BrowserDiagnosticPanelSnapshot {
    // 面板快照在实况页最快约每33毫秒调用一次，因此这里只允许读取有界Journal、Debug Session Store和工具调用完成时写入的摘要缓存。严禁在此重新执行页面Evaluate、截图、Source Map下载或Incident构建，否则普通观察动作会隐式获得新权限，并把高频轮询放大为持续取证开销。
    const debugSession = this.debugSessions.get(session.key)
    const events = this.journal.events(session.key, 0, view.viewId)
    const currentEvents = events.filter(event => event.contextGeneration === session.contextGeneration
      && event.documentGeneration === view.documentGeneration
      && event.navigationId === view.navigationId)
    const abnormalEvents = currentEvents.filter(event => event.kind === 'console'
      ? event.severity === 'error'
      : event.kind === 'network' && (event.failure !== undefined || (event.status !== undefined && event.status >= 400)))
    const readSequence = session.diagnosticPanel.readSequences.get(view.viewId) ?? 0
    const unreadEvents = abnormalEvents.filter(event => event.sequence > readSequence)
    const unreadConsoleErrors = unreadEvents.filter(event => event.kind === 'console').length
    const unreadFailedRequests = unreadEvents.filter(event => event.kind === 'network').length
    const reasons: string[] = []
    if (debugSession !== undefined) {
      if (debugSession.viewId !== view.viewId) reasons.push('viewId differs')
      if (debugSession.contextGeneration !== session.contextGeneration) reasons.push('contextGeneration differs')
      if (debugSession.documentGeneration !== view.documentGeneration) reasons.push('documentGeneration differs')
      if (debugSession.navigationId !== view.navigationId) reasons.push('navigationId differs')
    }
    const checkpoints = debugSession === undefined ? [] : [...debugSession.checkpoints.values()]
    const currentCheckpoint = checkpoints.at(-1)
    const timeline = events.filter(event => event.kind === 'action').slice(-8).map(event => ({
      actionId: event.actionId,
      toolName: event.toolName,
      humanInitiated: event.humanInitiated,
      outcome: event.outcome,
      wallTime: event.wallTime,
      documentGeneration: event.documentGeneration,
      navigationId: event.navigationId,
      relatedEvidenceCount: event.relatedEventIds.length,
    }))
    const contextTopology = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.snapshot() : undefined
    const mainIdentity = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.mainContext() : {}
    const recorder = this.recorder.status(session.sessionId, session.key)
    const buildTopology = this.builds.snapshot(session.key, 16)
    const applicationTopology = this.applications.snapshot(session.key, 16)
    return {
      schemaVersion: 2,
      active: debugSession !== undefined,
      recording: debugSession?.status === 'active',
      currentIdentity: {
        viewId: view.viewId,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...mainIdentity,
        viewport: {
          width: view.viewport.width,
          height: view.viewport.height,
          deviceScaleFactor: view.viewport.deviceScaleFactor,
          mobile: view.viewport.mobile,
          generation: view.viewport.generation,
        },
      },
      ...(contextTopology === undefined ? {} : {
        contextTopology: {
          contextTopologySchemaVersion: contextTopology.contextTopologySchemaVersion,
          targetCount: contextTopology.targets.length,
          frameCount: contextTopology.frames.length,
          executionContextCount: contextTopology.executionContexts.length,
          degradationCount: contextTopology.degradations.length,
          ...(contextTopology.frames.find(frame => frame.mainFrame)?.frameId === undefined ? {} : { mainFrameId: contextTopology.frames.find(frame => frame.mainFrame)?.frameId }),
          truncated: Object.values(contextTopology.truncated).some(Boolean),
        },
      }),
      recorder: {
        recorderSchemaVersion: recorder.recorderSchemaVersion,
        mode: recorder.mode,
        status: recorder.status,
        retentionMs: recorder.retentionMs,
        eventCount: recorder.eventCount,
        chunkCount: recorder.chunkCount,
        byteSize: recorder.byteSize,
        frozenIncidentIds: recorder.frozenIncidentIds,
        overload: recorder.overload,
        deepVisible: recorder.mode === 'deep' && recorder.status === 'recording',
        visualCapture: this.visualCaptureState(session),
      },
      buildTopology: {
        buildCount: buildTopology.builds.length,
        activeBuildCount: buildTopology.builds.filter(build => build.active).length,
        scriptCount: buildTopology.scripts.length,
        truncated: buildTopology.truncated,
      },
      applicationTopology: {
        applicationCount: applicationTopology.applications.length,
        activeApplicationCount: applicationTopology.applications.filter(application => application.active).length,
        confirmedApplicationCount: applicationTopology.applications.filter(application => application.active && application.confidence === 'confirmed').length,
        truncated: applicationTopology.truncated,
      },
      ...(debugSession === undefined ? {} : {
        debugSession: {
          debugSessionId: debugSession.debugSessionId,
          status: debugSession.status,
          startedAt: debugSession.startedAt,
          checkpointCount: checkpoints.length,
          checkpoints: checkpoints.slice(-6).map(checkpoint => ({
            checkpointId: checkpoint.checkpointId,
            label: checkpoint.label,
            createdAt: checkpoint.createdAt,
            viewId: checkpoint.viewId,
            documentGeneration: checkpoint.documentGeneration,
            navigationId: checkpoint.navigationId,
          })),
          ...(currentCheckpoint === undefined ? {} : { currentCheckpoint: { checkpointId: currentCheckpoint.checkpointId, label: currentCheckpoint.label, createdAt: currentCheckpoint.createdAt } }),
        },
      }),
      synchronization: {
        status: debugSession === undefined ? 'no-debug-session' : reasons.length === 0 ? 'same-view' : 'mismatch',
        reasons,
      },
      unread: {
        consoleErrors: unreadConsoleErrors,
        failedRequests: unreadFailedRequests,
        total: unreadConsoleErrors + unreadFailedRequests,
        latestSequence: abnormalEvents.at(-1)?.sequence ?? 0,
      },
      timeline,
      ...(
        session.diagnosticPanel.latestInspect === undefined
        || session.diagnosticPanel.latestInspect.viewId !== view.viewId
        || session.diagnosticPanel.latestInspect.documentGeneration !== view.documentGeneration
        || session.diagnosticPanel.latestInspect.navigationId !== view.navigationId
          ? {}
          : { latestInspect: session.diagnosticPanel.latestInspect }
      ),
      ...(session.diagnosticPanel.latestComparison === undefined ? {} : { latestComparison: session.diagnosticPanel.latestComparison }),
      ...(session.diagnosticPanel.latestIncident === undefined ? {} : { latestIncident: session.diagnosticPanel.latestIncident }),
      ...(
        session.diagnosticPanel.takeover === undefined && session.diagnosticPanel.latestTakeoverSummary === undefined
          ? {}
          : {
              takeover: {
                active: session.diagnosticPanel.takeover !== undefined,
                ...(session.diagnosticPanel.takeover === undefined ? {} : { startedAt: session.diagnosticPanel.takeover.startedAt }),
                ...(session.diagnosticPanel.latestTakeoverSummary === undefined ? {} : { latestSummary: session.diagnosticPanel.latestTakeoverSummary }),
              },
            }
      ),
    }
  }

  private finishPanelTakeover(session: SessionState, view: ViewState): void {
    const takeover = session.diagnosticPanel.takeover
    if (takeover === undefined) return
    const events = this.journal.events(session.key, takeover.startedSequence, takeover.viewId)
    const actions = events.filter(event => event.kind === 'action' && event.humanInitiated)
    session.diagnosticPanel.latestTakeoverSummary = {
      startedAt: takeover.startedAt,
      finishedAt: Date.now(),
      actionCount: actions.length,
      documentChanged: takeover.documentGeneration !== view.documentGeneration,
      navigationChanged: takeover.navigationId !== view.navigationId,
      newConsoleErrors: events.filter(event => event.kind === 'console' && event.severity === 'error').length,
      newFailedRequests: events.filter(event => event.kind === 'network' && (event.failure !== undefined || (event.status !== undefined && event.status >= 400))).length,
    }
    session.diagnosticPanel.takeover = undefined
  }

  private diagnosticRange(session: SessionState, view: ViewState, input: BrowserDiagnoseInput, defaultAfterSequence: number) {
    const starts = [
      input.sinceCursor === undefined ? undefined : 'cursor',
      input.sinceCheckpointId?.trim() ? 'checkpoint' : undefined,
      input.sinceActionId?.trim() ? 'action' : undefined,
    ].filter((value): value is string => value !== undefined)
    if (starts.length > 1) fail('INVALID_ARGS', 'browser_diagnose accepts only one of sinceCursor, sinceCheckpointId, or sinceActionId')
    let afterSequence = defaultAfterSequence
    let source: 'default' | 'cursor' | 'checkpoint' | 'action' = 'default'
    if (input.sinceCursor !== undefined) {
      if (!Number.isInteger(input.sinceCursor) || input.sinceCursor < 0) fail('INVALID_ARGS', 'browser_diagnose sinceCursor must be a non-negative integer')
      afterSequence = input.sinceCursor
      source = 'cursor'
    } else if (input.sinceCheckpointId?.trim()) {
      const checkpoint = this.debugSessions.checkpointById(session.key, input.sinceCheckpointId.trim())
      if (checkpoint === undefined) fail('INVALID_ARGS', 'browser_diagnose sinceCheckpointId does not exist in the current diagnose session')
      afterSequence = checkpoint.cursor.sequence
      source = 'checkpoint'
    } else if (input.sinceActionId?.trim()) {
      const action = this.journal.action(session.key, input.sinceActionId.trim())
      if (action === undefined || action.viewId !== view.viewId) fail('INVALID_ARGS', 'browser_diagnose sinceActionId does not exist for the current diagnose view')
      const relatedSequences = action.relatedEventIds.map(eventId => this.journal.event(session.key, eventId)?.sequence).filter((sequence): sequence is number => sequence !== undefined)
      afterSequence = Math.max(0, Math.min(action.sequence, ...relatedSequences) - 1)
      source = 'action'
    }
    let untilSequence: number | undefined
    const untilActionId = input.untilActionId?.trim()
    if (untilActionId !== undefined && untilActionId !== '') {
      const action = this.journal.action(session.key, untilActionId)
      if (action === undefined || action.viewId !== view.viewId) fail('INVALID_ARGS', 'browser_diagnose untilActionId does not exist for the current diagnose view')
      untilSequence = action.sequence
      if (untilSequence <= afterSequence) fail('INVALID_ARGS', 'browser_diagnose untilActionId must be after the selected range start')
    }
    const events = this.journal.events(session.key, afterSequence, view.viewId).filter(event => {
      return event.kind !== 'script'
        && event.contextGeneration === session.contextGeneration
        && (untilSequence === undefined || event.sequence <= untilSequence)
    })
    return {
      events,
      range: {
        schemaVersion: 2 as const,
        source,
        afterSequence,
        ...(untilSequence === undefined ? {} : { untilSequence }),
        nextCursor: this.journal.cursor(session.key),
      },
    }
  }

  private async diagnosticScreenshot(view: ViewState) {
    // Diagnostic Checkpoint会进入Incident Artifact链，因此截图必须在浏览器合成阶段遮住所有可输入正文和安全挑战区域；这里只构造Locator，不读取value、文本或剪贴板内容。
    const sensitive = view.page.locator([
      'input',
      'textarea',
      '[contenteditable]:not([contenteditable="false"])',
      '[data-dsh-sensitive]',
      '[autocomplete*="password" i]',
      '[autocomplete*="one-time-code" i]',
      '[name*="password" i]',
      '[name*="otp" i]',
      '[name*="verification" i]',
      '[name*="captcha" i]',
      '[name*="card" i]',
      '[id*="password" i]',
      '[id*="otp" i]',
      '[id*="verification" i]',
      '[id*="captcha" i]',
      '[id*="card" i]',
      '[aria-label*="password" i]',
      '[aria-label*="otp" i]',
      '[aria-label*="verification" i]',
      '[aria-label*="captcha" i]',
      '[aria-label*="security challenge" i]',
      '[aria-label*="card" i]',
    ].join(','))
    return view.page.screenshot({
      type: 'png',
      fullPage: false,
      mask: [sensitive],
      maskColor: '#5b21b6',
    })
  }

  private async diagnosticCheckpoint(session: SessionState, input: BrowserDiagnoseInput): Promise<DiagnosticCheckpoint> {
    const { view } = this.debugSessionView(session, input)
    const ref = input.ref?.trim()
    const element = ref === undefined || ref === '' ? undefined : await this.inspectElement(view, ref)
    if (element !== undefined && ref !== undefined && ref !== '') {
      const application = await this.elementApplication(session, view, ref)
      if (application !== undefined) element.application = application
    }
    const cursor = this.journal.cursor(session.key)
    const { events, range } = this.diagnosticRange(session, view, input, this.checkpointCursor(session.key))
    const rootScrollWidth = await view.page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, innerWidth)).catch(() => view.viewport.width)
    const scroll = await view.page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => ({ x: 0, y: 0 }))
    const screenshot = input.screenshot === true
      ? await this.diagnosticScreenshot(view).then(data => this.attachments.saveImage({ data, mediaType: 'image/png', name: `browser-diagnose-${view.viewId}.png` }))
      : undefined
    const contextTopology = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.snapshot() : undefined
    const recorder = this.recorder.status(session.sessionId, session.key)
    const buildTopology = this.builds.snapshot(session.key)
    const applications = await this.refreshApplications(session, view)
    const controllerIdentity = this.controllerIdentity(session.sessionId)
    const l3 = createL3Checkpoint({
      ...(controllerIdentity === undefined ? {} : { controllerIdentity }),
      ...(contextTopology === undefined ? {} : { contextTopology }),
      recorder,
      builds: buildTopology.builds,
      applications,
      ...(element?.application?.applicationId === undefined ? {} : { selectedApplicationId: element.application.applicationId }),
      ...(element?.surface === undefined ? {} : { surface: element.surface }),
      degradations: contextTopology?.degradations.map(item => item.code) ?? [],
    })
    return this.debugSessions.checkpoint(session.key, {
      label: input.label?.trim().slice(0, 160) || `checkpoint-${Date.now()}`,
      createdAt: Date.now(),
      viewId: view.viewId,
      contextGeneration: session.contextGeneration,
      documentGeneration: view.documentGeneration,
      navigationId: view.navigationId,
      cursor,
      journalRange: {
        afterSequence: range.afterSequence,
        untilSequence: cursor.sequence,
        eventCount: events.length,
      },
      environment: {
        provider: session.provider,
        controlOwner: session.control.owner,
        url: redactUrl(view.page.url()),
        viewport: { width: view.viewport.width, height: view.viewport.height, generation: view.viewport.generation },
        deviceScaleFactor: view.viewport.deviceScaleFactor,
        scroll,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
      },
      summaries: {
        console: {
          total: events.filter(event => event.kind === 'console').length,
          errors: events.filter(event => event.kind === 'console' && event.severity === 'error').length,
        },
        network: {
          total: events.filter(event => event.kind === 'network').length,
          failed: events.filter(event => event.kind === 'network' && (event.failure !== undefined || (event.status !== undefined && event.status >= 400))).length,
        },
        actions: events.filter(event => event.kind === 'action').length,
        performance: { status: 'unavailable' },
      },
      ...(screenshot === undefined ? {} : { artifactManifest: [{ kind: 'screenshot' as const, reference: screenshot }] }),
      page: {
        url: redactUrl(view.page.url()),
        title: (await view.page.title().catch(() => '')).slice(0, 500),
        viewport: { width: view.viewport.width, height: view.viewport.height, generation: view.viewport.generation },
        rootScrollWidth,
      },
      ...(element === undefined ? {} : { element }),
      ...(screenshot === undefined ? {} : { screenshot }),
      l3,
      events,
    })
  }

  private async scriptSourceMap(session: SessionState, view: ViewState, error: ConsoleJournalEvent) {
    if (error.documentGeneration !== view.documentGeneration || error.navigationId !== view.navigationId) {
      return {
        schemaVersion: 2 as const,
        confidence: 'unavailable' as const,
        errorEventId: error.eventId,
        errorFingerprint: error.fingerprint,
        reason: 'runtime error belongs to a different document or navigation; the current build cannot safely reinterpret it',
      }
    }
    const generated = parseGeneratedLocation(error.stack)
    if (generated === undefined) return { confidence: 'unavailable' as const, reason: 'error stack has no generated script location' }
    const state = await this.ensureDebugger(session, view)
    const selected = this.builds.selectScript(session.key, {
      viewId: view.viewId,
      documentGeneration: error.documentGeneration,
      url: generated.url,
      line: generated.line,
      ...(error.targetId === undefined ? {} : { targetId: error.targetId }),
      ...(error.frameId === undefined ? {} : { frameId: error.frameId }),
    })
    if (selected.status === 'ambiguous') return { confidence: 'unavailable' as const, generated, reason: 'ambiguous-build: more than one active script matches the error identity and generated location' }
    const script = selected.script === undefined ? undefined : state.scripts.get(selected.script.scriptId)
    if (script === undefined) return { confidence: 'unavailable' as const, generated, reason: 'generated script is not available in the current debugger session' }
    const client = rawCdp(state.session)
    const result = await client.send('Debugger.getScriptSource', { scriptId: script.scriptId })
    const source = string(result.scriptSource)
    const sourceMapMatch = /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source)
    const sourceMapReference = sourceMapMatch?.[1]
    if (sourceMapReference === undefined) return { confidence: 'unavailable' as const, generated, reason: 'generated script does not declare sourceMappingURL' }
    let sourceMapUrl: string
    let data: Buffer
    if (sourceMapReference.startsWith('data:')) {
      sourceMapUrl = `${generated.url}#inline-source-map`
      const match = /^data:([^,]*?),(.*)$/s.exec(sourceMapReference)
      if (match === null) return { confidence: 'unavailable' as const, generated, reason: 'inline source map URL is invalid' }
      data = /;base64(?:;|$)/i.test(match[1] ?? '') ? Buffer.from(match[2] ?? '', 'base64') : Buffer.from(decodeURIComponent(match[2] ?? ''))
    } else {
      const allowed = assertUrlAllowed(this.config, new URL(sourceMapReference, script.url).href)
      sourceMapUrl = allowed.href
      const response = await this.sessionContext(session).request.get(allowed.href, { failOnStatusCode: false })
      if (!response.ok()) return { confidence: 'unavailable' as const, generated, sourceMapUrl: redactUrl(sourceMapUrl), reason: `source map request failed with HTTP ${response.status()}` }
      data = await response.body()
    }
    if (data.byteLength > this.config.maxArtifactBytes) {
      return { confidence: 'unavailable' as const, generated, sourceMapUrl: redactUrl(sourceMapUrl), reason: 'source map exceeds the configured artifact size limit' }
    }
    let sourceMap: unknown
    try {
      sourceMap = JSON.parse(data.toString('utf8'))
    } catch {
      return { confidence: 'unavailable' as const, generated, sourceMapUrl: redactUrl(sourceMapUrl), reason: 'source map is not valid JSON' }
    }
    const generatedContentSha256 = createHash('sha256').update(source).digest('hex')
    const build = this.builds.bindSource(session.key, script.scriptId, { source, sourceMapUrl, sourceMap })
    const registered = this.builds.script(session.key, script.scriptId)
    Object.assign(script, {
      buildId: build.buildId,
      ...(registered?.scriptSha256 === undefined ? {} : { scriptSha256: registered.scriptSha256 }),
      ...(registered?.sourceMapSha256 === undefined ? {} : { sourceMapSha256: registered.sourceMapSha256 }),
    })
    const resolution = resolveSourceMap(generated, sourceMapUrl, sourceMap, {
      documentUrl: redactUrl(view.page.url()),
      generatedContentSha256,
      buildId: build.buildId,
    })
    return {
      errorEventId: error.eventId,
      errorFingerprint: error.fingerprint,
      ...resolution,
      ...(resolution.workspace === undefined ? {} : {
        workspaceCandidate: {
          ...resolution.workspace,
          buildId: build.buildId,
          reasons: ['generated location matched one active Script Identity', 'Script content and Source Map hashes matched this Build Identity'],
        },
      }),
      ...(resolution.sourceMapUrl === undefined ? {} : { sourceMapUrl: redactUrl(resolution.sourceMapUrl) }),
    }
  }

  private async diagnoseAction(session: SessionState, input: BrowserDiagnoseInput): Promise<ToolOutput> {
    if (input.action.startsWith('recorder_')) {
      const action = input.action.slice('recorder_'.length)
      if (action === 'timeline') {
        this.recorder.status(session.sessionId, session.key)
        const timeline = this.recorder.timeline(session.key, input.limit ?? 200)
        return { ok: true, action: 'recorder_timeline', viewId: session.activeViewId, data: asData({ recorder: this.recorder.snapshot(session.key), timeline, inputTraces: this.inputTraces.list(session.key, Math.min(input.limit ?? 100, 200)) }) }
      }
      return this.recorderAction(session, {
        action: action as BrowserRecorderInput['action'],
        ...(input.recorderMode === undefined ? {} : { mode: input.recorderMode }),
        ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
      })
    }
    if (input.action === 'start') {
      const view = this.view(session, input.viewId)
      await this.ensureContextIdentity(session, view)
      const applications = await this.refreshApplications(session, view)
      const existing = this.debugSessions.get(session.key)
      if (existing !== undefined && existing.viewId !== view.viewId) {
        fail('INVALID_ARGS', `browser diagnose session is already bound to view ${existing.viewId}; stop it before starting on another view`)
      }
      if (existing === undefined) {
        session.diagnosticPanel.latestInspect = undefined
        session.diagnosticPanel.latestComparison = undefined
        session.diagnosticPanel.latestIncident = undefined
        session.diagnosticPanel.latestTakeoverSummary = undefined
      }
      const debugSession = this.debugSessions.start({
        sessionKey: session.key,
        dshSessionId: session.sessionId,
        viewId: view.viewId,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ...(view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.mainContext() : {}),
        startedAt: Date.now(),
        startedCursor: this.journal.cursor(session.key),
      })
      return { ok: true, action: 'diagnose_start', viewId: view.viewId, data: asData({ debugSessionId: debugSession.debugSessionId, viewId: view.viewId, contextGeneration: session.contextGeneration, documentGeneration: view.documentGeneration, startedCursor: debugSession.startedCursor, diagnosticContext: this.diagnosticContext(session, view, debugSession), contextTopology: view.cdp?.contextAdapter?.snapshot(), buildTopology: this.builds.snapshot(session.key), applicationTopology: { applications, truncated: this.applications.snapshot(session.key).truncated } }) }
    }
    if (input.action === 'status') {
      const debugSession = this.debugSessions.get(session.key)
      if (debugSession === undefined) {
        return { ok: true, action: 'diagnose_status', viewId: session.activeViewId, data: asData({ active: false, schemaVersion: 2 }) }
      }
      const view = session.views.get(debugSession.viewId)
      if (view === undefined || view.page.isClosed() || debugSession.contextGeneration !== session.contextGeneration) {
        this.debugSessions.invalidate(session.key)
        return { ok: true, action: 'diagnose_status', viewId: session.activeViewId, data: asData({ active: false, schemaVersion: 2, previousDebugSessionId: debugSession.debugSessionId, status: 'invalidated' }) }
      }
      const applications = await this.refreshApplications(session, view)
      return { ok: true, action: 'diagnose_status', viewId: view.viewId, data: asData({ active: true, diagnosticContext: this.diagnosticContext(session, view, debugSession), contextTopology: view.cdp?.contextAdapter?.snapshot(), buildTopology: this.builds.snapshot(session.key), applicationTopology: { applications, truncated: this.applications.snapshot(session.key).truncated }, startedAt: debugSession.startedAt, startedCursor: debugSession.startedCursor, checkpointCount: debugSession.checkpoints.size, cursor: this.journal.cursor(session.key) }) }
    }
    if (input.action === 'stop') {
      const stopped = this.debugSessions.stop(session.key)
      if (stopped !== undefined) {
        const state = session.views.get(stopped.viewId)?.cdp
        state?.contextAdapter?.dispose()
        if (state !== undefined) state.contextAdapter = undefined
        this.contextIdentities.invalidateSession(session.key, session.contextGeneration)
      }
      return { ok: true, action: 'diagnose_stop', viewId: stopped?.viewId ?? session.activeViewId, data: asData({
        stopped: stopped !== undefined,
        schemaVersion: 2,
        cleanup: {
          status: 'clean',
          debugSessionStore: 'clean',
          checkpointStore: 'clean',
          journal: 'retained-by-browser-session',
          browserResources: 'managed-by-runtime',
        },
        ...(stopped === undefined ? {} : { debugSessionId: stopped.debugSessionId, status: stopped.status, cursor: this.journal.cursor(session.key) }),
      }) }
    }
    const { record: debugSession, view } = this.debugSessionView(session, input)
    if (input.action === 'inspect') {
      const ref = input.ref?.trim()
      if (ref === undefined || ref === '') fail('INVALID_ARGS', 'browser_diagnose inspect requires a current snapshot ref')
      const element = await this.inspectElement(view, ref)
      const application = await this.elementApplication(session, view, ref)
      if (application !== undefined) element.application = application
      const occluder = element.hitTest?.targetMatches === false ? element.hitTest.topElement : undefined
      session.diagnosticPanel.latestInspect = {
        viewId: view.viewId,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        ref,
        target: {
          tag: element.identity?.tag ?? 'unknown',
          ...(element.identity?.role === undefined ? {} : { role: element.identity.role }),
          ...(element.identity?.accessibleName === undefined ? {} : { accessibleName: element.identity.accessibleName }),
          ...(element.box === undefined ? {} : { box: element.box }),
        },
        ...(occluder === undefined || occluder === null ? {} : {
          occluder: {
            tag: occluder.tag,
            ...(occluder.id === undefined ? {} : { id: occluder.id }),
            ...(occluder.role === undefined ? {} : { role: occluder.role }),
            ...(occluder.accessibleName === undefined ? {} : { accessibleName: occluder.accessibleName }),
            box: occluder.box,
          },
        }),
      }
      const { events, range } = this.diagnosticRange(session, view, input, this.checkpointCursor(session.key))
      return { ok: true, action: 'diagnose_inspect', viewId: view.viewId, data: asData({ debugSessionId: debugSession.debugSessionId, contextGeneration: session.contextGeneration, documentGeneration: view.documentGeneration, navigationId: view.navigationId, diagnosticContext: this.diagnosticContext(session, view, debugSession), range, element, evidence: projectEvidence(events), actionTimeline: projectActionTimeline(events) }) }
    }
    if (input.action === 'checkpoint') {
      const checkpoint = await this.diagnosticCheckpoint(session, input)
      return { ok: true, action: 'diagnose_checkpoint', viewId: view.viewId, data: asData({ diagnosticContext: this.diagnosticContext(session, view, debugSession), checkpoint }) }
    }
    if (input.action === 'compare') {
      const beforeId = input.beforeCheckpointId?.trim()
      const afterId = input.afterCheckpointId?.trim()
      if (beforeId === undefined || beforeId === '' || afterId === undefined || afterId === '') fail('INVALID_ARGS', 'browser_diagnose compare requires beforeCheckpointId and afterCheckpointId')
      const before = this.debugSessions.checkpointById(session.key, beforeId)
      const after = this.debugSessions.checkpointById(session.key, afterId)
      if (before === undefined || after === undefined) fail('INVALID_ARGS', 'browser diagnose checkpoint does not exist in the current session')
      const comparison = compareCheckpoints(before, after)
      const l3Comparison = before.l3 === undefined || after.l3 === undefined ? undefined : compareL3Checkpoints(before.l3, after.l3)
      session.diagnosticPanel.latestComparison = {
        beforeCheckpointId: comparison.before,
        afterCheckpointId: comparison.after,
        overallVerdict: comparison.overallVerdict,
        comparable: comparison.comparability.comparable,
        newRegressionCount: comparison.newRegressions.errors.length
          + comparison.newRegressions.failedRequests.length
          + Number(comparison.newRegressions.elementOccluded)
          + Number(comparison.newRegressions.rootOverflowIncreased),
        ...(l3Comparison === undefined ? {} : { l3Verdict: l3Comparison.verdict, l3Comparable: l3Comparison.comparability.comparable }),
      }
      const output = projectDiagnosticCompareOutput({
        comparison,
        ...(l3Comparison === undefined ? {} : { l3Comparison }),
        diagnosticContext: this.diagnosticContext(session, view, debugSession),
      })
      return { ok: true, action: 'diagnose_compare', viewId: view.viewId, data: asData(output) }
    }
    if (input.action === 'report') {
      const applications = await this.refreshApplications(session, view)
      const { events, range } = this.diagnosticRange(session, view, input, debugSession.startedCursor.sequence)
      const errors = events.filter((event): event is ConsoleJournalEvent => event.kind === 'console' && event.stack !== undefined).slice(-10)
      const sourceMaps = []
      for (const error of errors) sourceMaps.push(await this.scriptSourceMap(session, view, error))
      const checkpoints = this.debugSessions.checkpoints(session.key)
      const before = checkpoints.at(-2)
      const after = checkpoints.at(-1)
      const comparison = before === undefined || after === undefined ? undefined : compareCheckpoints(before, after)
      const l3Comparison = before?.l3 === undefined || after?.l3 === undefined ? undefined : compareL3Checkpoints(before.l3, after.l3)
      const environment = {
        provider: session.provider,
        viewId: view.viewId,
        contextGeneration: session.contextGeneration,
        documentGeneration: view.documentGeneration,
        navigationId: view.navigationId,
        url: redactUrl(view.page.url()),
      }
      const timeline = projectActionTimeline(events)
      const incidentReport = buildIncidentReport({
        debugSession,
        events,
        timeline,
        checkpoints,
        sourceMappings: sourceMaps,
        ...(comparison === undefined ? {} : { comparison }),
        environment,
        generatedAt: Date.now(),
      })
      const selectedL3 = checkpoints.at(-1)?.l3
      const currentContextTopology = view.cdp?.contextAdapter?.isEnabled() ? view.cdp.contextAdapter.snapshot() : undefined
      // 同一个 Incident 当前态必须只读取一次控制器身份，避免控制器切换恰好发生时，
      // 单份快照内的 generation 或 registrationMode 前后不一致。
      const currentControllerIdentity = this.controllerIdentity(session.sessionId)
      const currentL3 = createL3Checkpoint({
        ...(currentControllerIdentity === undefined ? {} : { controllerIdentity: currentControllerIdentity }),
        ...(currentContextTopology === undefined ? {} : { contextTopology: currentContextTopology }),
        recorder: this.recorder.status(session.sessionId, session.key),
        builds: this.builds.snapshot(session.key).builds,
        applications,
        ...(selectedL3?.selectedApplicationId === undefined ? {} : { selectedApplicationId: selectedL3.selectedApplicationId }),
        ...(selectedL3?.surface === undefined ? {} : { surface: selectedL3.surface }),
        degradations: currentContextTopology?.degradations.map(item => item.code) ?? [],
      })
      const crossContextLinks = buildCrossContextLinks({
        checkpointId: checkpoints.at(-1)?.checkpointId ?? 'current',
        snapshot: currentL3,
        actionIds: timeline.map(item => item.actionId),
        errorEventIds: errors.map(item => item.eventId),
      })
      const l3Incident = {
        l3IncidentSchemaVersion: 1 as const,
        // 顶层投影便于报告验证器直接审计证据所有权；真实来源仍是不可变的 currentL3。
        ...(currentL3.controllerIdentity === undefined ? {} : { controllerIdentity: currentL3.controllerIdentity }),
        ...(currentL3.contextTopology === undefined ? {} : { context: currentL3.contextTopology }),
        recorder: currentL3.recorder,
        applications: currentL3.applications,
        builds: currentL3.builds,
        ...(currentL3.surface === undefined ? {} : { surface: currentL3.surface }),
        ...(l3Comparison === undefined ? {} : { comparison: l3Comparison }),
        crossContextLinks,
        degradations: currentL3.degradations,
        uncertainty: [
          ...(currentL3.contextTopology === undefined ? ['Context Topology is unavailable.'] : []),
          ...(currentL3.applications.some(item => item.confidence === 'candidate') ? ['Some Application identities remain candidates.'] : []),
          ...(sourceMaps.some(mapping => mapping.confidence === 'unavailable') ? ['Some source mappings remain unavailable.'] : []),
        ],
      }
      session.diagnosticPanel.latestIncident = {
        incidentId: incidentReport.incident.incidentId,
        generatedAt: incidentReport.incident.generatedAt,
        factCount: incidentReport.incident.facts.length,
        causalCandidateCount: incidentReport.incident.causalCandidates.length,
        verificationStatus: incidentReport.incident.verification.status,
        reportBytes: incidentReport.incident.costs.reportBytes,
        crossContextLinkCount: crossContextLinks.length,
        ...(l3Comparison === undefined ? {} : { l3Verdict: l3Comparison.verdict }),
      }
      const markdownTruncated = incidentReport.markdown.length > this.config.maxOutputChars
      const markdown = markdownTruncated
        ? `${incidentReport.markdown.slice(0, this.config.maxOutputChars)}\n\n[TRUNCATED: read the bounded Incident JSON and Artifact Manifest for complete references.]`
        : incidentReport.markdown
      return {
        ok: true,
        action: 'diagnose_report',
        viewId: view.viewId,
        data: asData({
          debugSessionId: debugSession.debugSessionId,
          diagnosticContext: this.diagnosticContext(session, view, debugSession),
          range,
          environment: {
            ...environment,
            viewportGeneration: view.viewport.generation,
          },
          evidence: projectEvidence(events),
          correlations: projectCorrelations(events),
          actionTimeline: timeline,
          checkpoints: checkpoints.map(checkpoint => ({
            checkpointId: checkpoint.checkpointId,
            label: checkpoint.label,
            createdAt: checkpoint.createdAt,
            viewId: checkpoint.viewId,
            contextGeneration: checkpoint.contextGeneration,
            documentGeneration: checkpoint.documentGeneration,
            navigationId: checkpoint.navigationId,
            page: checkpoint.page,
            ...(checkpoint.element === undefined ? {} : { element: checkpoint.element }),
            ...(checkpoint.screenshot === undefined ? {} : { screenshot: checkpoint.screenshot }),
          })),
          sourceMaps,
          buildTopology: this.builds.snapshot(session.key),
          applicationTopology: { applications, truncated: this.applications.snapshot(session.key).truncated },
          incident: incidentReport.incident,
          l3Incident,
          crossContextLinks,
          markdown,
          markdownTruncated,
          artifactManifest: incidentReport.artifactManifest,
          uncertainty: [
            ...(sourceMaps.some(mapping => mapping.confidence === 'unavailable') ? ['Some runtime errors could not be mapped to original source.'] : []),
            ...(events.some(event => event.documentGeneration !== view.documentGeneration) ? ['The report spans more than one document generation; cross-document evidence is not marked as confirmed causality.'] : []),
          ],
        }),
      }
    }
    fail('INVALID_ARGS', `unknown browser_diagnose action ${JSON.stringify(input.action)}`)
  }

  private async createSession(identity: Identity): Promise<SessionState> {
    const key = sessionKey(identity)
    const existing = this.state.sessions.get(key)
    if (existing !== undefined) return existing
    const adopted = await this.adoptPendingSession(identity)
    if (adopted !== undefined) return adopted
    return this.queueSharedContext(async () => {
      const concurrent = this.state.sessions.get(key)
      if (concurrent !== undefined) return concurrent
      await this.sharedPersistentContext()
      const shared = this.state.sharedPersistent
      const splitRatio = await this.profiles.splitViewRatio(identity.sessionId)
      const session: SessionState = {
        key,
        sessionId: identity.sessionId,
        contextGeneration: 0,
        providerBinding: { kind: 'shared-persistent' },
        extensionRegistry: [...shared.extensionRegistry],
        loadedExtensions: [...shared.loadedExtensions],
        views: new Map(),
        activeViewId: '',
        splitView: this.splitViewState(splitRatio),
        nextViewId: 1,
        queue: Promise.resolve(),
        provider: 'managed-persistent',
        persistentProfile: 'default',
        loadedExtensionIds: new Set(shared.loadedExtensionIds),
        liveView: {
          mode: 'adaptive',
          initialized: false,
          open: false,
          fixedWidth: STANDARD_VIEWPORT.width,
          fixedHeight: STANDARD_VIEWPORT.height,
          changedAt: Date.now(),
        },
        control: {
          owner: 'model',
          pending: false,
          changedAt: Date.now(),
        },
        diagnosticPanel: {
          readSequences: new Map(),
        },
      }
      this.state.sessions.set(key, session)
      await this.bindContext(session)
      return session
    })
  }

  private async withSession<T>(identity: Identity, signal: AbortSignal, operation: (session: SessionState) => Promise<T>): Promise<T> {
    requireActive(signal)
    const session = await this.createSession(identity)
    const previous = session.queue
    let release!: () => void
    session.queue = new Promise<void>(resolveQueue => { release = resolveQueue })
    await previous
    const startedAt = Date.now()
    const beforeViews = new Map([...session.views.values()].map(view => [view.viewId, {
      viewId: view.viewId,
      documentGeneration: view.documentGeneration,
      navigationId: view.navigationId,
    }]))
    const beforeActive = beforeViews.get(session.activeViewId)
    try {
      requireActive(signal)
      const result = await operation(session)
      const toolOutput = typeof result === 'object' && result !== null && 'ok' in result && 'action' in result ? result as ToolOutput : undefined
      const after = session.views.get(toolOutput?.viewId ?? session.activeViewId)
      if (identity.toolName !== undefined && identity.toolName !== 'browser_diagnose' && after !== undefined) {
        const before = beforeViews.get(after.viewId) ?? beforeActive
        const data = record(toolOutput?.data)
        const rawSignals = record(data.changeSignals)
        const changeSignals = Object.fromEntries(Object.entries(rawSignals).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
        const contextIdentity = after.cdp?.contextAdapter?.isEnabled() ? after.cdp.contextAdapter.mainContext() : {}
        const action = this.journal.recordAction({
          sessionId: session.sessionId,
          sessionKey: session.key,
          viewId: after.viewId,
          contextGeneration: session.contextGeneration,
          documentGeneration: after.documentGeneration,
          navigationId: after.navigationId,
          ...contextIdentity,
          callId: identity.callId,
          rootCallId: identity.rootCallId,
          toolName: identity.toolName,
          humanInitiated: false,
          startedAt,
          finishedAt: Date.now(),
          outcome: toolOutput?.ok === false ? 'failed' : 'ok',
          ...(before === undefined ? {} : { beforeViewId: before.viewId, beforeDocumentGeneration: before.documentGeneration, beforeNavigationId: before.navigationId }),
          afterViewId: after.viewId,
          afterDocumentGeneration: after.documentGeneration,
          afterNavigationId: after.navigationId,
          ...(Object.keys(changeSignals).length === 0 ? {} : { changeSignals }),
        })
        this.recorder.record(session.sessionId, session.key, {
          source: 'agent',
          kind: 'action',
          viewId: after.viewId,
          documentGeneration: after.documentGeneration,
          navigationId: after.navigationId,
          ...contextIdentity,
          actionId: action.actionId,
          outcome: action.outcome,
          labels: { toolName: action.toolName },
        })
      }
      return result
    } catch (error) {
      const after = session.views.get(session.activeViewId)
      if (identity.toolName !== undefined && identity.toolName !== 'browser_diagnose' && after !== undefined) {
        const before = beforeViews.get(after.viewId) ?? beforeActive
        const contextIdentity = after.cdp?.contextAdapter?.isEnabled() ? after.cdp.contextAdapter.mainContext() : {}
        const action = this.journal.recordAction({
          sessionId: session.sessionId,
          sessionKey: session.key,
          viewId: after.viewId,
          contextGeneration: session.contextGeneration,
          documentGeneration: after.documentGeneration,
          navigationId: after.navigationId,
          ...contextIdentity,
          callId: identity.callId,
          rootCallId: identity.rootCallId,
          toolName: identity.toolName,
          humanInitiated: false,
          startedAt,
          finishedAt: Date.now(),
          outcome: signal.aborted ? 'aborted' : 'failed',
          ...(before === undefined ? {} : { beforeViewId: before.viewId, beforeDocumentGeneration: before.documentGeneration, beforeNavigationId: before.navigationId }),
          afterViewId: after.viewId,
          afterDocumentGeneration: after.documentGeneration,
          afterNavigationId: after.navigationId,
        })
        this.recorder.record(session.sessionId, session.key, {
          source: 'agent',
          kind: 'action',
          viewId: after.viewId,
          documentGeneration: after.documentGeneration,
          navigationId: after.navigationId,
          ...contextIdentity,
          actionId: action.actionId,
          outcome: action.outcome,
          labels: { toolName: action.toolName },
        })
      }
      throw error
    } finally {
      release()
    }
  }

  private async queueSession<T>(session: SessionState, operation: () => Promise<T>): Promise<T> {
    const previous = session.queue
    let release!: () => void
    session.queue = new Promise<void>(resolveQueue => { release = resolveQueue })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private view(session: SessionState, viewId?: string): ViewState {
    // LLM 常会把可选字符串参数序列化为空字符串；空白 viewId 没有可识别目标，安全地等价于省略并使用当前活动页。
    const id = viewId?.trim() || session.activeViewId
    const view = session.views.get(id)
    if (view === undefined || view.page.isClosed()) fail('UNKNOWN_VIEW', `browser view ${JSON.stringify(id)} does not exist`)
    if (view.kind === 'page') session.activeViewId = view.viewId
    return view
  }

  private viewByInput(session: SessionState, viewId?: string, index?: number): ViewState {
    if (viewId !== undefined && viewId.trim() !== '') return this.view(session, viewId)
    if (index !== undefined) {
      const view = [...session.views.values()].filter(item => item.kind === 'page')[index]
      if (view === undefined || view.page.isClosed()) fail('UNKNOWN_VIEW', `browser tab index ${String(index)} does not exist; call browser_tabs with action list`)
      session.activeViewId = view.viewId
      return view
    }
    return this.view(session)
  }

  private paused(view: ViewState, action: string): ToolOutput | undefined {
    if (view.cdp?.paused !== true) return undefined
    return {
      ok: false,
      action,
      viewId: view.viewId,
      data: asData({
        code: 'DEBUGGER_PAUSED',
        recoverable: true,
        message: 'The page is paused in the JavaScript debugger.',
        next: { tool: 'browser_debugger', arguments: { action: 'resume', viewId: view.viewId } },
      }),
    }
  }

  private modelWriteBlocked(session: SessionState, view: ViewState, action: string): ToolOutput | undefined {
    if (session.control.owner !== 'user') return undefined
    return {
      ok: false,
      action,
      viewId: view.viewId,
      data: asData({
        code: 'USER_TAKEOVER_ACTIVE',
        recoverable: true,
        message: 'The user currently has exclusive browser control.',
        next: { tool: 'browser_takeover', arguments: { action: 'status', viewId: view.viewId } },
      }),
    }
  }

  private stale(view: ViewState, action: string): ToolOutput {
    return {
      ok: false,
      action,
      viewId: view.viewId,
      data: asData({
        code: 'STALE_REF',
        recoverable: true,
        message: 'The page changed after the snapshot; the element ref is no longer valid.',
        next: { tool: 'browser_snapshot', arguments: { viewId: view.viewId, includeDiff: true } },
      }),
    }
  }

  private async stopOnAbort<T>(page: Page, signal: AbortSignal, operation: Promise<T>): Promise<T> {
    if (signal.aborted) throw abortReason(signal)
    let remove = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      const onAbort = () => {
        reject(abortReason(signal))
        void page.close({ runBeforeUnload: false }).catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })
      remove = () => signal.removeEventListener('abort', onAbort)
    })
    try {
      return await Promise.race([operation, cancelled])
    } finally {
      remove()
      if (signal.aborted) await Promise.allSettled([operation])
    }
  }

  private async runOnPage<T>(session: SessionState, view: ViewState, signal: AbortSignal, operation: Promise<T>): Promise<T> {
    try {
      return await this.stopOnAbort(view.page, signal, operation)
    } catch (error) {
      if (signal.aborted) {
        await this.refreshPage(session, view.page)
        throw abortReason(signal)
      }
      throw error
    }
  }

  private async refreshPage(session: SessionState, closed: Page): Promise<ViewState> {
    const old = [...session.views.values()].find(view => view.page === closed)
    if (old !== undefined) {
      await this.releaseViewRefs(old)
      session.views.delete(old.viewId)
    }
    const page = await this.createPage(session)
    const view = this.bindView(session, page)
    session.activeViewId = view.viewId
    return view
  }

  async tabs(identity: Identity, signal: AbortSignal, input: { action?: string; viewId?: string; index?: number; url?: string }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const action = input.action ?? 'list'
      if (action !== 'list') {
        const current = session.views.get(session.activeViewId)
        if (current !== undefined) {
          const blocked = this.modelWriteBlocked(session, current, 'tabs')
          if (blocked !== undefined) return blocked
        }
      }
      if (action === 'new') {
        const previousActiveViewId = session.activeViewId
        // 必须在创建 Playwright Page 前完成策略校验，避免被拒绝的 URL 产生不可见的空白页签和 View 状态。
        const rawUrl = input.url?.trim()
        const url = rawUrl === undefined || rawUrl === '' || rawUrl === 'about:blank' ? undefined : assertUrlAllowed(this.config, rawUrl)
        const page = await this.createPage(session)
        const view = this.bindView(session, page)
        if (session.splitView.enabled) {
          if (session.splitView.focusedPane === 'top') session.splitView.topViewId = view.viewId
          else session.splitView.bottomViewId = view.viewId
        }
        session.activeViewId = view.viewId
        try {
          if (url !== undefined) {
            await this.stopOnAbort(view.page, signal, view.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }))
            assertUrlAllowed(this.config, view.page.url())
            await this.applyLiveViewport(session, view)
          }
        } catch (error) {
          // Page 创建后的导航、取消或最终 URL 校验失败必须整体回滚，并恢复调用前的活动页签，保证 new 操作具备原子性。
          await page.close({ runBeforeUnload: false }).catch(() => {})
          const previous = session.views.get(previousActiveViewId)
          const active = previous !== undefined && previous.kind === 'page' && !previous.page.isClosed() ? previous : [...session.views.values()].find(candidate => candidate.kind === 'page' && !candidate.page.isClosed())
          if (active !== undefined) {
            session.activeViewId = active.viewId
            await active.page.bringToFront().catch(() => {})
          }
          throw error
        }
      } else if (action === 'select') {
        const view = this.viewByInput(session, input.viewId, input.index)
        const pane = this.splitPaneForView(session, view.viewId)
        if (session.splitView.enabled) {
          if (pane !== undefined) session.splitView.focusedPane = pane
          else if (session.splitView.focusedPane === 'top') session.splitView.topViewId = view.viewId
          else session.splitView.bottomViewId = view.viewId
        }
        session.activeViewId = view.viewId
        await view.page.bringToFront()
        await this.syncScreencasts(session)
      } else if (action === 'close') {
        const view = this.viewByInput(session, input.viewId, input.index)
        await view.page.close({ runBeforeUnload: false })
        const next = [...session.views.values()].find(item => item.kind === 'page') ?? await this.refreshPage(session, view.page)
        session.activeViewId = next.viewId
      } else if (action !== 'list') {
        fail('INVALID_ARGS', `unknown browser_tabs action ${JSON.stringify(action)}`)
      }
      const views = [...session.views.values()].filter(view => view.kind === 'page')
      const tabs = views.map((view, index) => ({
        index,
        viewId: view.viewId,
        url: view.page.url(),
        title: '',
        active: view.viewId === session.activeViewId,
        status: view.page.isClosed() ? 'closed' : 'loaded',
      }))
      for (let index = 0; index < tabs.length; index += 1) tabs[index]!.title = await views[index]!.page.title().catch(() => '')
      return { ok: true, action: 'tabs', viewId: session.activeViewId, data: asData({ tabs }) }
    })
  }

  async navigate(identity: Identity, signal: AbortSignal, input: { url: string; viewId?: string; timeoutMs?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'navigate')
      if (blocked !== undefined) return blocked
      const paused = this.paused(view, 'navigate')
      if (paused !== undefined) return paused
      const url = assertUrlAllowed(this.config, input.url)
      try {
        await this.runOnPage(session, view, signal, view.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs ?? 30000 }))
      } catch (error) {
        if (signal.aborted) {
          return { ok: false, action: 'navigate', data: asData({ aborted: true }) }
        }
        fail('NAVIGATION_FAILED', `failed to navigate to ${url.origin}`, error)
      }
      assertUrlAllowed(this.config, view.page.url())
      await this.applyLiveViewport(session, view)
      return { ok: true, action: 'navigate', viewId: view.viewId, data: asData({ url: view.page.url(), title: await view.page.title() }) }
    })
  }

  async navigateBack(identity: Identity, signal: AbortSignal, input: { viewId?: string; timeoutMs?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'navigate_back')
      if (blocked !== undefined) return blocked
      await view.page.goBack({ waitUntil: 'domcontentloaded', timeout: input.timeoutMs ?? 30000 })
      if (view.page.url() !== 'about:blank') assertUrlAllowed(this.config, view.page.url())
      await this.applyLiveViewport(session, view)
      return { ok: true, action: 'navigate_back', viewId: view.viewId, data: asData({ url: view.page.url(), title: await view.page.title() }) }
    })
  }

  async snapshot(identity: Identity, signal: AbortSignal, input: { viewId?: string; includeDiff?: boolean; maxNodes?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const maxNodes = Math.min(Math.max(input.maxNodes ?? 80, 1), 300)
      await this.releaseViewRefs(view)
      // 本轮elementHandles先由局部作用域持有，只有成功生成公开Ref的句柄才在提交点转移给View；其余句柄必须在finally释放。
      const handles = await view.page.locator('a,button,input,textarea,select,[role],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),div[class*="btn"],div[class*="button"],span[class*="btn"],span[class*="button"]').elementHandles()
      const nextRefs = new Map<string, RefState>()
      const retainedHandles = new Set<ElementHandle>()
      try {
        const lines: string[] = []
        const nextSnapshotGeneration = view.snapshotGeneration + 1
        for (const handle of handles) {
          if (lines.length >= maxNodes) break
          if (!await handle.isVisible().catch(() => false)) continue
          const info = await handle.evaluate(node => {
            const element = node as HTMLElement
            const tag = element.tagName.toLowerCase()
            const role = element.getAttribute('role')
            const className = typeof element.className === 'string' ? element.className : ''
            const standard = ['a', 'button', 'input', 'textarea', 'select'].includes(tag) || role !== null || element.getAttribute('contenteditable') === 'true'
            const customInteractive = typeof element.onclick === 'function' || element.hasAttribute('onclick') || element.tabIndex >= 0 || /(^|[-_\s])(btn|button)([-_\s]|$)/i.test(className)
            const disabled = 'disabled' in element && Boolean((element as HTMLButtonElement).disabled) || element.getAttribute('aria-disabled') === 'true'
            return {
              tag,
              role,
              name: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || (element as HTMLInputElement).placeholder || '',
              type: (element as HTMLInputElement).type || undefined,
              interactive: standard || customInteractive,
              disabled,
            }
          })
          if (!info.interactive || info.disabled || info.name === '') continue
          const ref = `e${view.refCounter++}`
          nextRefs.set(ref, { handle, documentGeneration: view.documentGeneration, snapshotGeneration: nextSnapshotGeneration })
          lines.push(`${ref} ${info.role ?? info.tag}${info.type ? `[${info.type}]` : ''} ${JSON.stringify(info.name.slice(0, 160))}`)
        }
        view.snapshotGeneration = nextSnapshotGeneration
        for (const [ref, state] of nextRefs) {
          view.refs.set(ref, state)
          retainedHandles.add(state.handle)
        }
        const aria = await view.page.locator('body').ariaSnapshot().catch(() => '')
      const snapshotLimit = Math.min(this.config.maxOutputChars, 6000)
      const refs = `Interactive refs:\n${lines.join('\n')}`
      const ariaLimit = Math.max(snapshotLimit - refs.length - 2, 0)
      const boundedAria = aria.slice(0, ariaLimit)
      const fullSnapshot = `${boundedAria}\n\n${refs}`.slice(0, snapshotLimit)
      let diff: string | null = null
      const incrementalRequested = input.includeDiff ?? view.lastSnapshot !== undefined
      if (incrementalRequested && view.lastSnapshot !== undefined && view.lastSnapshot !== aria) {
        const previousLines = new Set(view.lastSnapshot.split('\n'))
        const currentLines = new Set(aria.split('\n'))
        const changes = [
          ...[...currentLines].filter(line => !previousLines.has(line)).map(line => `+ ${line}`),
          ...[...previousLines].filter(line => !currentLines.has(line)).map(line => `- ${line}`),
        ]
        diff = changes.join('\n').slice(0, 2000)
      }
      const incrementalSnapshot = refs.slice(0, snapshotLimit)
      const incrementalBytes = incrementalSnapshot.length + (diff?.length ?? 0)
      const useIncremental = incrementalRequested
        && view.lastSnapshot !== undefined
        && incrementalBytes < fullSnapshot.length
      // 增量模式始终返回本轮最新refs；ARIA无变化时不重复全文，有变化时使用有界diff。增量不划算时自动回退全文，避免为了省字符丢失页面语义。
      const snapshot = useIncremental ? incrementalSnapshot : fullSnapshot
      const snapshotMode = useIncremental ? 'incremental' : 'full'
      const unchanged = view.lastSnapshot !== undefined && view.lastSnapshot === aria
      view.lastSnapshot = aria
        const truncated = handles.length > maxNodes || aria.length > ariaLimit || refs.length > snapshotLimit
        return { ok: true, action: 'snapshot', viewId: view.viewId, data: asData({ url: view.page.url(), title: await view.page.title(), documentGeneration: view.documentGeneration, snapshotGeneration: view.snapshotGeneration, snapshotMode, snapshot, diff: useIncremental ? diff : null, unchanged, truncated }) }
      } catch (error) {
        await this.releaseViewRefs(view)
        throw error
      } finally {
        await this.releaseHandles(handles.filter(handle => !retainedHandles.has(handle)))
      }
    })
  }

  private ref(view: ViewState, value: string) {
    const ref = view.refs.get(value)
    if (ref === undefined || ref.documentGeneration !== view.documentGeneration || ref.snapshotGeneration !== view.snapshotGeneration) fail('STALE_REF', `browser ref ${JSON.stringify(value)} is stale; take a new snapshot`)
    return ref.handle
  }

  async elementAction(identity: Identity, signal: AbortSignal, input: { action: string; viewId?: string; ref?: string; text?: string; key?: string; values?: string[]; timeoutMs?: number; clear?: boolean; submit?: boolean; slowly?: boolean; direction?: string; amount?: number; deltaX?: number; deltaY?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, input.action)
      if (blocked !== undefined) return blocked
      const paused = this.paused(view, input.action)
      if (paused !== undefined) return paused
      const timeout = input.timeoutMs ?? 10000
      // 部分模型会用空字符串占位可选字段；执行边界统一折叠为空缺，避免页面级按键被误判为过期元素引用。
      const normalizedRef = input.ref?.trim() || undefined
      let resultData: Record<string, unknown> = {}
      try {
        const handle = normalizedRef === undefined ? undefined : this.ref(view, normalizedRef)
        if (input.action === 'click') {
          if (handle === undefined) fail('INVALID_ARGS', 'browser_click requires ref; take a browser_snapshot first')
          const beforeUrl = view.page.url()
          const beforeDocumentGeneration = view.documentGeneration
          const beforeDom = await view.page.locator('body').evaluate(node => ({ elements: node.getElementsByTagName('*').length, children: node.childElementCount })).catch(() => undefined)
          await this.runOnPage(session, view, signal, handle.click({ timeout }))
          await view.page.waitForTimeout(50).catch(() => {})
          const afterUrl = view.page.url()
          const afterDom = await view.page.locator('body').evaluate(node => ({ elements: node.getElementsByTagName('*').length, children: node.childElementCount })).catch(() => undefined)
          const changeSignals = {
            url: afterUrl !== beforeUrl,
            document: view.documentGeneration !== beforeDocumentGeneration,
            dom: beforeDom !== undefined && afterDom !== undefined && (beforeDom.elements !== afterDom.elements || beforeDom.children !== afterDom.children),
          }
          resultData = { changed: changeSignals.url || changeSignals.document || changeSignals.dom, changeSignals }
        } else if (input.action === 'type') {
          if (handle === undefined) fail('INVALID_ARGS', 'browser_type requires ref; take a browser_snapshot first')
          if (input.clear ?? true) await this.runOnPage(session, view, signal, handle.fill('', { timeout }))
          if (input.slowly === true) await this.runOnPage(session, view, signal, handle.type(input.text ?? '', { delay: 35, timeout }))
          else await this.runOnPage(session, view, signal, handle.fill(input.text ?? '', { timeout }))
          if (input.submit === true) await this.runOnPage(session, view, signal, handle.press('Enter', { timeout }))
        } else if (input.action === 'hover') {
          if (handle === undefined) fail('INVALID_ARGS', 'browser_hover requires ref; take a browser_snapshot first')
          await this.runOnPage(session, view, signal, handle.hover({ timeout }))
        } else if (input.action === 'scroll') {
          if (handle !== undefined) await this.runOnPage(session, view, signal, handle.scrollIntoViewIfNeeded({ timeout }))
          else {
            const amount = input.amount ?? 300
            const dx = input.deltaX ?? (input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0)
            const dy = input.deltaY ?? (input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0)
            await this.runOnPage(session, view, signal, view.page.mouse.wheel(dx, dy))
          }
        } else if (input.action === 'press_key') {
          if (input.key === undefined || input.key === '') fail('INVALID_ARGS', 'browser_press_key requires key')
          if (handle === undefined) await this.runOnPage(session, view, signal, view.page.keyboard.press(input.key))
          else await this.runOnPage(session, view, signal, handle.press(input.key, { timeout }))
        } else if (input.action === 'select_option') {
          if (handle === undefined) fail('INVALID_ARGS', 'browser_select_option requires ref; take a browser_snapshot first')
          await this.runOnPage(session, view, signal, handle.selectOption(input.values ?? [], { timeout }))
        }
        else fail('INVALID_ARGS', `unknown browser element action ${JSON.stringify(input.action)}`)
      } catch (error) {
        if (error instanceof Error && (error as { code?: string }).code === 'STALE_REF') return this.stale(view, input.action)
        if (normalizedRef !== undefined) {
          const ref = view.refs.get(normalizedRef)
          if (ref === undefined || await ref.handle.isHidden().catch(() => true)) return this.stale(view, input.action)
        }
        throw error
      }
      return { ok: true, action: input.action, viewId: view.viewId, data: asData({ url: view.page.url(), ...resultData }) }
    })
  }

  async waitFor(identity: Identity, signal: AbortSignal, input: { viewId?: string; text?: string; textGone?: string; state?: string; time?: number; timeMs?: number; timeoutMs?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      // Schema平铺的可选字段常被模型以空字符串或零值补齐；只有非空文本和正数时间才构成实际条件。
      const text = input.text?.trim() || undefined
      const textGone = input.textGone?.trim() || undefined
      const time = input.time !== undefined && input.time > 0 ? input.time : undefined
      const timeMs = input.timeMs !== undefined && input.timeMs > 0 ? input.timeMs : undefined
      if (time !== undefined && timeMs !== undefined) fail('INVALID_ARGS', 'browser_wait_for accepts either positive time seconds or positive timeMs, not both')
      const delay = timeMs ?? (time === undefined ? undefined : Math.round(time * 1000))
      if (delay !== undefined) await new Promise<void>((resolveWait, reject) => {
        const timer = setTimeout(resolveWait, delay)
        const onAbort = () => { clearTimeout(timer); reject(abortReason(signal)) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      else if (text !== undefined) await this.runOnPage(session, view, signal, view.page.getByText(text, { exact: false }).waitFor({ state: input.state === 'hidden' ? 'hidden' : 'visible', timeout: input.timeoutMs ?? 30000 }))
      else if (textGone !== undefined) await this.runOnPage(session, view, signal, view.page.getByText(textGone, { exact: false }).waitFor({ state: 'hidden', timeout: input.timeoutMs ?? 30000 }))
      else await this.runOnPage(session, view, signal, view.page.waitForLoadState(input.state === 'networkidle' ? 'networkidle' : 'domcontentloaded', { timeout: input.timeoutMs ?? 30000 }))
      return { ok: true, action: 'wait_for', viewId: view.viewId, data: asData({ waitedMs: delay ?? null, condition: text ?? textGone ?? input.state ?? 'domcontentloaded' }) }
    })
  }

  async screenshot(identity: Identity, signal: AbortSignal, input: { viewId?: string; fullPage?: boolean }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const data = await view.page.screenshot({ type: 'png', fullPage: input.fullPage ?? false })
      const image = await this.attachments.saveImage({ data, mediaType: 'image/png', name: 'browser-screenshot.png' })
      return { ok: true, action: 'screenshot', viewId: view.viewId, data: asData(image) }
    })
  }

  async getAttribute(identity: Identity, signal: AbortSignal, input: { viewId?: string; ref: string; name: string }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      if (/^(value|srcdoc|nonce)$/i.test(input.name)) fail('POLICY_DENIED', `attribute ${input.name} is not readable`)
      const value = await this.ref(view, input.ref).getAttribute(input.name)
      return { ok: true, action: 'get_attribute', viewId: view.viewId, data: asData({ name: input.name, value }) }
    })
  }

  async query(identity: Identity, signal: AbortSignal, input: { viewId?: string; frameId?: string; selector: string; field: string; attribute?: string; limit?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      let frame = view.page.mainFrame()
      let frameIdentity: EvidenceContextIdentity = {}
      if (input.frameId !== undefined && input.frameId.trim() !== '') {
        const adapter = view.cdp?.contextAdapter
        if (adapter?.isEnabled() !== true) fail('INVALID_ARGS', 'frameId query requires an active browser diagnose session')
        const topology = adapter.snapshot()
        const requested = topology.frames.find(candidate => candidate.frameId === input.frameId && candidate.viewId === view.viewId && candidate.attached)
        if (requested === undefined) fail('INVALID_ARGS', 'frameId does not identify an attached Frame in the current diagnose session')
        let mainOrigin = ''
        let frameOrigin = ''
        try { mainOrigin = new URL(view.page.url()).origin } catch {}
        try { frameOrigin = new URL(requested.url).origin } catch {}
        if (requested.oopif || mainOrigin === '' || frameOrigin !== mainOrigin) fail('POLICY_DENIED', 'FRAME_QUERY_CROSS_ORIGIN_UNAVAILABLE: cross-origin and OOPIF element queries remain unavailable')
        const matches = view.page.frames().filter(candidate => adapter.contextForFrame(candidate).frameId === requested.frameId)
        if (matches.length !== 1) fail('INVALID_ARGS', 'frameId could not be resolved to one Playwright Frame')
        frame = matches[0]!
        frameIdentity = adapter.contextForFrame(frame)
      }
      const locator = frame.locator(input.selector)
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
      const count = await locator.count()
      if (input.field === 'count') return { ok: true, action: 'query', viewId: view.viewId, data: asData({ count }) }
      if (input.field === 'refs') {
        // refs查询会建立一组新的短期引用并使旧快照引用失效；未公开或超过limit的ElementHandle也必须由本轮释放。
        await this.releaseViewRefs(view)
        const handles = await locator.elementHandles()
        const retainedHandles = new Set<ElementHandle>()
        try {
          const nextSnapshotGeneration = view.snapshotGeneration + 1
          const nextRefs = new Map<string, RefState>()
          const refs: Array<{ ref: string; text: string; visible: boolean }> = []
          for (const handle of handles.slice(0, limit)) {
            const visible = await handle.isVisible().catch(() => false)
            const text = (await handle.evaluate(node => (node as HTMLElement).getAttribute('aria-label') || (node as HTMLElement).getAttribute('title') || node.textContent?.trim() || '').catch(() => '')).slice(0, 160)
            if (!visible || text === '') continue
            const ref = `e${view.refCounter++}`
            nextRefs.set(ref, { handle, documentGeneration: view.documentGeneration, snapshotGeneration: nextSnapshotGeneration })
            refs.push({ ref, text, visible })
          }
          view.snapshotGeneration = nextSnapshotGeneration
          for (const [ref, state] of nextRefs) {
            view.refs.set(ref, state)
            retainedHandles.add(state.handle)
          }
          return { ok: true, action: 'query', viewId: view.viewId, data: asData({ count, refs, documentGeneration: view.documentGeneration, snapshotGeneration: view.snapshotGeneration, ...frameIdentity }) }
        } catch (error) {
          await this.releaseViewRefs(view)
          throw error
        } finally {
          await this.releaseHandles(handles.filter(handle => !retainedHandles.has(handle)))
        }
      }
      const values: unknown[] = []
      for (let index = 0; index < Math.min(count, limit); index += 1) {
        const item = locator.nth(index)
        if (input.field === 'text') values.push((await item.innerText().catch(() => '')).slice(0, 400))
        else if (input.field === 'visible') values.push(await item.isVisible())
        else if (input.field === 'attribute') {
          if (input.attribute === undefined || /^(value|srcdoc|nonce)$/i.test(input.attribute)) fail('POLICY_DENIED', 'query attribute is not readable')
          values.push(await item.getAttribute(input.attribute))
        } else fail('INVALID_ARGS', `unknown browser query field ${JSON.stringify(input.field)}`)
      }
      return { ok: true, action: 'query', viewId: view.viewId, data: asData({ count, values }) }
    })
  }

  async consoleMessages(identity: Identity, signal: AbortSignal, input: { viewId?: string; clear?: boolean }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const messages = view.console.slice(-100)
      if (input.clear === true) view.console.length = 0
      return { ok: true, action: 'console_messages', viewId: view.viewId, data: asData({ messages }) }
    })
  }

  async networkRequests(identity: Identity, signal: AbortSignal, input: { viewId?: string; clear?: boolean }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const requests = view.network.slice(-150)
      if (input.clear === true) view.network.length = 0
      return { ok: true, action: 'network_requests', viewId: view.viewId, data: asData({ requests }) }
    })
  }

  async handleDialog(identity: Identity, signal: AbortSignal, input: { viewId?: string; accept: boolean; promptText?: string }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'handle_dialog')
      if (blocked !== undefined) return blocked
      if (view.dialog !== undefined) {
        const dialog = view.dialog
        view.dialog = undefined
        if (input.accept) await dialog.accept(input.promptText)
        else await dialog.dismiss()
        return { ok: true, action: 'handle_dialog', viewId: view.viewId, data: asData({ resolved: true }) }
      }
      view.dialogPolicy = { accept: input.accept, ...(input.promptText === undefined ? {} : { promptText: input.promptText }) }
      return { ok: true, action: 'handle_dialog', viewId: view.viewId, data: asData({ preconfigured: true }) }
    })
  }

  async upload(identity: Identity, signal: AbortSignal, input: { viewId?: string; ref: string; filePath: string }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'upload_file')
      if (blocked !== undefined) return blocked
      const filePath = assertUploadPath(this.config, input.filePath)
      const info = await stat(filePath)
      if (!info.isFile() || info.size > this.config.maxUploadBytes) fail('POLICY_DENIED', 'upload file is invalid or exceeds the configured size limit')
      await this.ref(view, input.ref).setInputFiles(filePath)
      return { ok: true, action: 'upload_file', viewId: view.viewId, data: asData({ name: basename(filePath), bytes: info.size }) }
    })
  }

  async download(identity: Identity, signal: AbortSignal, input: { viewId?: string; ref: string; timeoutMs?: number }): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'download')
      if (blocked !== undefined) return blocked
      const [download] = await Promise.all([
        view.page.waitForEvent('download', { timeout: input.timeoutMs ?? 30000 }),
        this.ref(view, input.ref).click({ timeout: input.timeoutMs ?? 30000 }),
      ])
      const name = basename(download.suggestedFilename()).replace(/[^\w.() -]/g, '_') || 'download.bin'
      const directory = join(this.config.artifactRoot, session.key.replace(/[^\w.-]/g, '_'))
      await mkdir(directory, { recursive: true })
      const path = join(directory, `${Date.now()}-${name}`)
      await download.saveAs(path)
      const info = await stat(path)
      if (info.size > this.config.maxDownloadBytes) {
        await rm(path, { force: true })
        fail('POLICY_DENIED', 'download exceeds the configured size limit')
      }
      return { ok: true, action: 'download', viewId: view.viewId, data: asData({ artifact: path, name, bytes: info.size }) }
    })
  }

  async debugger(identity: Identity, signal: AbortSignal, input: BrowserDebuggerInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.debuggerAction(session, input))
  }

  async diagnose(identity: Identity, signal: AbortSignal, input: BrowserDiagnoseInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.diagnoseAction(session, input))
  }

  async networkControl(identity: Identity, signal: AbortSignal, input: BrowserNetworkInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.networkAction(session, input))
  }

  async profile(identity: Identity, signal: AbortSignal, input: BrowserProfileInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.profileAction(session, input))
  }

  async provider(identity: Identity, signal: AbortSignal, input: BrowserProviderInput): Promise<ToolOutput> {
    requireActive(signal)
    const session = await this.createSession(identity)
    if (input.action === 'list' || input.action === 'capabilities') {
      return this.queueSession(session, () => this.providerAction(session, input))
    }
    return this.queueSharedContext(() => this.queueSessions([session], async () => {
      requireActive(signal)
      return this.providerAction(session, input)
    }))
  }

  async extensions(identity: Identity, signal: AbortSignal, input: BrowserExtensionInput): Promise<ToolOutput> {
    requireActive(signal)
    const session = await this.createSession(identity)
    if (!this.extensionMutationRequiresSharedLock(session, input)) {
      return this.queueSession(session, async () => {
        requireActive(signal)
        return this.extensionAction(session, input)
      })
    }
    return this.queueSharedContext(async () => {
      const sessions = this.sharedSessions()
      return this.queueSessions(sessions, async () => {
        requireActive(signal)
        return this.extensionAction(session, input)
      })
    })
  }

  async emulate(identity: Identity, signal: AbortSignal, input: BrowserEmulateInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.emulateAction(session, input))
  }

  async liveView(identity: Identity, signal: AbortSignal, input: BrowserLiveViewInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.liveViewAction(session, input))
  }

  async splitView(identity: Identity, signal: AbortSignal, input: BrowserSplitViewInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.splitViewAction(session, input))
  }

  async evaluate(identity: Identity, signal: AbortSignal, input: BrowserEvaluateInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, async session => {
      const view = this.view(session, input.viewId)
      const blocked = this.modelWriteBlocked(session, view, 'evaluate')
      if (blocked !== undefined) return blocked
      return this.evaluateAction(session, input)
    })
  }

  async takeover(identity: Identity, signal: AbortSignal, input: BrowserTakeoverInput): Promise<ToolOutput> {
    return this.withSession(identity, signal, session => this.takeoverAction(session, input))
  }

  async panelTakeover(sessionId: string, input: BrowserTakeoverInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'takeover', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.takeoverAction(session, input))
  }

  async panelInputTrace(sessionId: string, input: BrowserInputTraceUpdate): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'input_trace', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, async () => {
      const recorder = this.recorder.status(session.sessionId, session.key)
      if (recorder.mode === 'off' || recorder.status !== 'recording') return { ok: true, action: 'input_trace', viewId: input.viewId, data: asData({ recorded: false }) }
      const timestamp = Math.min(input.timestamp, Date.now())
      const trace = this.inputTraces.ensure({
        inputTraceId: input.inputTraceId,
        sessionKey: session.key,
        viewId: input.viewId,
        action: input.action,
        sensitivity: input.sensitivity,
        ...(input.characters === undefined ? {} : { characters: input.characters }),
        composing: input.composing,
        timestamp,
      })
      this.inputTraces.stage(session.key, input.inputTraceId, {
        stage: input.stage,
        timestamp,
        outcome: input.outcome,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      const classifiedResult = classifyInputFailure(input)
      if (input.result !== undefined && input.result !== classifiedResult) fail('INVALID_ARGS', 'browser input trace result does not match the reported stage and outcome')
      if (classifiedResult !== undefined) this.inputTraces.finish(session.key, input.inputTraceId, { timestamp, result: classifiedResult, reason: input.reason })
      return { ok: true, action: 'input_trace', viewId: input.viewId, data: asData({ recorded: true, inputTraceId: trace.inputTraceId, stage: input.stage, result: classifiedResult ?? null }) }
    })
  }

  async panelInput(sessionId: string, input: BrowserUserInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'user_input', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, async () => {
      const startedAt = Date.now()
      const recorder = this.recorder.status(session.sessionId, session.key)
      const tracing = recorder.mode !== 'off' && recorder.status === 'recording'
      const inputTraceId = input.inputTraceId?.trim() || `host-legacy-${this.nextLegacyInputTrace++}`
      const clientRawObserved = typeof input.clientRawAt === 'number' && Number.isFinite(input.clientRawAt)
      const clientNormalizedObserved = typeof input.clientNormalizedAt === 'number' && Number.isFinite(input.clientNormalizedAt)
      // Client时间只用于标记输入管线阶段，不得越过Host实际接收时刻；Normalized也不能早于Raw，否则跨线程排队或异常调用会生成逆序证据。
      const clientRawAt = clientRawObserved ? Math.min(input.clientRawAt as number, startedAt) : startedAt
      const clientNormalizedAt = clientNormalizedObserved ? Math.min(Math.max(input.clientNormalizedAt as number, clientRawAt), startedAt) : startedAt
      const beforeView = session.views.get(input.viewId)
      const before = beforeView === undefined ? undefined : {
        viewId: beforeView.viewId,
        documentGeneration: beforeView.documentGeneration,
        navigationId: beforeView.navigationId,
      }
      const text = input.action === 'insert_text' || input.action === 'composition_commit'
        ? input.text
        : input.action === 'paste'
          ? `${input.text ?? ''}${input.html ?? ''}${input.uriList ?? ''}`
          : input.action === 'key_press' && [...input.key].length === 1
            ? input.key
            : ''
      let observation: Awaited<ReturnType<BrowserRuntime['beginInputObservation']>> | undefined
      if (tracing && beforeView !== undefined) {
        observation = await this.beginInputObservation(beforeView, inputTraceId)
        const trace = this.inputTraces.ensure({
          inputTraceId,
          sessionKey: session.key,
          viewId: input.viewId,
          action: this.inputTraceAction(input),
          sensitivity: observation.sensitivity,
          ...(text === '' ? {} : { characters: summarizeInputCharacters(text) }),
          composing: input.composing ?? false,
          timestamp: clientRawAt,
        })
        this.inputTraces.stage(session.key, inputTraceId, {
          stage: 'client-raw',
          timestamp: clientRawAt,
          outcome: clientRawObserved ? 'observed' : 'unknown',
          ...(clientRawObserved ? {} : { reason: 'legacy-client-stage-unavailable' }),
        })
        this.inputTraces.stage(session.key, inputTraceId, {
          stage: 'client-normalized',
          timestamp: clientNormalizedAt,
          outcome: clientNormalizedObserved ? 'observed' : 'unknown',
          ...(clientNormalizedObserved ? {} : { reason: 'legacy-client-stage-unavailable' }),
        })
        this.inputTraces.stage(session.key, inputTraceId, { stage: 'rpc-received', timestamp: startedAt, outcome: 'delivered' })
        this.inputTraces.stage(session.key, inputTraceId, { stage: 'host-dispatched', timestamp: Date.now(), outcome: 'delivered' })
        void trace
      }
      let result: ToolOutput
      let inputResult: InputTraceRecord['result'] = 'unknown'
      let finalObservation: Awaited<ReturnType<BrowserRuntime['finishInputObservation']>> | undefined
      try {
        result = await this.userInputAction(session, input)
        inputResult = result.ok ? 'delivered' : 'transport-lost'
      } catch (error) {
        inputResult = 'transport-lost'
        throw error
      } finally {
        if (tracing && beforeView !== undefined && observation !== undefined) {
          finalObservation = await this.finishInputObservation(beforeView, inputTraceId).catch(() => undefined)
          if (finalObservation !== undefined) {
            this.inputTraces.stage(session.key, inputTraceId, {
              stage: 'dom-observed',
              timestamp: Date.now(),
              outcome: finalObservation.observed ? 'observed' : 'unknown',
              ...(finalObservation.observed ? {} : { reason: 'no-dom-input-event-observed' }),
            })
            if (finalObservation.targetReplaced) inputResult = 'target-replaced'
            else if (finalObservation.composing) inputResult = 'composition-not-committed'
            else if (finalObservation.focusLost && (input.action === 'insert_text' || input.action === 'composition_commit' || input.action === 'paste' || input.action === 'key_press')) inputResult = 'focus-lost'
            else if (finalObservation.prevented) inputResult = 'prevented-by-page'
            else if (finalObservation.beforeInputObserved && finalObservation.finalLength === finalObservation.initialLength) inputResult = 'dropped-after-beforeinput'
            else if (!finalObservation.observed) inputResult = 'dropped-before-dom-event'
          }
          this.inputTraces.finish(session.key, inputTraceId, { timestamp: Date.now(), result: inputResult, targetReplaced: finalObservation?.targetReplaced })
        }
      }
      if ((input.action === 'composition_commit' || input.action === 'insert_text') && finalObservation !== undefined) {
        // 面板输入处于用户独占期，不能再调用模型 Evaluate 读取页面。这里返回的观察摘要只包含
        // 事件类别、布尔状态与长度，用于验证真实 Composition 及组合后普通输入链；绝不包含正文。
        result = {
          ...result,
          data: asData({
            action: input.action,
            observation: finalObservation,
          }),
        }
      }
      const after = session.views.get(result.viewId ?? input.viewId)
      if (after !== undefined) {
        const contextIdentity = after.cdp?.contextAdapter?.isEnabled() ? after.cdp.contextAdapter.mainContext() : {}
        const action = this.journal.recordAction({
          sessionId: session.sessionId,
          sessionKey: session.key,
          viewId: after.viewId,
          contextGeneration: session.contextGeneration,
          documentGeneration: after.documentGeneration,
          navigationId: after.navigationId,
          ...contextIdentity,
          callId: `panel-${startedAt}`,
          rootCallId: `panel-${startedAt}`,
          toolName: `browser_panel_${input.action}`,
          humanInitiated: true,
          startedAt,
          finishedAt: Date.now(),
          outcome: result.ok ? 'ok' : 'failed',
          ...(before === undefined ? {} : { beforeViewId: before.viewId, beforeDocumentGeneration: before.documentGeneration, beforeNavigationId: before.navigationId }),
          afterViewId: after.viewId,
          afterDocumentGeneration: after.documentGeneration,
          afterNavigationId: after.navigationId,
        })
        if (tracing) {
          const trace = this.inputTraces.get(session.key, inputTraceId)
          this.recorder.record(session.sessionId, session.key, {
            source: 'user',
            kind: `input-${input.action.replaceAll('_', '-')}`,
            viewId: after.viewId,
            documentGeneration: after.documentGeneration,
            navigationId: after.navigationId,
            ...contextIdentity,
            actionId: action.actionId,
            inputTraceId,
            outcome: inputResult,
            ...(trace === undefined ? {} : {
              input: {
                sensitivity: trace.sensitivity,
                ...(trace.characters === undefined ? {} : { characters: trace.characters }),
                composing: trace.composing,
                ...(trace.result === undefined ? {} : { result: trace.result }),
              },
            }),
            ...(finalObservation === undefined ? {} : {
              metrics: {
                initialLength: finalObservation.initialLength,
                finalLength: finalObservation.finalLength,
                targetReplaced: finalObservation.targetReplaced,
                focusLost: finalObservation.focusLost,
              },
            }),
          })
        }
      }
      return result
    })
  }

  async panelLiveView(sessionId: string, input: BrowserLiveViewInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'live_view', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.liveViewAction(session, input, 'user'))
  }

  async panelRecorder(sessionId: string, input: BrowserRecorderInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'recorder', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.recorderAction(session, input))
  }

  async panelSplitView(sessionId: string, input: BrowserSplitViewInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'split_view', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.splitViewAction(session, input))
  }

  async panelNetwork(sessionId: string, input: BrowserNetworkInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'network_control', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.networkAction(session, input, 'user'))
  }

  async panelProfile(sessionId: string, input: BrowserProfileInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'profile', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.profileAction(session, input, 'user'))
  }

  async panelProvider(sessionId: string, input: BrowserProviderInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'provider', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    if (input.action === 'list' || input.action === 'capabilities') return this.queueSession(session, () => this.providerAction(session, input, 'user'))
    return this.queueSharedContext(() => this.queueSessions([session], () => this.providerAction(session, input, 'user')))
  }

  async panelExtensions(sessionId: string, input: BrowserExtensionInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'extensions', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    if (!this.extensionMutationRequiresSharedLock(session, input)) return this.queueSession(session, () => this.extensionAction(session, input))
    return this.queueSharedContext(() => this.queueSessions(this.sharedSessions(), () => this.extensionAction(session, input)))
  }

  async panelEmulate(sessionId: string, input: BrowserEmulateInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return { ok: false, action: 'emulate', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, () => this.emulateAction(session, input, 'user'))
  }

  async panelTabs(sessionId: string, input: BrowserPanelTabInput, sessionCreatedAt?: number): Promise<ToolOutput> {
    let session = this.sessionById(sessionId)
    let createdFromPanel = false
    if (session !== undefined && sessionCreatedAt !== undefined && session.key === pendingSessionKey(sessionId)) {
      session = await this.adoptPendingSession({ sessionId, sessionCreatedAt, callId: 'panel-adopt', rootCallId: 'panel-adopt' })
    }
    if (session === undefined && input.action === 'new') {
      if (sessionCreatedAt !== undefined) {
        // 正式 Session 已存在时直接创建最终隔离键；后续模型工具会命中同一个 BrowserContext。
        session = await this.createSession({ sessionId, sessionCreatedAt, callId: 'panel-new', rootCallId: 'panel-new' })
      } else {
        // DSH 草稿尚未进入 Host Session Store 时使用 sessionId@pending；正式 Session 出现后由 adoptPendingSession 原子接管。
        session = await this.queueSharedContext(async () => {
          const pendingKey = pendingSessionKey(sessionId)
          const existingPending = this.state.sessions.get(pendingKey)
          if (existingPending !== undefined) return existingPending
          await this.sharedPersistentContext()
          const shared = this.state.sharedPersistent
          const splitRatio = await this.profiles.splitViewRatio(sessionId)
          const pending: SessionState = {
            key: pendingKey,
            sessionId,
            contextGeneration: 0,
            providerBinding: { kind: 'shared-persistent' },
            extensionRegistry: [...shared.extensionRegistry],
            loadedExtensions: [...shared.loadedExtensions],
            views: new Map(),
            activeViewId: '',
            splitView: this.splitViewState(splitRatio),
            nextViewId: 1,
            queue: Promise.resolve(),
            provider: 'managed-persistent',
            persistentProfile: 'default',
            loadedExtensionIds: new Set(shared.loadedExtensionIds),
            liveView: { mode: 'adaptive', initialized: false, open: false, fixedWidth: STANDARD_VIEWPORT.width, fixedHeight: STANDARD_VIEWPORT.height, changedAt: Date.now() },
            control: { owner: 'model', pending: false, changedAt: Date.now() },
            diagnosticPanel: { readSequences: new Map() },
          }
          this.state.sessions.set(pending.key, pending)
          await this.bindContext(pending)
          return pending
        })
      }
      createdFromPanel = true
    }
    if (session === undefined) return { ok: false, action: 'panel_tabs', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建浏览器。' }) }
    return this.queueSession(session, async () => {
      const current = input.viewId === undefined || input.viewId.trim() === ''
        ? session.views.get(session.activeViewId)
        : session.views.get(input.viewId)
      if (input.action !== 'new' && (current === undefined || current.page.isClosed())) {
        return { ok: false, action: 'panel_tabs', data: asData({ code: 'NO_ACTIVE_TAB', recoverable: true, message: '当前没有可执行该操作的浏览器标签，请先新建标签。' }) }
      }
      const requireView = (): ViewState => {
        return current as ViewState
      }
      const activate = async (view: ViewState): Promise<boolean> => {
        const changed = session.activeViewId !== view.viewId
        session.activeViewId = view.viewId
        await view.page.bringToFront()
        await this.applyLiveViewport(session, view)
        if (changed) await this.syncScreencasts(session)
        return changed
      }

      if (input.action === 'new') {
        if (createdFromPanel) {
          // createSession 的 bindContext 已创建首个 about:blank；首次面板新建直接复用，避免一次点击产生两个标签。
          const view = session.views.get(session.activeViewId)
          if (view === undefined) fail('PROVIDER_UNAVAILABLE', '浏览器会话创建后没有可用标签。')
          return { ok: true, action: 'panel_tabs', viewId: view.viewId, data: asData({ action: input.action, changed: true, title: '', url: view.page.url() }) }
        }
        const page = await this.createPage(session)
        const view = this.bindView(session, page)
        await activate(view)
        return { ok: true, action: 'panel_tabs', viewId: view.viewId, data: asData({ action: input.action, changed: true, title: '', url: page.url() }) }
      }

      if (input.action === 'select') {
        const view = requireView()
        const changed = await activate(view)
        return { ok: true, action: 'panel_tabs', viewId: view.viewId, data: asData({ action: input.action, changed, title: await view.page.title().catch(() => ''), url: view.page.url() }) }
      }

      if (input.action === 'close') {
        const view = requireView()
        const ordered = [...session.views.values()].filter(item => item.kind === 'page' && !item.page.isClosed())
        const closingIndex = ordered.findIndex(item => item.viewId === view.viewId)
        const wasActive = session.activeViewId === view.viewId
        const next = wasActive ? ordered[closingIndex + 1] ?? ordered[closingIndex - 1] : session.views.get(session.activeViewId)
        await view.page.close({ runBeforeUnload: false })
        if (next === undefined || next.page.isClosed()) {
          // 用户明确选择允许关闭最后一个标签；面板路径不得复用模型工具自动补空白页的兼容语义。
          session.activeViewId = ''
          return { ok: true, action: 'panel_tabs', data: asData({ action: input.action, changed: wasActive, empty: ![...session.views.values()].some(item => item.kind === 'page') }) }
        }
        if (wasActive) await activate(next)
        return { ok: true, action: 'panel_tabs', viewId: next.viewId, data: asData({ action: input.action, changed: wasActive, title: await next.page.title().catch(() => ''), url: next.page.url() }) }
      }

      const view = requireView()
      if (input.action === 'back') await view.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 })
      else if (input.action === 'forward') await view.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 })
      else if (input.action === 'reload') await view.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      else if (input.action === 'navigate') {
        const raw = input.url?.trim()
        if (raw === undefined || raw === '') fail('INVALID_ARGS', '地址栏需要非空网址。')
        // 地址栏只承担网址导航；缺少协议时补 https://，不把普通文本隐式发送给第三方搜索引擎。
        const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
        const url = assertUrlAllowed(this.config, candidate)
        await view.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } else fail('INVALID_ARGS', `unknown browser panel tab action ${JSON.stringify(input.action)}`)
      if (view.page.url() !== 'about:blank') assertUrlAllowed(this.config, view.page.url())
      await activate(view)
      return { ok: true, action: 'panel_tabs', viewId: view.viewId, data: asData({ action: input.action, changed: true, title: await view.page.title().catch(() => ''), url: view.page.url() }) }
    })
  }

  async panelSnapshot(sessionId: string, view: BrowserPanelView, streamGeneration?: number, sequence?: number, splitCursors?: Partial<Record<BrowserSplitViewPane, BrowserFrameCursor>>, popupCursor?: BrowserFrameCursor, diagnosticReadSequence?: number): Promise<BrowserPanelSnapshot> {
    const session = this.sessionById(sessionId)
    if (session === undefined) {
      return { available: false, sessionId, tabs: [], console: [], network: [], message: '当前会话尚未创建托管浏览器。' }
    }
    const current = session.views.get(session.activeViewId) ?? [...session.views.values()].find(item => item.kind === 'page' && !item.page.isClosed())
    if (current === undefined) {
      const extensionState = view === 'extensions' ? await this.extensionState(session) : undefined
      return { available: true, sessionId, tabs: [], console: [], network: [], ...(extensionState === undefined ? {} : extensionState), capabilities: { provider: session.provider, debugger: true, networkInterception: true, tracing: true, cpuProfile: true, coverage: true, heap: true, emulation: true, evaluate: true, screencast: true, takeover: true }, control: session.control, message: '当前没有浏览器标签。' }
    }
    session.activeViewId = current.viewId
    if (view === 'live') session.liveView.open = true
    await this.syncScreencasts(session)
    if (view === 'diagnostic' && diagnosticReadSequence !== undefined && Number.isInteger(diagnosticReadSequence) && diagnosticReadSequence >= 0) {
      // 未读状态属于用户是否查看过诊断工作台，不属于Journal本身。只有诊断视图显式回传已显示序列时才推进当前View游标；Live、Console和Network的后台轮询都不能自动吞掉未读异常，推进游标也绝不删除底层证据。
      const previous = session.diagnosticPanel.readSequences.get(current.viewId) ?? 0
      session.diagnosticPanel.readSequences.set(current.viewId, Math.max(previous, diagnosticReadSequence))
    }
    if (view === 'live' && !session.splitView.enabled) {
      const target = this.liveViewport(session)
      if (
        current.viewport.width !== target.width
        || current.viewport.height !== target.height
        || (session.liveView.mode === 'adaptive' && current.viewport.fitDocumentGeneration !== current.documentGeneration)
      ) {
        await this.queueSession(session, () => this.applyLiveViewport(session, current))
      }
      await this.ensureScreencast(session, current, 'live-view')
    }
    const splitPanes: NonNullable<NonNullable<BrowserPanelSnapshot['splitView']>['panes']> = []
    if (view === 'live' && session.splitView.enabled) {
      for (const pane of ['top', 'bottom'] as const) {
        const target = this.splitPaneView(session, pane)
        if (target === undefined) continue
        await this.queueSession(session, async () => {
          await this.applyLiveViewport(session, target)
          await this.ensureScreencast(session, target, 'live-view')
        })
        const paneFrame = target.cdp?.latestFrame
        const cursor = splitCursors?.[pane]
        splitPanes.push({
          pane,
          viewId: target.viewId,
          focused: session.splitView.focusedPane === pane,
          liveView: this.liveViewState(session, target),
          ...(paneFrame === undefined || (cursor?.streamGeneration === paneFrame.streamGeneration && cursor.sequence === paneFrame.sequence) ? {} : { frame: paneFrame }),
        })
      }
    }
    const tabs: BrowserPanelSnapshot['tabs'] = []
    for (const [index, item] of [...session.views.values()].filter(item => item.kind === 'page').entries()) {
      tabs.push({
        index,
        viewId: item.viewId,
        url: item.page.url(),
        title: await item.page.title().catch(() => ''),
        active: item.viewId === current.viewId,
        status: item.page.isClosed() ? 'closed' : 'loaded',
      })
    }
    const frame = current.cdp?.latestFrame
    // 扩展 Popup 属于整个右侧浏览器面板，而不是扩展管理子视图；所有视图都返回其状态和增量帧，切回实况时继续显示和操作。
    const popup = session.extensionPopup
    if (popup !== undefined) await this.ensureScreencast(session, popup.view, 'live-view')
    const popupFrame = popup?.view.cdp?.latestFrame
    return {
      available: true,
      sessionId,
      activeViewId: current.viewId,
      tabs,
      console: current.console.slice(-100),
      network: current.network.slice(-150),
      debugger: this.debuggerState(current),
      pausedRequests: this.pausedRequests(current),
      artifacts: this.artifacts.list(session.key),
      ...(view === 'extensions' ? await this.extensionState(session) : {}),
      ...(popup === undefined ? {} : {
        extensionPopup: {
          extensionId: popup.extensionId,
          name: popup.name,
          viewId: popup.view.viewId,
          width: popup.view.viewport.width,
          height: popup.view.viewport.height,
          ...(popupFrame === undefined || (popupCursor?.streamGeneration === popupFrame.streamGeneration && popupCursor.sequence === popupFrame.sequence) ? {} : { frame: popupFrame }),
        },
      }),
      capabilities: {
        provider: session.provider,
        debugger: true,
        networkInterception: true,
        tracing: true,
        cpuProfile: true,
        coverage: true,
        heap: true,
        emulation: true,
        evaluate: true,
        screencast: true,
        takeover: true,
      },
      control: session.control,
      diagnostic: this.panelDiagnosticSnapshot(session, current),
      splitView: {
        ...this.splitSnapshot(session),
        ...(splitPanes.length === 0 ? {} : { panes: splitPanes }),
      },
      liveView: {
        mode: session.liveView.mode,
        width: current.viewport.width,
        height: current.viewport.height,
        viewportGeneration: current.viewport.generation,
        reflowed: current.viewport.reflowedElements > 0,
        contentWidth: current.viewport.contentWidth,
        fittedWidth: current.viewport.fittedWidth,
        reflowedElements: current.viewport.reflowedElements,
        changedAt: session.liveView.changedAt,
      },
      ...(!session.splitView.enabled && frame !== undefined && (frame.streamGeneration !== streamGeneration || frame.sequence !== sequence) ? { frame } : {}),
    }
  }

  async panelDebugger(sessionId: string, input: BrowserDebuggerInput): Promise<ToolOutput> {
    const session = this.sessionById(sessionId)
    if (session === undefined) {
      return { ok: false, action: 'debugger', data: asData({ code: 'BROWSER_SESSION_NOT_READY', recoverable: true, message: '当前会话尚未创建托管浏览器。' }) }
    }
    return this.queueSession(session, () => this.debuggerAction(session, input, 'user'))
  }

  async panelClose(sessionId: string, view: BrowserPanelView): Promise<void> {
    if (view !== 'live') return
    const session = this.sessionById(sessionId)
    if (session === undefined) return
    await this.queueSession(session, async () => {
      session.liveView.open = false
      const current = session.views.get(session.activeViewId)
      if (current !== undefined) this.finishPanelTakeover(session, current)
      session.control.owner = 'model'
      session.control.pending = false
      session.control.changedAt = Date.now()
      await Promise.all([...session.views.values()].map(async item => {
        await this.clearAdaptiveFit(item)
        await this.releaseScreencast(item, 'live-view')
      }))
    })
  }

  async suspendSessionController(sessionId: string): Promise<void> {
    const session = this.sessionById(sessionId)
    if (session === undefined) return
    await this.queueSession(session, async () => {
      // 控制器退出必须先收敛会阻塞页面或持续采集数据的能力，再撤销工具面。
      // 这里保留 Page 与 BrowserContext，只使本插件的调试、采集和引用身份全部失效。
      for (const view of session.views.values()) {
        const cdp = view.cdp
        if (cdp === undefined) {
          await this.releaseViewRefs(view)
          view.lastSnapshot = undefined
          continue
        }
        const client = rawCdp(cdp.session)

        await this.releasePausedRequests(view)
        if (cdp.networkEnabled) {
          await client.send('Fetch.disable')
          cdp.networkEnabled = false
        }
        if (cdp.paused) await client.send('Debugger.resume')

        if (cdp.profile.traceActive) {
          await this.profileAction(session, { action: 'trace_stop', viewId: view.viewId }, 'user')
        }
        if (cdp.profile.cpuActive) {
          await this.profileAction(session, { action: 'cpu_stop', viewId: view.viewId }, 'user')
        }
        if (cdp.profile.jsCoverageActive || cdp.profile.cssCoverageActive) {
          await this.profileAction(session, { action: 'coverage_stop', viewId: view.viewId }, 'user')
        }
        if (cdp.profile.heapSamplingActive) {
          await this.profileAction(session, { action: 'heap_sampling_stop', viewId: view.viewId }, 'user')
        }

        await this.clearAdaptiveFit(view)
        await this.forceStopScreencast(view)
        cdp.contextAdapter?.dispose()
        await cdp.session.detach()
        view.cdp = undefined
        view.viewport.generation += 1
        await this.releaseViewRefs(view)
        view.lastSnapshot = undefined
      }

      if (session.playwrightTraceViewId !== undefined) {
        const traceViewId = session.playwrightTraceViewId
        await this.profileAction(session, { action: 'playwright_trace_stop', viewId: traceViewId }, 'user')
      }

      const recorder = this.recorder.status(session.sessionId, session.key)
      if (recorder.mode !== 'off' && recorder.status === 'recording') this.recorder.pause(session.key)
      const current = session.views.get(session.activeViewId)
      if (current !== undefined) this.finishPanelTakeover(session, current)
      session.control.owner = 'model'
      session.control.pending = false
      session.control.changedAt = Date.now()
      session.liveView.open = false

      // Controller generation 改变后，旧 Checkpoint、Build、Application 与 Context Identity
      // 都不能继续参与 Compare；Artifact 仍按 Session 规则保留，但不再代表当前控制器状态。
      this.debugSessions.invalidate(session.key)
      this.contextIdentities.invalidateSession(session.key, session.contextGeneration + 1)
      this.builds.clearSession(session.key)
      this.applications.clearSession(session.key)
      session.contextGeneration += 1
      session.diagnosticPanel.readSequences.clear()
      session.diagnosticPanel.latestInspect = undefined
      session.diagnosticPanel.latestComparison = undefined
      session.diagnosticPanel.latestIncident = undefined
      session.diagnosticPanel.takeover = undefined
      session.diagnosticPanel.latestTakeoverSummary = undefined
    })
  }

  async disposeSession(identity: Pick<Identity, 'sessionId' | 'sessionCreatedAt'>): Promise<void> {
    const key = `${identity.sessionId}@${identity.sessionCreatedAt}`
    let session: SessionState | undefined
    await this.queueSharedContext(async () => {
      session = this.state.sessions.get(key)
      if (session === undefined) return
      this.state.sessions.delete(key)
      await this.queueSessions([session], () => this.cleanupProvider(session as SessionState))
    })
    if (session === undefined) return
    await this.artifacts.removeSession(key)
    this.debugSessions.stop(key)
    this.journal.clearSession(key)
    this.contextIdentities.invalidateSession(key)
    this.recorder.disposeSession(key)
    this.inputTraces.clearSession(key)
    this.builds.clearSession(key)
    this.applications.clearSession(key)
    await rm(join(this.config.artifactRoot, key.replace(/[^\w.-]/g, '_')), { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    if (this.state.disposed) return
    this.state.disposed = true
    await this.chromiumManager.dispose()
    await this.state.sharedPersistent.queue
    const sessions = [...this.state.sessions.values()]
    this.state.sessions.clear()
    await Promise.allSettled(sessions.map(session => this.cleanupProvider(session)))
    await Promise.allSettled(sessions.map(session => this.artifacts.removeSession(session.key)))
    this.debugSessions.clear()
    this.journal.clear()
    this.contextIdentities.clear()
    this.recorder.clear()
    this.inputTraces.clear()
    this.builds.clear()
    this.applications.clear()
    const sharedContext = await this.state.sharedPersistent.launch?.catch(() => undefined) ?? this.state.sharedPersistent.context
    this.state.sharedPersistent.context = undefined
    this.state.sharedPersistent.pageOwners.clear()
    if (sharedContext !== undefined) await sharedContext.close().catch(() => {})
    const browser = await this.state.launch?.catch(() => undefined) ?? this.state.browser
    if (browser !== undefined) await browser.close().catch(() => {})
    await this.artifacts.dispose()
  }
}
