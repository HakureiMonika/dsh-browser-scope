import { useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BrowserControllerSnapshot, BrowserDebuggerInput, BrowserEmulateInput, BrowserExtensionInput, BrowserExtensionSummary, BrowserFrameCursor, BrowserInputTraceUpdate, BrowserLivePaneSnapshot, BrowserLiveViewInput, BrowserLiveViewMode, BrowserNetworkInput, BrowserPanelSnapshot, BrowserPanelTabInput, BrowserPanelView, BrowserProfileInput, BrowserProviderInput, BrowserRecorderInput, BrowserSplitViewInput, BrowserSplitViewPane, BrowserTakeoverInput, BrowserUserInput } from '../protocol.ts'
import css from './panel.module.css'

const CHANNEL = '/browser-tools'
const LIVE_VIEW_PREFERENCE_KEY = 'dsh-browser-tools.live-view-mode'
const OUTER_BROWSER_RATIO_KEY = 'dsh-browser-tools.outer-browser-ratio'
const nativeFrameLayouts = new WeakMap<HTMLElement, { template: string; priority: string; expandedSidebarWidth: number }>()
const views: BrowserPanelView[] = ['live', 'diagnostic', 'console', 'network', 'debugger', 'performance', 'provider', 'extensions', 'emulation']
const viewLabels: Record<BrowserPanelView, string> = {
  live: '实况',
  diagnostic: '诊断',
  console: 'Console',
  network: 'Network',
  debugger: 'Debugger',
  performance: 'Performance',
  provider: 'Provider',
  extensions: '扩展管理',
  emulation: 'Emulation',
}

const debuggerActions: Array<{ action: BrowserDebuggerInput['action']; label: string }> = [
  { action: 'attach', label: '连接' },
  { action: 'pause', label: '暂停' },
  { action: 'resume', label: '继续' },
  { action: 'step_over', label: '单步越过' },
  { action: 'step_into', label: '单步进入' },
  { action: 'step_out', label: '单步跳出' },
  { action: 'detach', label: '断开' },
]

interface CompatibleSlotRegistry {
  register(options: object, component: unknown): () => void
  inject(name: string, callback: () => (() => void) | Iterable<() => void>): () => void
}

type BrowserClientContext = ClientContext & {
  connection: ConnectionHandle
  slots: CompatibleSlotRegistry
}

type SessionSlotProps<K extends 'conversation.input.right' | 'details'> = PropsRuntime<K> & { sessionId: string }

function valueOf<T>(value: unknown): T {
  const result = value as { ok?: boolean; value?: T; error?: { message?: string } }
  if (result?.ok === true) return result.value as T
  throw new Error(result?.error?.message ?? 'browser panel request failed')
}

function liveViewPreference(): BrowserLiveViewMode {
  try {
    return localStorage.getItem(LIVE_VIEW_PREFERENCE_KEY) === 'standard' ? 'standard' : 'adaptive'
  } catch {
    return 'adaptive'
  }
}

function saveLiveViewPreference(mode: BrowserLiveViewMode): void {
  try {
    localStorage.setItem(LIVE_VIEW_PREFERENCE_KEY, mode)
  } catch {}
}

function outerBrowserRatio(): number {
  try {
    const value = Number(localStorage.getItem(OUTER_BROWSER_RATIO_KEY))
    return Number.isFinite(value) ? Math.min(Math.max(value, 0.3), 0.7) : 0.5
  } catch {
    return 0.5
  }
}

function saveOuterBrowserRatio(ratio: number): void {
  try {
    localStorage.setItem(OUTER_BROWSER_RATIO_KEY, String(ratio))
  } catch {}
}

function frameElement(): HTMLElement | undefined {
  const overlay = document.querySelector('[data-shell-overlay]')
  const frame = overlay?.parentElement
  if (!(frame instanceof HTMLElement)) return undefined
  if (getComputedStyle(frame).display !== 'grid' || frame.children.length < 4) return undefined
  return frame
}

function nativeSidebarWidth(template: string): number | undefined {
  // 只识别DSH权威模板“像素侧栏 + 单一1fr中央列 + 像素详情列”；插件自己的双fr模板不会匹配，避免观察器读取到自身投影后形成循环。
  const match = /^\s*(\d+(?:\.\d+)?)px\s+minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s+\d+(?:\.\d+)?px\s*$/.exec(template)
  if (match?.[1] === undefined) return undefined
  const width = Number(match[1])
  return Number.isFinite(width) ? width : undefined
}

function setSplit(onNarrow: () => void): { ok: true; dispose(): void } | { ok: false; message: string } {
  const frame = frameElement()
  if (frame === undefined) return { ok: false, message: '当前 DSH 页面结构不支持内嵌分屏。' }
  if (frame.getBoundingClientRect().width < 800) return { ok: false, message: '当前窗口过窄，请将 DSH Web 窗口扩大到至少 800px。' }
  let nativeLayout = nativeFrameLayouts.get(frame)
  if (nativeLayout === undefined) {
    const inlineTemplate = frame.style.gridTemplateColumns
    const inlineNativeWidth = nativeSidebarWidth(inlineTemplate)
    if (inlineNativeWidth === undefined && frame.dataset.browserSplitActive === 'true') {
      // 热重载或异常卸载可能遗留旧插件双fr模板；先撤销该覆盖，再从DSH自身布局读取基线，禁止新实例继承污染模板。
      frame.style.removeProperty('grid-template-columns')
      delete frame.dataset.browserSplitActive
    }
    const sidebar = frame.children.item(0)
    const renderedWidth = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().width : 0
    const contentWidth = sidebar instanceof HTMLElement ? sidebar.scrollWidth : 0
    const computedWidth = Number.parseFloat(getComputedStyle(frame).gridTemplateColumns) || 0
    nativeLayout = {
      template: inlineNativeWidth === undefined ? frame.style.gridTemplateColumns : inlineTemplate,
      priority: frame.style.getPropertyPriority('grid-template-columns'),
      expandedSidebarWidth: Math.max(inlineNativeWidth ?? 0, renderedWidth, contentWidth, computedWidth, 56),
    }
    nativeFrameLayouts.set(frame, nativeLayout)
  }
  let sidebarWidth = frame.hasAttribute('data-sidebar-collapsed') ? 56 : nativeLayout.expandedSidebarWidth
  let ratio = outerBrowserRatio()
  let applying = false
  let sidebarCollapsed = frame.hasAttribute('data-sidebar-collapsed')
  let collapseProjectionTimer: ReturnType<typeof setTimeout> | undefined
  const columns = () => `${sidebarWidth}px minmax(0, ${1 - ratio}fr) minmax(0, ${ratio}fr)`
  const apply = () => {
    if (applying || !frame.isConnected) return
    applying = true
    frame.dataset.browserSplitActive = 'true'
    frame.style.setProperty('grid-template-columns', columns(), 'important')
    const frameRect = frame.getBoundingClientRect()
    const contentWidth = Math.max(frameRect.width - sidebarWidth, 1)
    divider.style.left = `${frameRect.left + sidebarWidth + contentWidth * (1 - ratio)}px`
    divider.style.top = `${frameRect.top}px`
    divider.style.height = `${frameRect.height}px`
    applying = false
  }
  const divider = document.createElement('div')
  divider.className = css.outerDivider ?? ''
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-label', '调整对话区与浏览器宽度')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-valuemin', '30')
  divider.setAttribute('aria-valuemax', '70')
  divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  divider.tabIndex = 0
  const syncModalState = () => {
    // DSH模态窗口和分界线都可能挂在根层叠上下文；模态存在时彻底移除分界线的视觉与命中，避免设置、目录选择或确认窗口被穿透点击。
    const blocked = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
    divider.hidden = blocked
    divider.tabIndex = blocked ? -1 : 0
    divider.setAttribute('aria-hidden', String(blocked))
    if (blocked && document.activeElement === divider) divider.blur()
    if (!blocked) apply()
  }
  const beginResize = (event: PointerEvent) => {
    divider.setPointerCapture(event.pointerId)
    const move = (pointer: PointerEvent) => {
      const rect = frame.getBoundingClientRect()
      const contentWidth = Math.max(rect.width - sidebarWidth, 1)
      ratio = Math.min(Math.max((rect.right - pointer.clientX) / contentWidth, 0.3), 0.7)
      divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
      apply()
    }
    const finish = (pointer: PointerEvent) => {
      move(pointer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      saveOuterBrowserRatio(ratio)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }
  divider.addEventListener('pointerdown', beginResize)
  const adjustByKey = (event: KeyboardEvent) => {
    const previousRatio = ratio
    if (event.key === 'ArrowLeft') ratio = Math.min(ratio + 0.02, 0.7)
    else if (event.key === 'ArrowRight') ratio = Math.max(ratio - 0.02, 0.3)
    else if (event.key === 'Home') ratio = 0.3
    else if (event.key === 'End') ratio = 0.7
    else return
    event.preventDefault()
    if (ratio === previousRatio) return
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
    apply()
    saveOuterBrowserRatio(ratio)
  }
  divider.addEventListener('keydown', adjustByKey)
  // DSH Grid由框架管理，未知子节点会在重新渲染时被清理；分界线挂到body并用fixed定位，避免干扰Slot子树。
  document.body.append(divider)
  apply()
  syncModalState()
  const mutation = new MutationObserver(() => {
    // DSH折叠属性先于侧栏内部元素动画变化。展开时先释放空间；折叠时暂时保留旧宽度，让内部元素完成收起后再投影56px，避免出现“外框已折叠、内部元素仍停留在展开位置”的裁切状态。
    const nativeWidth = nativeSidebarWidth(frame.style.gridTemplateColumns)
    const collapsed = frame.hasAttribute('data-sidebar-collapsed')
    const collapsedChanged = collapsed !== sidebarCollapsed
    sidebarCollapsed = collapsed
    if (collapsedChanged && collapseProjectionTimer !== undefined) {
      clearTimeout(collapseProjectionTimer)
      collapseProjectionTimer = undefined
    }
    if (collapsed) {
      if (collapsedChanged) {
        const sidebar = frame.children.item(0)
        const renderedWidth = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().width : sidebarWidth
        sidebarWidth = Math.max(Math.round(renderedWidth), sidebarWidth, 56)
        apply()
        collapseProjectionTimer = setTimeout(() => {
          collapseProjectionTimer = undefined
          if (!frame.isConnected || !frame.hasAttribute('data-sidebar-collapsed')) return
          sidebarWidth = 56
          apply()
        }, 240)
      }
    } else {
      const sidebar = frame.children.item(0)
      const renderedWidth = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().width : 0
      const contentWidth = sidebar instanceof HTMLElement ? sidebar.scrollWidth : 0
      const expandedWidth = Math.max(nativeWidth ?? 0, renderedWidth, contentWidth, nativeLayout.expandedSidebarWidth, 56)
      nativeLayout.expandedSidebarWidth = expandedWidth
      sidebarWidth = expandedWidth
    }
    if (!collapsed || !collapsedChanged) {
      if (frame.dataset.browserSplitActive === 'true' && (frame.style.gridTemplateColumns !== columns() || frame.style.getPropertyPriority('grid-template-columns') !== 'important')) apply()
    }
  })
  const modalMutation = new MutationObserver(syncModalState)
  const resize = new ResizeObserver(() => {
    if (frame.getBoundingClientRect().width < 800) {
      // 通过统一控制器关闭可同时停止轮询与 Screencast、撤销面板 Slot、恢复 Grid 并同步输入区按钮状态。
      onNarrow()
      return
    }
    apply()
  })
  mutation.observe(frame, { attributes: true, attributeFilter: ['style', 'data-details-collapsed', 'data-sidebar-collapsed'] })
  modalMutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'aria-modal'] })
  resize.observe(frame)
  return {
    ok: true,
    dispose() {
      if (collapseProjectionTimer !== undefined) clearTimeout(collapseProjectionTimer)
      mutation.disconnect()
      modalMutation.disconnect()
      resize.disconnect()
      divider.removeEventListener('pointerdown', beginResize)
      divider.removeEventListener('keydown', adjustByKey)
      divider.remove()
      delete frame.dataset.browserSplitActive
      if (nativeLayout.template === '') frame.style.removeProperty('grid-template-columns')
      else frame.style.setProperty('grid-template-columns', nativeLayout.template, nativeLayout.priority)
    },
  }
}

interface Port {
  controllerStatus(sessionId: string): Promise<BrowserControllerSnapshot>
  controllerActivate(sessionId: string): Promise<BrowserControllerSnapshot>
  controllerDeactivate(sessionId: string): Promise<BrowserControllerSnapshot>
  controllerRelease(sessionId: string): Promise<BrowserControllerSnapshot>
  snapshot(sessionId: string, view: BrowserPanelView, streamGeneration?: number, sequence?: number, splitCursors?: Partial<Record<BrowserSplitViewPane, BrowserFrameCursor>>, popupCursor?: BrowserFrameCursor, diagnosticReadSequence?: number): Promise<BrowserPanelSnapshot>
  tabs(sessionId: string, input: BrowserPanelTabInput): Promise<unknown>
  debugger(sessionId: string, input: BrowserDebuggerInput): Promise<unknown>
  network(sessionId: string, input: BrowserNetworkInput): Promise<unknown>
  profile(sessionId: string, input: BrowserProfileInput): Promise<unknown>
  provider(sessionId: string, input: BrowserProviderInput): Promise<unknown>
  extensions(sessionId: string, input: BrowserExtensionInput): Promise<unknown>
  emulate(sessionId: string, input: BrowserEmulateInput): Promise<unknown>
  liveView(sessionId: string, input: BrowserLiveViewInput): Promise<unknown>
  splitView(sessionId: string, input: BrowserSplitViewInput): Promise<unknown>
  takeover(sessionId: string, input: BrowserTakeoverInput): Promise<unknown>
  input(sessionId: string, input: BrowserUserInput): Promise<unknown>
  inputTrace(sessionId: string, input: BrowserInputTraceUpdate): Promise<unknown>
  recorder(sessionId: string, input: BrowserRecorderInput): Promise<unknown>
  close(sessionId: string, view: BrowserPanelView): Promise<void>
}

type UntracedBrowserUserInput = BrowserUserInput extends infer Input
  ? Input extends BrowserUserInput
    ? Omit<Input, 'inputTraceId' | 'clientRawAt' | 'clientNormalizedAt'>
    : never
  : never

interface PanelController {
  open(sessionId: string, view: BrowserPanelView): { ok: boolean; message?: string }
  close(): void
  subscribe(listener: (state: { open: boolean; sessionId?: string; view?: BrowserPanelView }) => void): () => void
}

function BrowserControl({ sessionId, controller, port, useSessions }: SessionSlotProps<'conversation.input.right'> & { controller: PanelController; port: Port }) {
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<BrowserPanelView>('live')
  const [message, setMessage] = useState<string>()
  const [controllerBinding, setControllerBinding] = useState<{
    sessionId: string
    snapshot: BrowserControllerSnapshot
  }>()
  const [confirmActivate, setConfirmActivate] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  // DSH 的空白 Hero Session 会在首条消息后切换为新的正式 Session ID，details Slot 也只接受正式 Session。
  // 因此面板和 Controller 选择必须同时满足：输入区绑定的是当前 Session，且该 Session 已经 blank=false。
  // 不能把空白 Session 的选择迁移到新 ID，否则会把一个 Session 的第三方工具仲裁错误投影到另一个 Session。
  const currentSessionId = useSessions(state => state.current)
  const currentSessionBlank = useSessions(state => state.current === undefined
    ? undefined
    : state.byId[state.current]?.blank)
  const panelAvailable = currentSessionId === sessionId && currentSessionBlank === false
  // Controller 快照必须携带其读取时的 Session ID。Hero→正式或普通 Session 切换发生时，
  // 即使 React effect 尚未执行，旧 active 快照也会在本次渲染立即失效，禁止打开错误身份的 BrowserPanel。
  const controllerState = controllerBinding?.sessionId === sessionId
    ? controllerBinding.snapshot
    : undefined
  const loadingController = controllerState === undefined
  const switching = controllerState?.status === 'activating' || controllerState?.status === 'deactivating'
  const active = controllerState?.registrationMode === 'global' || controllerState?.mode === 'dsh-browser-tools'
  const controllerLabel = loadingController
    ? '控制器状态读取中'
    : active
      ? 'DSH BrowserScope'
      : '其他浏览器工具'

  const refreshController = async () => {
    try {
      const snapshot = await port.controllerStatus(sessionId)
      setControllerBinding({ sessionId, snapshot })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    let disposed = false
    // Session 切换时立即清空旧状态并关闭旧分屏，避免把上一 Session 的 active/other、
    // 确认框或 BrowserPanel 短暂投影到新会话；随后只接受携带当前 Session ID 的 RPC 结果。
    setControllerBinding(undefined)
    setConfirmActivate(false)
    setConfirmDeactivate(false)
    setMessage(undefined)
    controller.close()
    const refresh = async () => {
      try {
        const snapshot = await port.controllerStatus(sessionId)
        if (!disposed) setControllerBinding({ sessionId, snapshot })
      } catch (cause) {
        if (!disposed) setMessage(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    return () => { disposed = true }
  }, [controller, port, sessionId])

  useEffect(() => {
    // 分屏可能由输入区按钮或右侧面板关闭，统一订阅控制器的真实状态可避免两个入口显示不一致。
    const unsubscribe = controller.subscribe(state => {
      const current = state.open && state.sessionId === sessionId
      setOpen(current)
      if (current && state.view !== undefined) setView(state.view)
    })
    return () => {
      unsubscribe()
      controller.close()
    }
  }, [controller, sessionId])

  const activate = async () => {
    setConfirmActivate(false)
    setMessage(undefined)
    if (!panelAvailable) {
      // 空白 Hero Session 的 ID 会在首条消息后被正式 Session ID 替换，禁止为临时身份写入控制器选择。
      setMessage('当前会话尚未形成正式 Agent Session；请先发送首条消息，再为正式 Session 启用 DSH BrowserScope。')
      return
    }
    try {
      const snapshot = await port.controllerActivate(sessionId)
      setControllerBinding({ sessionId, snapshot })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
      await refreshController()
    }
  }

  const deactivate = async (release: boolean) => {
    setConfirmDeactivate(false)
    setMessage(undefined)
    controller.close()
    try {
      const snapshot = release
        ? await port.controllerRelease(sessionId)
        : await port.controllerDeactivate(sessionId)
      setControllerBinding({ sessionId, snapshot })
      setMenu(false)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
      await refreshController()
    }
  }

  const toggle = () => {
    if (loadingController) {
      setMessage('正在读取当前 Session 的浏览器控制器状态，请稍候。')
      return
    }
    if (!active) {
      setConfirmActivate(true)
      return
    }
    if (!panelAvailable) {
      setMessage('当前会话尚未形成正式 Agent Session；发送首条消息后即可打开完整浏览器面板。')
      return
    }
    if (open) {
      controller.close()
      setOpen(false)
    } else {
      const result = controller.open(sessionId, view)
      setOpen(result.ok)
      setMessage(result.message)
    }
    setMenu(false)
  }

  const select = (next: BrowserPanelView) => {
    if (loadingController) {
      setView(next)
      setMessage('正在读取当前 Session 的浏览器控制器状态，请稍候。')
      return
    }
    if (!active) {
      setView(next)
      setConfirmActivate(true)
      return
    }
    if (!panelAvailable) {
      setView(next)
      setMessage('当前会话尚未形成正式 Agent Session；发送首条消息后即可打开完整浏览器面板。')
      return
    }
    setView(next)
    const result = controller.open(sessionId, next)
    setOpen(result.ok)
    setMessage(result.message)
    setMenu(false)
  }

  return (
    <span className={css.control}>
      <button type="button" className={css.controlButton} aria-expanded={menu} onClick={() => setMenu(value => !value)}>浏览器</button>
      <span className={css.controllerBadge} data-active={!loadingController && active || undefined}>{controllerLabel}</span>
      {menu && <span className={css.menu}>
        <span className={css.controllerStatus}>当前 Session：{controllerLabel}</span>
        {loadingController && <span className={css.controllerConfirm}>
          <span>尚未确认当前 Session 的浏览器控制器，完整浏览器面板不会在此期间启动。</span>
          <button type="button" onClick={() => { void refreshController() }}>重新读取控制器状态</button>
        </span>}
        {!loadingController && !active && !confirmActivate && <>
          {!panelAvailable && <span className={css.controllerStatus}>当前会话使用临时空白 Session；发送首条消息形成正式 Session 后，才可选择 DSH BrowserScope。</span>}
          <button type="button" disabled={switching} onClick={() => { setMenu(false) }}>继续使用其他浏览器工具</button>
          <button type="button" disabled={switching || !panelAvailable} onClick={() => { setConfirmActivate(true) }}>启用 DSH BrowserScope</button>
        </>}
        {!active && confirmActivate && <span className={css.controllerConfirm}>
          <strong>确认启用 DSH BrowserScope</strong>
          <span>当前 Session 中检测到的其他浏览器控制工具将暂时从模型工具面隐藏；其他 Session、第三方插件及其浏览器状态不受影响。</span>
          <span>第三方插件的标签、登录态、ref 和页面状态不会迁移。</span>
          <span className={css.controllerActions}>
            <button type="button" disabled={switching} onClick={() => { void activate() }}>确认启用</button>
            <button type="button" disabled={switching} onClick={() => setConfirmActivate(false)}>取消</button>
          </span>
        </span>}
        {active && !confirmDeactivate && <>
          {!panelAvailable && <span className={css.controllerStatus}>当前会话尚未形成正式 Agent Session；发送首条消息后可打开完整面板。</span>}
          <button type="button" disabled={!panelAvailable} onClick={toggle}>{open ? '关闭右侧分屏' : '打开右侧分屏'}</button>
          {views.map(item => <button type="button" key={item} disabled={!panelAvailable} data-selected={view === item || undefined} onClick={() => select(item)}>{viewLabels[item]}</button>)}
          {controllerState?.registrationMode === 'session-select' && <button type="button" disabled={switching} onClick={() => setConfirmDeactivate(true)}>退出 DSH BrowserScope</button>}
        </>}
        {active && confirmDeactivate && <span className={css.controllerConfirm}>
          <strong>确认退出 DSH BrowserScope</strong>
          <span>退出会安全收敛 Debugger、Network、Profile、Recorder、Takeover 与旧引用；其他浏览器工具从后续 Agent Step 起恢复。</span>
          <span className={css.controllerActions}>
            <button type="button" disabled={switching} onClick={() => { void deactivate(false) }}>退出并保留页面</button>
            <button type="button" disabled={switching} onClick={() => { void deactivate(true) }}>退出并释放资源</button>
            <button type="button" disabled={switching} onClick={() => setConfirmDeactivate(false)}>取消</button>
          </span>
        </span>}
        {controllerState?.conflictingTools.length ? <span className={css.controllerTools}>已仲裁：{controllerState.conflictingTools.join(', ')}</span> : null}
      </span>}
      {message !== undefined && <span className={css.controlMessage}>{message}</span>}
    </span>
  )
}

function BrowserPanel({ sessionId, port, view, onClose, onViewChange }: SessionSlotProps<'details'> & {
  port: Port
  view: BrowserPanelView
  onClose(): void
  onViewChange(view: BrowserPanelView): void
}) {
  const [snapshot, setSnapshot] = useState<BrowserPanelSnapshot>({ available: false, sessionId, tabs: [], console: [], network: [] })
  const [error, setError] = useState<string>()
  const [breakpointUrl, setBreakpointUrl] = useState('')
  const [breakpointLine, setBreakpointLine] = useState('1')
  const [scope, setScope] = useState<unknown>()
  const [networkPattern, setNetworkPattern] = useState('*')
  const [externalEndpoint, setExternalEndpoint] = useState('http://127.0.0.1:9222')
  const [profileName, setProfileName] = useState('default')
  const [extensionSource, setExtensionSource] = useState('')
  const [viewportWidth, setViewportWidth] = useState('1280')
  const [viewportHeight, setViewportHeight] = useState('720')
  const [locale, setLocale] = useState('zh-CN')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [address, setAddress] = useState('')
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [shareDragArmed, setShareDragArmed] = useState(false)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [extensionMenuOpen, setExtensionMenuOpen] = useState(false)
  const [extensionMenuLoading, setExtensionMenuLoading] = useState(false)
  const [extensionMenuItems, setExtensionMenuItems] = useState<BrowserExtensionSummary[]>([])
  const [extensionPopupPosition, setExtensionPopupPosition] = useState({ x: 18, y: 18 })
  const [pendingExtensionInput, setPendingExtensionInput] = useState<Omit<BrowserExtensionInput, 'applyMode'>>()
  const suppressSharedFrameClick = useRef(false)
  const extensionRpcActive = useRef(false)
  const extensionSnapshotSettled = useRef<Promise<void>>(Promise.resolve())
  const wakeExtensionSnapshot = useRef<(() => void) | undefined>(undefined)
  const imeProxyRef = useRef<HTMLTextAreaElement>(null)
  const imePaneRef = useRef<BrowserSplitViewPane | undefined>(undefined)
  const compositionActive = useRef(false)
  const nextInputTrace = useRef(1)
  const pendingInputTraces = useRef(new Map<string, BrowserInputTraceUpdate>())
  const suppressNextBeforeInput = useRef(false)
  const livePanelRef = useRef<HTMLDivElement>(null)
  const browserShellRef = useRef<HTMLDivElement>(null)
  const extensionPopupWindowRef = useRef<HTMLDivElement>(null)
  const extensionPopupRef = useRef<HTMLImageElement>(null)
  const extensionPopupGesture = useRef<{ identity: { viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number }; last: { x: number; y: number }; pressed: Promise<boolean>; chain: Promise<unknown> }>()
  const pointerGestures = useRef(new Map<number, {
    identity: { viewId: string; streamGeneration: number; frameSequence: number; viewportGeneration: number }
    pane?: BrowserSplitViewPane
    latest?: { x: number; y: number }
    last: { x: number; y: number }
    animationFrame?: number
    pressed: Promise<boolean>
    chain: Promise<unknown>
  }>())
  const liveRef = useRef<HTMLImageElement>(null)
  const liveCanvasRef = useRef<HTMLDivElement>(null)
  const topLiveRef = useRef<HTMLImageElement>(null)
  const bottomLiveRef = useRef<HTMLImageElement>(null)
  const topCanvasRef = useRef<HTMLDivElement>(null)
  const bottomCanvasRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const debuggerStatus = snapshot.debugger?.paused
    ? `已暂停${snapshot.debugger.reason === undefined ? '' : `：${snapshot.debugger.reason}`}`
    : snapshot.debugger?.attached
      ? '已连接'
      : '未连接'
  const run = async (operation: () => Promise<unknown>, fallback: string): Promise<unknown> => {
    try {
      const result = await operation()
      const output = result as { ok?: boolean; data?: { message?: string } }
      setError(output.ok === false ? output.data?.message ?? fallback : undefined)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }
  const runDebugger = (input: BrowserDebuggerInput) => run(() => port.debugger(sessionId, input), 'Debugger 操作需要恢复后重试。')
  const runTabs = (input: BrowserPanelTabInput) => run(() => port.tabs(sessionId, input), '浏览器标签操作需要恢复后重试。')
  const runNetwork = (input: BrowserNetworkInput) => run(() => port.network(sessionId, input), 'Network 操作需要恢复后重试。')
  const runProfile = (input: BrowserProfileInput) => run(() => port.profile(sessionId, input), 'Performance 操作需要恢复后重试。')
  const runProvider = (input: BrowserProviderInput) => run(() => port.provider(sessionId, input), 'Provider 操作需要恢复后重试。')
  const runExtensions = async (input: BrowserExtensionInput) => {
    // alpha1连接层在同一面板长RPC未完成时继续发送Snapshot会触发React更新深度错误。先暂停后续轮询并等待已经在途的Snapshot结束，保证扩展变更RPC独占该面板连接；操作结束后立即唤醒一次刷新。
    extensionRpcActive.current = true
    setExtensionBusy(true)
    try {
      await extensionSnapshotSettled.current
      return await run(() => port.extensions(sessionId, input), '浏览器扩展操作需要恢复后重试。')
    } finally {
      extensionRpcActive.current = false
      setExtensionBusy(false)
      wakeExtensionSnapshot.current?.()
    }
  }
  const openExtensionMenu = async () => {
    setExtensionMenuOpen(true)
    setExtensionMenuLoading(true)
    try {
      const result = await run(() => port.extensions(sessionId, { action: 'list' }), '浏览器扩展列表需要恢复后重试。')
      const output = result as { ok?: boolean; data?: { extensions?: BrowserExtensionSummary[] } } | undefined
      if (output?.ok === true) setExtensionMenuItems(output.data?.extensions ?? [])
    } finally {
      setExtensionMenuLoading(false)
    }
  }
  const openExtensionPopup = async (extensionId: string) => {
    setExtensionMenuOpen(false)
    const result = await runExtensions({ action: 'open_popup', extensionId })
    const output = result as { ok?: boolean; data?: { width?: number } } | undefined
    if (output?.ok !== true) return
    const shell = browserShellRef.current
    const width = Math.min(Math.max(output.data?.width ?? 420, 240), 600)
    const available = shell?.getBoundingClientRect().width ?? width + 36
    setExtensionPopupPosition({ x: Math.max(Math.round((available - width) / 2), 8), y: 18 })
  }
  const beginExtensionPopupDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const shell = browserShellRef.current
    const windowElement = extensionPopupWindowRef.current
    if (shell === null || windowElement === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const initial = extensionPopupPosition
    const move = (pointer: PointerEvent) => {
      const shellRect = shell.getBoundingClientRect()
      const windowRect = windowElement.getBoundingClientRect()
      const x = Math.min(Math.max(initial.x + pointer.clientX - startX, 0), Math.max(shellRect.width - windowRect.width, 0))
      const y = Math.min(Math.max(initial.y + pointer.clientY - startY, 0), Math.max(shellRect.height - windowRect.height, 0))
      setExtensionPopupPosition({ x: Math.round(x), y: Math.round(y) })
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }
  const runEmulate = (input: BrowserEmulateInput) => run(() => port.emulate(sessionId, input), 'Emulation 操作需要恢复后重试。')
  const runLiveView = (input: BrowserLiveViewInput) => run(() => port.liveView(sessionId, input), '实况显示模式切换需要恢复后重试。')
  const runSplitView = (input: BrowserSplitViewInput) => run(() => port.splitView(sessionId, input), '浏览器上下分屏操作需要恢复后重试。')
  const runTakeover = (input: BrowserTakeoverInput) => run(() => port.takeover(sessionId, input), '接管操作需要恢复后重试。')
  const runRecorder = (input: BrowserRecorderInput) => run(() => port.recorder(sessionId, input), 'Recorder 操作需要恢复后重试。')
  const runInput = async (input: UntracedBrowserUserInput, clientRawAt = Date.now()) => {
    const trace = {
      inputTraceId: `client-${sessionId}-${clientRawAt}-${nextInputTrace.current++}`,
      clientRawAt,
      clientNormalizedAt: Date.now(),
    }
    const action = input.action === 'insert_text'
      ? 'insert-text'
      : input.action === 'composition_commit'
        ? 'composition'
        : input.action === 'key_press'
          ? 'key-press'
          : input.action === 'paste'
            ? 'paste'
            : input.action === 'mouse_wheel'
              ? 'wheel'
              : 'pointer'
    const metadata: BrowserInputTraceUpdate = {
      inputTraceId: trace.inputTraceId,
      viewId: input.viewId,
      action: input.action === 'key_press' && input.composing === true ? 'composition' : action,
      sensitivity: 'normal',
      composing: input.composing ?? false,
      stage: 'client-normalized',
      timestamp: trace.clientNormalizedAt,
      outcome: 'observed',
    }
    pendingInputTraces.current.set(metadata.inputTraceId, metadata)
    await port.inputTrace(sessionId, metadata).then(() => pendingInputTraces.current.delete(metadata.inputTraceId), () => undefined)
    try {
      const result = await port.input(sessionId, { ...input, ...trace } as BrowserUserInput)
      const output = result as { ok?: boolean; data?: { message?: string } }
      setError(output.ok === false ? output.data?.message ?? '用户输入未发送。' : undefined)
      return result
    } catch (cause) {
      await port.inputTrace(sessionId, { ...metadata, stage: 'rpc-received', timestamp: Date.now(), outcome: 'lost', reason: 'rpc-send-failed' }).catch(() => undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }
  const activeTab = snapshot.tabs.find(item => item.viewId === snapshot.activeViewId)
  const paneSnapshot = (pane: BrowserSplitViewPane): BrowserLivePaneSnapshot | undefined => snapshot.splitView?.panes?.find(item => item.pane === pane)
  const liveIdentity = (pane?: BrowserSplitViewPane) => {
    const target = pane === undefined ? undefined : paneSnapshot(pane)
    const activeViewId = target?.viewId ?? snapshot.activeViewId
    const frame = target?.frame ?? snapshot.frame
    if (activeViewId === undefined || frame === undefined) return undefined
    return { viewId: activeViewId, streamGeneration: frame.streamGeneration, frameSequence: frame.sequence, viewportGeneration: frame.viewportGeneration }
  }
  const diagnosticOverlay = (frame: NonNullable<BrowserPanelSnapshot['frame']>, viewId: string) => {
    const inspect = snapshot.diagnostic?.latestInspect
    if (inspect === undefined || inspect.viewId !== viewId) return null
    // Inspect几何与Screencast都使用真实Viewport像素。SVG复用同一ViewBox和contain缩放后，目标框与画面黑边会保持一致；样式必须禁止pointer-events，避免高亮层截获人工接管的鼠标、滚轮和拖拽输入。
    return <svg className={css.diagnosticOverlay} viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {inspect.target.box !== undefined && <rect className={css.diagnosticTarget} x={inspect.target.box.x} y={inspect.target.box.y} width={inspect.target.box.width} height={inspect.target.box.height} />}
      {inspect.occluder !== undefined && <rect className={css.diagnosticOccluder} x={inspect.occluder.box.x} y={inspect.occluder.box.y} width={inspect.occluder.box.width} height={inspect.occluder.box.height} />}
    </svg>
  }
  const point = (clientX: number, clientY: number, pane?: BrowserSplitViewPane, clamp = false): { x: number; y: number } | undefined => {
    const image = pane === 'top' ? topLiveRef.current : pane === 'bottom' ? bottomLiveRef.current : liveRef.current
    const frame = pane === undefined ? snapshot.frame : paneSnapshot(pane)?.frame
    if (image === null || frame === undefined) return undefined
    const rect = image.getBoundingClientRect()
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    const width = frame.width * scale
    const height = frame.height * scale
    const left = rect.left + (rect.width - width) / 2
    const top = rect.top + (rect.height - height) / 2
    if (!clamp && (clientX < left || clientX >= left + width || clientY < top || clientY >= top + height)) return undefined
    return {
      x: Math.min(Math.max((clientX - left) / scale, 0), Math.max(frame.width - 1, 0)),
      y: Math.min(Math.max((clientY - top) / scale, 0), Math.max(frame.height - 1, 0)),
    }
  }
  const focusImeProxy = (clientX: number, clientY: number, pane?: BrowserSplitViewPane) => {
    const panel = livePanelRef.current
    const proxy = imeProxyRef.current
    if (panel === null || proxy === null) return
    const rect = panel.getBoundingClientRect()
    // 输入代理只有1px且不接收鼠标事件；把真实DOM光标放到最近点击点可让系统输入法候选窗靠近远端网页输入框，同时不会覆盖或改变实况布局。
    proxy.style.left = `${Math.min(Math.max(clientX - rect.left, 0), Math.max(rect.width - 1, 0))}px`
    proxy.style.top = `${Math.min(Math.max(clientY - rect.top, 0), Math.max(rect.height - 1, 0))}px`
    imePaneRef.current = pane
    proxy.focus({ preventScroll: true })
  }
  const modifiersOf = (event: React.KeyboardEvent): Array<'Control' | 'Alt' | 'Shift' | 'Meta'> => [
    ...(event.ctrlKey ? ['Control' as const] : []),
    ...(event.altKey ? ['Alt' as const] : []),
    ...(event.shiftKey ? ['Shift' as const] : []),
    ...(event.metaKey ? ['Meta' as const] : []),
  ]
  const sendKey = (event: React.KeyboardEvent, pane?: BrowserSplitViewPane) => {
    if (snapshot.control?.owner !== 'user') return
    // Ctrl+V和Win+V必须留给当前Windows/DSH页面产生真实PasteEvent；插件只接收用户最终选中的内容，不读取或枚举系统剪贴板历史。
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
    event.stopPropagation()
    if (event.nativeEvent.isComposing || compositionActive.current || event.key === 'Process' || event.key === 'Dead') return
    event.preventDefault()
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return
    const identity = liveIdentity(pane)
    if (identity !== undefined) void runInput({ action: 'key_press', key: event.key, modifiers: modifiersOf(event), ...identity })
  }
  const commitImeText = (text: string, composing = false) => {
    if (text === '' || snapshot.control?.owner !== 'user') return
    const identity = liveIdentity(imePaneRef.current)
    // Composition 结束不能退化成普通 insert_text，否则远端页面只能看到最终 InputEvent，无法观察
    // compositionstart/update/end。内部 composition_commit 仍复用现有输入 RPC 和 Trace，不增加模型工具。
    if (identity !== undefined) void runInput({ action: composing ? 'composition_commit' : 'insert_text', text, composing, ...identity })
  }
  const encodeClipboardFile = async (file: File): Promise<{ name: string; mediaType: string; data: string }> => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
    }
    return { name: file.name || 'clipboard.bin', mediaType: file.type || 'application/octet-stream', data: btoa(binary) }
  }
  const pasteClipboard = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (snapshot.control?.owner !== 'user') return
    const identity = liveIdentity(imePaneRef.current)
    if (identity === undefined) return
    const clipboard = event.clipboardData
    const files = [...clipboard.files]
    const text = clipboard.getData('text/plain') || undefined
    const html = clipboard.getData('text/html') || undefined
    const uriList = clipboard.getData('text/uri-list') || undefined
    const textBytes = new TextEncoder().encode(`${text ?? ''}${html ?? ''}${uriList ?? ''}`).byteLength
    const fileBytes = files.reduce((total, file) => total + file.size, 0)
    if (files.length > 8 || files.some(file => file.size > 8 * 1024 * 1024) || textBytes + fileBytes > 16 * 1024 * 1024) {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.value = ''
      setError('剪贴板内容超过限制：最多 8 个文件、单个文件 8MB、总计 16MB。')
      return
    }
    if (text === undefined && html === undefined && uriList === undefined && files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    suppressNextBeforeInput.current = true
    event.currentTarget.value = ''
    try {
      const encodedFiles = await Promise.all(files.map(encodeClipboardFile))
      await runInput({ action: 'paste', ...(text === undefined ? {} : { text }), ...(html === undefined ? {} : { html }), ...(uriList === undefined ? {} : { uriList }), ...(encodedFiles.length === 0 ? {} : { files: encodedFiles }), ...identity })
    } finally {
      window.setTimeout(() => { suppressNextBeforeInput.current = false }, 0)
    }
  }
  const pointerButton = (button: number): 'left' | 'middle' | 'right' | undefined => button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : undefined
  const flushPointerMove = (pointerId: number) => {
    const gesture = pointerGestures.current.get(pointerId)
    if (gesture === undefined) return
    gesture.animationFrame = undefined
    const target = gesture.latest
    gesture.latest = undefined
    if (target === undefined) return
    gesture.last = target
    // 输入RPC返回ok=false时Promise仍会正常完成，因此移动前必须显式检查按下结果；否则一次失败按下会继续制造无活动手势错误。
    gesture.chain = gesture.chain.then(async () => {
      if (!await gesture.pressed) return undefined
      return runInput({ action: 'mouse_move', ...target, ...gesture.identity })
    })
  }
  const livePointerHandlers = (pane?: BrowserSplitViewPane) => ({
    onPointerDown: (event: React.PointerEvent<HTMLImageElement>) => {
      if (snapshot.control?.owner !== 'user' || shareDragArmed) return
      const button = pointerButton(event.button)
      const target = point(event.clientX, event.clientY, pane)
      const identity = liveIdentity(pane)
      if (button === undefined || target === undefined || identity === undefined) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      if (button === 'left') focusImeProxy(event.clientX, event.clientY, pane)
      const pressed = runInput({ action: 'mouse_down' as const, ...target, ...identity, button, clickCount: Math.min(Math.max(event.detail || 1, 1), 3) })
        .then(result => (result as { ok?: boolean } | undefined)?.ok === true)
      const gesture = {
        identity,
        pane,
        last: target,
        pressed,
        chain: pressed,
      }
      pointerGestures.current.set(event.pointerId, gesture)
    },
    onPointerMove: (event: React.PointerEvent<HTMLImageElement>) => {
      const gesture = pointerGestures.current.get(event.pointerId)
      if (gesture === undefined) return
      const target = point(event.clientX, event.clientY, gesture.pane, true)
      if (target === undefined) return
      event.preventDefault()
      event.stopPropagation()
      gesture.latest = target
      if (gesture.animationFrame === undefined) gesture.animationFrame = requestAnimationFrame(() => { flushPointerMove(event.pointerId) })
    },
    onPointerUp: (event: React.PointerEvent<HTMLImageElement>) => {
      const gesture = pointerGestures.current.get(event.pointerId)
      if (gesture === undefined) return
      event.preventDefault()
      event.stopPropagation()
      if (gesture.animationFrame !== undefined) cancelAnimationFrame(gesture.animationFrame)
      const target = point(event.clientX, event.clientY, gesture.pane, true) ?? gesture.latest ?? gesture.last
      const pending = gesture.latest
      pointerGestures.current.delete(event.pointerId)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      gesture.chain = gesture.chain.then(async () => {
        if (!await gesture.pressed) return undefined
        if (pending !== undefined) await runInput({ action: 'mouse_move', ...pending, ...gesture.identity })
        return runInput({ action: 'mouse_up', ...target, ...gesture.identity })
      })
    },
    onPointerCancel: (event: React.PointerEvent<HTMLImageElement>) => {
      const gesture = pointerGestures.current.get(event.pointerId)
      if (gesture === undefined) return
      if (gesture.animationFrame !== undefined) cancelAnimationFrame(gesture.animationFrame)
      pointerGestures.current.delete(event.pointerId)
      gesture.chain = gesture.chain.then(async () => {
        if (!await gesture.pressed) return undefined
        return runInput({ action: 'mouse_up', ...gesture.last, ...gesture.identity })
      })
    },
    onContextMenu: (event: React.MouseEvent<HTMLImageElement>) => {
      if (snapshot.control?.owner === 'user') event.preventDefault()
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => { sendKey(event, pane) },
  })
  const addBreakpoint = async () => {
    const line = Number(breakpointLine)
    if (breakpointUrl.trim() === '') {
      setError('请输入完整的脚本 URL。')
      return
    }
    if (!Number.isInteger(line) || line < 1) {
      setError('断点行号必须是大于或等于 1 的整数。')
      return
    }
    // 用户界面使用编辑器常见的一基行号，CDP Debugger.setBreakpointByUrl 使用零基行号，转换只发生在 Client 输入边界。
    await runDebugger({ action: 'set_breakpoint', url: breakpointUrl.trim(), lineNumber: line - 1 })
  }
  useEffect(() => {
    let disposed = false
    let sequence = 0
    let activeViewId: string | undefined
    let streamGeneration = -1
    let viewportGeneration = -1
    const splitCursors: Partial<Record<BrowserSplitViewPane, BrowserFrameCursor>> = {}
    let popupCursor: BrowserFrameCursor | undefined
    let diagnosticReadSequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let idleDelay = 50
    const refresh = async () => {
      let nextDelay = view === 'live' ? idleDelay : 500
      try {
        if (extensionRpcActive.current) {
          // 扩展变更可能包含商店下载和Persistent Context重建，耗时远高于普通面板RPC。暂停期间不轮询、不排队，只等待操作结束后的单次唤醒，避免alpha1连接层同时维护两个未完成调用。
          await new Promise<void>(resolve => { wakeExtensionSnapshot.current = resolve })
          wakeExtensionSnapshot.current = undefined
          if (disposed) return
        }
        const snapshotRequest = port.snapshot(sessionId, view, streamGeneration < 0 ? undefined : streamGeneration, sequence, splitCursors, popupCursor, view === 'diagnostic' ? diagnosticReadSequence : undefined)
        extensionSnapshotSettled.current = snapshotRequest.then(() => {}, () => {})
        const next = await snapshotRequest
        if (disposed) return
        const receivedFrame = next.frame !== undefined || (next.splitView?.panes ?? []).some(item => item.frame !== undefined) || next.extensionPopup?.frame !== undefined
        if (view === 'live' || next.extensionPopup !== undefined) {
          // 动画页收到新帧后以约30FPS继续拉取；静态页连续无新帧时逐步退避，避免固定高频空RPC占用连接和React调度。
          idleDelay = receivedFrame ? 50 : Math.min(Math.max(Math.round(idleDelay * 1.6), 50), 180)
          nextDelay = receivedFrame ? 33 : idleDelay
        }
        const viewChanged = next.activeViewId !== activeViewId
        const streamChanged = next.frame !== undefined && next.frame.streamGeneration !== streamGeneration
        const viewportChanged = next.liveView?.viewportGeneration !== viewportGeneration
        if (viewChanged) {
          activeViewId = next.activeViewId
          sequence = next.frame?.sequence ?? 0
        } else if (streamChanged || viewportChanged) {
          sequence = next.frame?.sequence ?? 0
        } else if (next.frame !== undefined) {
          sequence = next.frame.sequence
        }
        viewportGeneration = next.liveView?.viewportGeneration ?? -1
        if (next.frame !== undefined) streamGeneration = next.frame.streamGeneration
        for (const pane of next.splitView?.panes ?? []) {
          if (pane.frame !== undefined) splitCursors[pane.pane] = { streamGeneration: pane.frame.streamGeneration, sequence: pane.frame.sequence }
        }
        if (next.extensionPopup?.frame !== undefined) popupCursor = { streamGeneration: next.extensionPopup.frame.streamGeneration, sequence: next.extensionPopup.frame.sequence }
        // 首次进入诊断视图先展示Host返回的未读数量，下一轮才回传已经成功渲染的最新序列；这样用户能看到真实未读状态，同时不会因一次请求失败提前确认未读。
        if (view === 'diagnostic') diagnosticReadSequence = next.diagnostic?.unread.latestSequence ?? diagnosticReadSequence
        setSnapshot(previous => {
          // Host 对未变化帧只返回增量数据；同一活动 View 必须保留上一帧，View 改变或 Session 不可用时则清除旧图。
          let mergedSnapshot = next

          if (view === 'live' && next.available && !viewChanged && !streamChanged && !viewportChanged && next.frame === undefined && previous.frame !== undefined) {
            mergedSnapshot = { ...mergedSnapshot, frame: previous.frame }
          } else if (view === 'live' && next.frame !== undefined && previous.frame !== undefined && !viewChanged && !streamChanged && !viewportChanged && next.frame.sequence < previous.frame.sequence) {
            mergedSnapshot = { ...mergedSnapshot, frame: previous.frame }
          }

          if (view === 'live' && next.splitView?.enabled) {
            // Host 对每个窗格分别做帧增量；未返回新 JPEG 时必须保留该窗格上一帧，不能让另一窗格更新导致本窗格闪空。
            const previousPanes = new Map((previous.splitView?.panes ?? []).map(item => [item.pane, item]))
            mergedSnapshot = {
              ...mergedSnapshot,
              splitView: {
                ...next.splitView,
                panes: (next.splitView.panes ?? []).map(item => item.frame === undefined && previousPanes.get(item.pane)?.viewId === item.viewId
                  ? { ...item, frame: previousPanes.get(item.pane)?.frame }
                  : item),
              },
            }
          }

          if (next.extensionPopup !== undefined && next.extensionPopup.frame === undefined && previous.extensionPopup?.viewId === next.extensionPopup.viewId && previous.extensionPopup.frame !== undefined) {
            mergedSnapshot = {
              ...mergedSnapshot,
              extensionPopup: {
                ...next.extensionPopup,
                frame: previous.extensionPopup.frame,
              },
            }
          }

          return mergedSnapshot
        })
        // 周期快照成功只代表状态读取正常，不能据此清除上一次明确操作的错误；错误仅在后续操作成功或用户手动关闭时消失。
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause))
          nextDelay = view === 'live' ? 180 : 500
        }
      } finally {
        if (!disposed) timer = setTimeout(() => { void refresh() }, nextDelay)
      }
    }
    void refresh()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      wakeExtensionSnapshot.current?.()
      wakeExtensionSnapshot.current = undefined
      // 视图切换和 Session 卸载可能晚于 Controller 退出；旧 close 被 Host 安全拒绝时
      // 只需结束本地轮询，不能把尽力清理升级为页面未处理拒绝。
      void port.close(sessionId, view).catch(() => {})
    }
  }, [port, sessionId, view])
  useEffect(() => {
    if (snapshot.extensionPopup === undefined) return
    const shell = browserShellRef.current
    const windowElement = extensionPopupWindowRef.current
    if (shell === null || windowElement === null) return
    const clamp = () => {
      const shellRect = shell.getBoundingClientRect()
      const windowRect = windowElement.getBoundingClientRect()
      setExtensionPopupPosition(previous => {
        const x = Math.min(Math.max(previous.x, 0), Math.max(shellRect.width - windowRect.width, 0))
        const y = Math.min(Math.max(previous.y, 0), Math.max(shellRect.height - windowRect.height, 0))
        const next = { x: Math.round(x), y: Math.round(y) }
        return next.x === previous.x && next.y === previous.y ? previous : next
      })
    }
    const observer = new ResizeObserver(clamp)
    observer.observe(shell)
    observer.observe(windowElement)
    clamp()
    return () => { observer.disconnect() }
  }, [snapshot.extensionPopup?.viewId])
  useEffect(() => {
    if (view !== 'live' || !snapshot.available) return
    const hostRatio = snapshot.splitView?.ratio ?? 0.5
    // 拖动内部横向分界线时只改变本地Grid；Host确认最终比例后再同步两个真实Viewport，避免拖动过程产生RPC洪泛。
    if (snapshot.splitView?.enabled && Math.abs(splitRatio - hostRatio) > 0.001) return
    const canvases = snapshot.splitView?.enabled
      ? [{ pane: 'top' as const, element: topCanvasRef.current }, { pane: 'bottom' as const, element: bottomCanvasRef.current }]
      : [{ pane: undefined, element: liveCanvasRef.current }]
    if (canvases.some(item => item.element === null)) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let initialized = false
    const previous = new Map<string, { width: number; height: number }>()
    const measure = (pane: BrowserSplitViewPane | undefined, canvas: HTMLDivElement) => {
      const rect = canvas.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      const visible = rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth + 1
        && rect.bottom <= window.innerHeight + 1
      const key = pane ?? 'single'
      const before = previous.get(key)
      const minimumHeight = pane === undefined ? 240 : 120
      if (!visible || width < 320 || height < minimumHeight || (before !== undefined && Math.abs(width - before.width) < 2 && Math.abs(height - before.height) < 2)) return undefined
      previous.set(key, { width, height })
      return { pane, width, height }
    }
    const applySizes = async () => {
      for (const item of canvases) {
        if (disposed) return
        const size = measure(item.pane, item.element as HTMLDivElement)
        if (size === undefined) continue
        if (size.pane !== undefined) {
          // 上下窗格必须按顺序完成Viewport更新，第一侧响应引发的渲染不能打断第二侧上报。
          await runSplitView({ action: 'resize', pane: size.pane, width: size.width, height: size.height })
        } else if (!initialized) {
        initialized = true
          await runLiveView({ action: 'initialize', mode: liveViewPreference(), width: size.width, height: size.height })
        } else {
          await runLiveView({ action: 'resize', width: size.width, height: size.height })
        }
      }
    }
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { if (!disposed) void applySizes() }, 180)
    })
    for (const item of canvases) observer.observe(item.element as HTMLDivElement)
    timer = setTimeout(() => { if (!disposed) void applySizes() }, 180)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    }
  // 分屏比例改变会同时改变上下两个画布；把 ratio 纳入依赖可在 Grid 稳定后重新测量两侧，避免早期回调只上报先达到有效尺寸的一个窗格。
  }, [port, sessionId, view, snapshot.available, snapshot.splitView?.enabled, snapshot.splitView?.ratio, splitRatio])
  useEffect(() => {
    // 地址栏只跟随活动标签变化，不在轮询到相同标签时反复覆盖用户正在编辑但尚未提交的文本。
    setAddress(activeTab?.url ?? '')
  }, [snapshot.activeViewId, activeTab?.url])
  useEffect(() => {
    setSplitRatio(snapshot.splitView?.ratio ?? 0.5)
  }, [snapshot.splitView?.ratio])
  useEffect(() => {
    // 一次性画面分享属于人工接管操作；控制权归还模型或接管状态失效时立即撤销尚未消费的拖拽授权。
    if (snapshot.control?.owner !== 'user') {
      setShareDragArmed(false)
      imeProxyRef.current?.blur()
      for (const gesture of pointerGestures.current.values()) {
        if (gesture.animationFrame !== undefined) cancelAnimationFrame(gesture.animationFrame)
      }
      pointerGestures.current.clear()
    }
  }, [snapshot.control?.owner])
  const switchLiveView = async (mode: BrowserLiveViewMode) => {
    const canvas = liveCanvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const result = await runLiveView({
      action: mode,
      ...(snapshot.activeViewId === undefined ? {} : { viewId: snapshot.activeViewId }),
      ...(mode === 'adaptive' && rect !== undefined ? { width: Math.round(rect.width), height: Math.round(rect.height) } : {}),
      notifyAgent: true,
    }) as { ok?: boolean } | undefined
    if (result?.ok === true) saveLiveViewPreference(mode)
  }
  const navigateAddress = async () => {
    if (snapshot.activeViewId === undefined || address.trim() === '') return
    await runTabs({ action: 'navigate', viewId: snapshot.activeViewId, url: address.trim() })
  }
  const requestExtensionMutation = (input: Omit<BrowserExtensionInput, 'applyMode'>) => {
    // DSH alpha1 会把原生window.confirm桥接为非布尔对象并触发React #185，因此扩展写操作必须先进入插件自己的面板内确认层，不能调用宿主原生Dialog。
    setPendingExtensionInput(input)
  }
  const popupPoint = (clientX: number, clientY: number, clamp = false): { x: number; y: number } | undefined => {
    const image = extensionPopupRef.current
    const frame = snapshot.extensionPopup?.frame
    if (image === null || frame === undefined) return undefined
    const rect = image.getBoundingClientRect()
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
    const width = frame.width * scale
    const height = frame.height * scale
    const left = rect.left + (rect.width - width) / 2
    const top = rect.top + (rect.height - height) / 2
    if (!clamp && (clientX < left || clientX >= left + width || clientY < top || clientY >= top + height)) return undefined
    return { x: Math.min(Math.max((clientX - left) / scale, 0), Math.max(frame.width - 1, 0)), y: Math.min(Math.max((clientY - top) / scale, 0), Math.max(frame.height - 1, 0)) }
  }
  const popupIdentity = () => {
    const popup = snapshot.extensionPopup
    const frame = popup?.frame
    if (popup === undefined || frame === undefined) return undefined
    return { viewId: popup.viewId, streamGeneration: frame.streamGeneration, frameSequence: frame.sequence, viewportGeneration: frame.viewportGeneration }
  }
  const confirmExtensionMutation = async (applyMode: NonNullable<BrowserExtensionInput['applyMode']>) => {
    const input = pendingExtensionInput
    if (input === undefined) return
    setPendingExtensionInput(undefined)
    await runExtensions({ ...input, applyMode })
  }
  const beginSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = splitContainerRef.current
    if (container === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (pointer: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      setSplitRatio(Math.min(Math.max((pointer.clientY - rect.top) / Math.max(rect.height, 1), 0.4), 0.6))
    }
    const finish = (pointer: PointerEvent) => {
      move(pointer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      const rect = container.getBoundingClientRect()
      const ratio = Math.min(Math.max((pointer.clientY - rect.top) / Math.max(rect.height, 1), 0.4), 0.6)
      // 拖动期间只更新本地 Grid，松开后提交一次最终比例，避免连续重建两个真实浏览器 Viewport造成卡顿。
      void runSplitView({ action: 'ratio', ratio, notifyAgent: true })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }
  const adjustSplitByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let ratio = splitRatio
    if (event.key === 'ArrowUp') ratio = Math.min(ratio + 0.02, 0.6)
    else if (event.key === 'ArrowDown') ratio = Math.max(ratio - 0.02, 0.4)
    else if (event.key === 'Home') ratio = 0.4
    else if (event.key === 'End') ratio = 0.6
    else return
    event.preventDefault()
    setSplitRatio(ratio)
    void runSplitView({ action: 'ratio', ratio, notifyAgent: true })
  }
  const livePane = (pane: BrowserSplitViewPane) => {
    const paneState = paneSnapshot(pane)
    const imageRef = pane === 'top' ? topLiveRef : bottomLiveRef
    const canvasRef = pane === 'top' ? topCanvasRef : bottomCanvasRef
    const fullLabel = pane === 'top' ? '上方网页' : '下方网页'
    return <div className={css.livePane} data-focused={paneState?.focused || undefined} aria-label={`${fullLabel}${paneState?.focused ? '，当前焦点' : '，点击画面切换焦点'}`}>
      <div ref={canvasRef} className={css.liveCanvas} onPointerDown={() => { if (paneState?.focused !== true) void runSplitView({ action: 'focus', pane, notifyAgent: true }) }}>
        {paneState?.frame === undefined
          ? <div className={css.empty}>等待{fullLabel}实况帧</div>
          : <img
            ref={imageRef}
            className={css.live}
            src={`data:${paneState.frame.mediaType};base64,${paneState.frame.data}`}
            alt={`${fullLabel}实况`}
            draggable={shareDragArmed}
            tabIndex={snapshot.control?.owner === 'user' ? 0 : -1}
            data-takeover={snapshot.control?.owner === 'user' || undefined}
            data-share-drag={shareDragArmed || undefined}
            onDragStart={event => {
              // 默认禁止实况图片拖动；只有用户在控制面板显式武装一次分享后，才保留浏览器原生Files拖放链供DSH附件模块接收。
              if (!shareDragArmed) {
                event.preventDefault()
                event.stopPropagation()
                return
              }
              suppressSharedFrameClick.current = true
            }}
            onDragEnd={() => {
              // 成功放下和中途取消都会消费本次分享授权，下一次拖动必须重新由用户显式开启。
              setShareDragArmed(false)
              window.setTimeout(() => { suppressSharedFrameClick.current = false }, 0)
            }}
            {...livePointerHandlers(pane)}
            onWheel={event => {
              if (snapshot.control?.owner !== 'user') return
              event.preventDefault()
              const target = point(event.clientX, event.clientY, pane)
              const identity = liveIdentity(pane)
              const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(paneState.liveView.height, 1) : 1
              if (target !== undefined && identity !== undefined) void runInput({ action: 'mouse_wheel', ...target, ...identity, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit })
            }}
          />}
        {paneState?.frame === undefined || paneState.viewId === undefined ? null : diagnosticOverlay(paneState.frame, paneState.viewId)}
      </div>
    </div>
  }
  return (
    <section className={css.panel} data-live={view === 'live' || undefined}>
      {view !== 'live' && <header className={css.panelHeader}><strong>{viewLabels[view]}</strong><span>{view === 'extensions' && <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined} aria-label="返回浏览器实况" title={extensionBusy ? '扩展操作完成后可返回实况' : pendingExtensionInput !== undefined ? '请先完成或取消扩展确认' : '返回浏览器实况'} onClick={() => { onViewChange('live') }}>返回实况</button>}<button type="button" disabled={view === 'extensions' && (extensionBusy || pendingExtensionInput !== undefined)} aria-label="关闭右侧浏览器" title={view === 'extensions' && extensionBusy ? '扩展操作完成后可关闭右侧浏览器' : view === 'extensions' && pendingExtensionInput !== undefined ? '请先完成或取消扩展确认' : '关闭右侧浏览器'} onClick={onClose}>×</button></span></header>}
      <div ref={browserShellRef} className={css.browserShell}>
        {extensionBusy && <div className={css.extensionBusyOverlay} role="status" aria-live="polite">正在处理浏览器扩展，请等待操作完成。</div>}
        {pendingExtensionInput !== undefined && <div className={css.extensionConfirmOverlay} role="dialog" aria-modal="true" aria-labelledby="browser-extension-confirm-title" onKeyDown={event => { if (event.key === 'Escape') setPendingExtensionInput(undefined) }}>
          <div className={css.extensionConfirmDialog}>
            <strong id="browser-extension-confirm-title">确认浏览器扩展变更</strong>
            <span>{pendingExtensionInput.action === 'apply' ? '立即应用待生效扩展会重启当前 Session 的浏览器并恢复标签网址。' : '请选择扩展变更的生效时间。立即生效会重启当前 Session 的浏览器并恢复标签网址；下次启动生效不会中断当前网页。'}</span>
            <span>重启可能丢失未提交表单、页面内存和临时 JavaScript 状态。</span>
            <div className={css.extensionConfirmActions}>
              {pendingExtensionInput.action !== 'apply' && <button type="button" onClick={() => { void confirmExtensionMutation('next_start') }}>下次启动生效</button>}
              <button type="button" onClick={() => { void confirmExtensionMutation('now') }}>{pendingExtensionInput.action === 'apply' ? '立即应用' : '立即生效'}</button>
              <button type="button" autoFocus onClick={() => { setPendingExtensionInput(undefined) }}>取消</button>
            </div>
          </div>
        </div>}
        {error !== undefined && <div className={css.errorMessage} role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭浏览器错误提示" onClick={() => { setError(undefined) }}>×</button>
        </div>}
        <div className={css.tabBar}>
          <div className={css.tabList} role="tablist" aria-label="浏览器标签">
            {snapshot.tabs.map(item => <div className={css.tab} data-active={item.active || undefined} key={item.viewId} title={`${item.title || '新标签页'}\n${item.url}`}>
              <button type="button" role="tab" aria-selected={item.active} className={css.tabSelect} onClick={() => { void runTabs({ action: 'select', viewId: item.viewId, notifyAgent: true }) }}>
                <span>{item.title || (item.url === 'about:blank' ? '新标签页' : item.url)}</span>
              </button>
              <button type="button" className={css.tabClose} aria-label={`关闭标签 ${item.title || item.url}`} onClick={() => { void runTabs({ action: 'close', viewId: item.viewId }) }}>×</button>
            </div>)}
          </div>
          <button type="button" className={css.newTab} aria-label="新建浏览器标签" onClick={() => { void runTabs({ action: 'new' }) }}>+</button>
        </div>
        <form className={css.navigationBar} onSubmit={event => { event.preventDefault(); void navigateAddress() }}>
          <button type="button" aria-label="后退" disabled={snapshot.activeViewId === undefined} onClick={() => { if (snapshot.activeViewId !== undefined) void runTabs({ action: 'back', viewId: snapshot.activeViewId }) }}>←</button>
          <button type="button" aria-label="前进" disabled={snapshot.activeViewId === undefined} onClick={() => { if (snapshot.activeViewId !== undefined) void runTabs({ action: 'forward', viewId: snapshot.activeViewId }) }}>→</button>
          <button type="button" aria-label="刷新" disabled={snapshot.activeViewId === undefined} onClick={() => { if (snapshot.activeViewId !== undefined) void runTabs({ action: 'reload', viewId: snapshot.activeViewId }) }}>↻</button>
          <input value={address} disabled={snapshot.activeViewId === undefined} aria-label="浏览器地址" placeholder={snapshot.activeViewId === undefined ? '请先新建标签' : '输入网址'} onChange={event => setAddress(event.currentTarget.value)} />
        </form>
        <div className={css.browserContent}>
      {!snapshot.available && <div className={css.message}>{snapshot.message ?? '当前会话尚未创建托管浏览器。'}</div>}
      {snapshot.available && snapshot.tabs.length === 0 && view !== 'extensions' && <div className={css.message}>{snapshot.message ?? '当前没有浏览器标签，请点击 + 新建标签。'}</div>}
      {view === 'live' && snapshot.available && snapshot.activeViewId !== undefined && <div ref={livePanelRef} className={css.livePanel}>
        <textarea
          ref={imeProxyRef}
          className={css.imeProxy}
          aria-label="浏览器输入法代理"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={event => {
            // alpha1 Web对空格只产生keydown而不产生beforeinput；只对无修饰、非组合的Space直接提交文本，其余普通字符继续由beforeinput统一覆盖英文、Shift符号和各类输入法。
            if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && !compositionActive.current && (event.key === ' ' || event.code === 'Space')) {
              event.preventDefault()
              event.stopPropagation()
              commitImeText(' ')
              event.currentTarget.value = ''
              return
            }
            if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) return
            sendKey(event, imePaneRef.current)
          }}
          onCompositionStart={() => {
            compositionActive.current = true
            suppressNextBeforeInput.current = false
          }}
          onCompositionEnd={event => {
            compositionActive.current = false
            suppressNextBeforeInput.current = true
            commitImeText(event.data, true)
            event.currentTarget.value = ''
            window.setTimeout(() => { suppressNextBeforeInput.current = false }, 0)
          }}
          onPaste={event => { void pasteClipboard(event) }}
          onBeforeInput={event => {
            const input = event.nativeEvent as InputEvent
            if (compositionActive.current || input.isComposing || input.inputType === 'insertCompositionText') return
            if (suppressNextBeforeInput.current) {
              suppressNextBeforeInput.current = false
              event.preventDefault()
              event.currentTarget.value = ''
              return
            }
            // alpha1 Web桥可能保留字符data但丢失inputType；非组合状态下把缺失类型视为普通文本，仍排除删除、粘贴和组合更新等明确类型。
            const inputType = typeof input.inputType === 'string' ? input.inputType : ''
            if ((inputType !== '' && inputType !== 'insertText') || input.data === null || input.data === '') return
            event.preventDefault()
            commitImeText(input.data)
            event.currentTarget.value = ''
          }}
        />
        <details className={css.liveControls}>
          <summary>实况控制</summary>
          <div className={css.liveControlPanel}>
            <div className={css.liveControlStatus}>
              <span>{snapshot.control?.owner === 'user' ? '人工控制中' : '模型控制中'}</span>
              <span>{snapshot.liveView === undefined ? '等待画面尺寸' : `当前画面 ${snapshot.liveView.width}×${snapshot.liveView.height}${snapshot.liveView.reflowed ? `，重排 ${snapshot.liveView.reflowedElements}` : ''}`}</span>
              <span>{snapshot.diagnostic?.active ? `${snapshot.diagnostic.debugSession?.debugSessionId ?? 'Debug Session'} · ${snapshot.diagnostic.recording ? 'Recording' : 'Stopped'}` : '未启动 Debug Session'}</span>
              <span>{snapshot.diagnostic === undefined ? '等待诊断状态' : `${snapshot.diagnostic.currentIdentity.viewId} · D${snapshot.diagnostic.currentIdentity.documentGeneration} · ${snapshot.diagnostic.currentIdentity.navigationId}`}</span>
              <span>{snapshot.diagnostic === undefined ? '等待 Viewport' : `Viewport ${snapshot.diagnostic.currentIdentity.viewport.width}×${snapshot.diagnostic.currentIdentity.viewport.height} · DPR ${snapshot.diagnostic.currentIdentity.viewport.deviceScaleFactor}${snapshot.diagnostic.currentIdentity.viewport.mobile ? ' · Mobile' : ''}`}</span>
              <span>{snapshot.diagnostic?.synchronization.status === 'same-view' ? '页面与证据同 View' : snapshot.diagnostic?.synchronization.status === 'mismatch' ? '页面与证据身份不一致' : '暂无调试会话绑定'}</span>
              <span>{snapshot.diagnostic?.debugSession?.currentCheckpoint === undefined ? '暂无 Checkpoint' : `当前 ${snapshot.diagnostic.debugSession.currentCheckpoint.checkpointId} · ${snapshot.diagnostic.debugSession.currentCheckpoint.label}`}</span>
              <span>{snapshot.diagnostic?.unread.total === 0 ? '无未读异常' : `未读异常 ${snapshot.diagnostic?.unread.total ?? 0} · Console ${snapshot.diagnostic?.unread.consoleErrors ?? 0} · Network ${snapshot.diagnostic?.unread.failedRequests ?? 0}`}</span>
              <span>{snapshot.diagnostic === undefined ? '等待 Recorder 状态' : `Recorder ${snapshot.diagnostic.recorder.mode} · ${snapshot.diagnostic.recorder.status} · ${snapshot.diagnostic.recorder.eventCount} events · ${snapshot.diagnostic.recorder.byteSize} bytes`}</span>
            </div>
            <div className={css.liveControlActions}>
              <button type="button" aria-label="切换为标准显示" title="标准显示：固定1280×720，完整显示桌面布局" data-selected={snapshot.liveView?.mode === 'standard' || undefined} onClick={() => { void switchLiveView('standard') }}>标准显示</button>
              <button type="button" aria-label="切换为自适应显示" title="自适应显示：真实Viewport跟随可用区域" data-selected={snapshot.liveView?.mode === 'adaptive' || undefined} onClick={() => { void switchLiveView('adaptive') }}>自适应显示</button>
              <button type="button" aria-label={snapshot.splitView?.enabled ? '返回单页显示' : '开启上下双页显示'} title={snapshot.splitView?.enabled ? '关闭上下双页并保留焦点标签' : '开启上下双页显示'} onClick={() => { void runSplitView({ action: snapshot.splitView?.enabled ? 'close' : 'open', notifyAgent: true }) }}>{snapshot.splitView?.enabled ? '返回单页' : '开启双页'}</button>
              {snapshot.splitView?.enabled && <>
                <button type="button" aria-label="交换上下网页" title="交换上下网页" onClick={() => { void runSplitView({ action: 'swap', notifyAgent: true }) }}>交换上下</button>
                <button type="button" aria-label="恢复上下均分" title="恢复上下50/50均分" onClick={() => { void runSplitView({ action: 'ratio', ratio: 0.5, notifyAgent: true }) }}>恢复均分</button>
              </>}
              <button type="button" aria-label={snapshot.control?.owner === 'user' ? '归还浏览器控制权给模型' : '人工接管浏览器'} title={snapshot.control?.owner === 'user' ? '归还浏览器控制权给模型' : '人工接管；接管后点击网页并直接使用键盘'} onClick={() => { void runTakeover({ action: snapshot.control?.owner === 'user' ? 'return' : 'request' }) }}>{snapshot.control?.owner === 'user' ? '归还模型' : '人工接管'}</button>
              <button type="button" disabled={snapshot.control?.owner !== 'user'} aria-pressed={shareDragArmed} aria-label={shareDragArmed ? '取消拖拽分享画面' : '武装下一次拖拽分享画面'} title={snapshot.control?.owner !== 'user' ? '请先人工接管浏览器' : shareDragArmed ? '下一次从实况画面拖动会生成对话图片附件；拖拽结束后自动关闭' : '仅武装下一次画面拖拽，普通拖动不会生成附件'} data-selected={shareDragArmed || undefined} onClick={() => { setShareDragArmed(value => !value) }}>{shareDragArmed ? '等待拖拽画面' : '拖拽分享画面'}</button>
              <button type="button" aria-expanded={extensionMenuOpen} aria-label="使用浏览器扩展" title="打开当前 Session 中可用的扩展列表" onClick={() => { if (extensionMenuOpen) setExtensionMenuOpen(false); else void openExtensionMenu() }}>使用扩展</button>
              <button type="button" aria-label="打开扩展管理" title="打开当前 Session 的浏览器扩展管理" onClick={() => { onViewChange('extensions') }}>打开扩展管理</button>
              <button type="button" aria-label="打开诊断工作台" title="查看当前 Debug Session、Action、Checkpoint 和 Incident" onClick={() => { onViewChange('diagnostic') }}>打开诊断</button>
              {snapshot.diagnostic?.recorder.mode === 'off' && <button type="button" onClick={() => { void runRecorder({ action: 'start', mode: 'rolling' }) }}>开启 Rolling</button>}
              {snapshot.diagnostic?.recorder.mode !== 'deep' && <button type="button" onClick={() => { void runRecorder({ action: 'start', mode: 'deep' }) }}>开启 Deep</button>}
              {snapshot.diagnostic?.recorder.status === 'recording' && <button type="button" onClick={() => { void runRecorder({ action: 'pause' }) }}>暂停 Recorder</button>}
              {snapshot.diagnostic?.recorder.status === 'paused' && <button type="button" onClick={() => { void runRecorder({ action: 'resume' }) }}>继续 Recorder</button>}
              {snapshot.diagnostic?.recorder.mode !== 'off' && <button type="button" onClick={() => { void runRecorder({ action: 'mark' }) }}>刚才出问题了</button>}
              {snapshot.diagnostic?.recorder.mode !== 'off' && <button type="button" onClick={() => { void runRecorder({ action: 'clear' }) }}>清空未冻结记录</button>}
              {snapshot.diagnostic?.recorder.mode !== 'off' && <button type="button" onClick={() => { void runRecorder({ action: 'stop' }) }}>关闭 Recorder</button>}
              <button type="button" aria-label="关闭右侧浏览器" title="关闭右侧浏览器" onClick={onClose}>关闭右侧浏览器</button>
            </div>
          </div>
        </details>
        {extensionMenuOpen && <div className={css.extensionMenu} role="dialog" aria-modal="false" aria-label="可用浏览器扩展">
          <header><strong>使用扩展</strong><button type="button" aria-label="关闭扩展列表" onClick={() => { setExtensionMenuOpen(false) }}>×</button></header>
          <div className={css.extensionMenuList}>
            {extensionMenuLoading
              ? <div className={css.empty}>正在读取当前 Session 扩展</div>
              : extensionMenuItems.length === 0
                ? <div className={css.empty}>当前 Session 尚未安装扩展</div>
                : extensionMenuItems.map(item => {
                  const available = item.enabled && item.loaded && item.actionPopup !== undefined
                  return <button type="button" key={item.extensionId} disabled={!available || extensionBusy} title={available ? `打开 ${item.name}` : item.actionPopup === undefined ? '该扩展没有声明 Popup' : !item.enabled ? '该扩展已禁用' : '该扩展尚未在当前浏览器中生效'} onClick={() => { void openExtensionPopup(item.extensionId) }}>
                    <strong>{item.name}</strong>
                    <span>{available ? '可使用' : item.pendingRestart ? '等待重启生效' : item.actionPopup === undefined ? '没有 Popup' : '当前不可用'}</span>
                  </button>
                })}
          </div>
          <button type="button" className={css.extensionMenuManage} onClick={() => { setExtensionMenuOpen(false); onViewChange('extensions') }}>管理扩展</button>
        </div>}
        {snapshot.splitView?.enabled
          ? <div ref={splitContainerRef} className={css.splitLive} style={{ gridTemplateRows: `minmax(0, ${splitRatio}fr) 8px minmax(0, ${1 - splitRatio}fr)` }}>
            {livePane('top')}
            <div className={css.splitDivider} role="separator" tabIndex={0} aria-label="调整上下分屏比例" aria-orientation="horizontal" aria-valuemin={40} aria-valuemax={60} aria-valuenow={Math.round(splitRatio * 100)} onPointerDown={beginSplitResize} onKeyDown={adjustSplitByKey} />
            {livePane('bottom')}
          </div>
          : <div ref={liveCanvasRef} className={css.liveCanvas}>
          {snapshot.frame === undefined
            ? <div className={css.empty}>等待浏览器实况帧</div>
            : <img
              ref={liveRef}
              className={css.live}
              src={`data:${snapshot.frame.mediaType};base64,${snapshot.frame.data}`}
              alt="浏览器实况"
              draggable={shareDragArmed}
              tabIndex={snapshot.control?.owner === 'user' ? 0 : -1}
              data-takeover={snapshot.control?.owner === 'user' || undefined}
              data-share-drag={shareDragArmed || undefined}
              onDragStart={event => {
                // 单页与双页共用一次性授权：默认隔离原生拖拽，显式武装后只允许下一次画面进入DSH附件拖放链。
                if (!shareDragArmed) {
                  event.preventDefault()
                  event.stopPropagation()
                  return
                }
                suppressSharedFrameClick.current = true
              }}
              onDragEnd={() => {
                setShareDragArmed(false)
                window.setTimeout(() => { suppressSharedFrameClick.current = false }, 0)
              }}
              {...livePointerHandlers()}
              onWheel={event => {
                if (snapshot.control?.owner !== 'user') return
                event.preventDefault()
                const target = point(event.clientX, event.clientY)
                const identity = liveIdentity()
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(snapshot.liveView?.height ?? 720, 1) : 1
                if (target !== undefined && identity !== undefined) void runInput({ action: 'mouse_wheel', ...target, ...identity, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit })
              }}
            />}
          {snapshot.frame === undefined || snapshot.activeViewId === undefined ? null : diagnosticOverlay(snapshot.frame, snapshot.activeViewId)}
          {snapshot.diagnostic?.recorder.deepVisible && <div className={css.deepRecordingBanner} role="status">当前记录中 · Deep Recording · 可在实况控制中暂停或停止</div>}
        </div>}
      </div>}
      {view === 'diagnostic' && snapshot.available && snapshot.activeViewId !== undefined && <div className={css.diagnosticPanel}>
        <section className={css.diagnosticSummary}>
          <div><strong>Debug Session</strong><span>{snapshot.diagnostic?.debugSession?.debugSessionId ?? '未启动'}</span></div>
          <div><strong>Recording</strong><span>{snapshot.diagnostic?.recording ? '进行中' : '未进行'}</span></div>
          <div><strong>身份</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.currentIdentity.viewId} / D${snapshot.diagnostic.currentIdentity.documentGeneration} / ${snapshot.diagnostic.currentIdentity.navigationId}`}</span></div>
          <div><strong>Viewport</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.currentIdentity.viewport.width}×${snapshot.diagnostic.currentIdentity.viewport.height} / DPR ${snapshot.diagnostic.currentIdentity.viewport.deviceScaleFactor}${snapshot.diagnostic.currentIdentity.viewport.mobile ? ' / Mobile' : ''}`}</span></div>
          <div><strong>控制权</strong><span>{snapshot.control?.owner === 'user' ? '人工' : '模型'}</span></div>
          <div><strong>同 View</strong><span>{snapshot.diagnostic?.synchronization.status ?? '不可用'}</span></div>
          <div><strong>未读异常</strong><span>{snapshot.diagnostic?.unread.total ?? 0}</span></div>
          <div><strong>Context Topology</strong><span>{snapshot.diagnostic?.contextTopology === undefined ? '未启用' : `T${snapshot.diagnostic.contextTopology.targetCount} / F${snapshot.diagnostic.contextTopology.frameCount} / E${snapshot.diagnostic.contextTopology.executionContextCount}${snapshot.diagnostic.contextTopology.truncated ? ' / 已截断' : ''}`}</span></div>
          <div><strong>主 Frame</strong><span>{snapshot.diagnostic?.contextTopology?.mainFrameId ?? '不可用'}</span></div>
          <div><strong>能力降级</strong><span>{snapshot.diagnostic?.contextTopology?.degradationCount ?? 0}</span></div>
          <div><strong>Flight Recorder</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.recorder.mode} / ${snapshot.diagnostic.recorder.status}`}</span></div>
          <div><strong>Recorder Window</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.recorder.retentionMs / 1000}s / ${snapshot.diagnostic.recorder.eventCount} events / ${snapshot.diagnostic.recorder.chunkCount} chunks`}</span></div>
          <div><strong>Recorder 配额</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.recorder.byteSize} bytes / ${snapshot.diagnostic.recorder.overload}`}</span></div>
          <div><strong>冻结 Incident</strong><span>{snapshot.diagnostic?.recorder.frozenIncidentIds.length ?? 0}</span></div>
          <div><strong>Build Topology</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.buildTopology.activeBuildCount}/${snapshot.diagnostic.buildTopology.buildCount} active · ${snapshot.diagnostic.buildTopology.scriptCount} scripts${snapshot.diagnostic.buildTopology.truncated ? ' · 已截断' : ''}`}</span></div>
          <div><strong>Application Topology</strong><span>{snapshot.diagnostic === undefined ? '不可用' : `${snapshot.diagnostic.applicationTopology.confirmedApplicationCount}/${snapshot.diagnostic.applicationTopology.activeApplicationCount} confirmed · ${snapshot.diagnostic.applicationTopology.applicationCount} total${snapshot.diagnostic.applicationTopology.truncated ? ' · 已截断' : ''}`}</span></div>
        </section>
        <section><h3>Flight Recorder</h3><div className={css.toolbar}>
          <button type="button" disabled={snapshot.diagnostic?.recorder.mode !== 'off'} onClick={() => { void runRecorder({ action: 'start', mode: 'rolling' }) }}>开启 Rolling</button>
          <button type="button" onClick={() => { void runRecorder({ action: 'start', mode: 'deep' }) }}>开启 Deep</button>
          <button type="button" disabled={snapshot.diagnostic?.recorder.status !== 'recording'} onClick={() => { void runRecorder({ action: 'pause' }) }}>暂停</button>
          <button type="button" disabled={snapshot.diagnostic?.recorder.status !== 'paused'} onClick={() => { void runRecorder({ action: 'resume' }) }}>继续</button>
          <button type="button" disabled={snapshot.diagnostic?.recorder.mode === 'off'} onClick={() => { void runRecorder({ action: 'mark' }) }}>刚才出问题了</button>
          <button type="button" disabled={snapshot.diagnostic?.recorder.mode === 'off'} onClick={() => { void runRecorder({ action: 'clear' }) }}>清空未冻结记录</button>
          <button type="button" disabled={snapshot.diagnostic?.recorder.mode === 'off'} onClick={() => { void runRecorder({ action: 'stop' }) }}>关闭</button>
        </div></section>
        <section><h3>Action Timeline</h3>{snapshot.diagnostic?.timeline.length
          ? snapshot.diagnostic.timeline.map(item => <div className={css.diagnosticItem} key={item.actionId}>
              <span><strong>{item.actionId}</strong> · {item.humanInitiated ? '人工' : '模型'} · {item.outcome}</span>
              <span>{item.toolName}</span>
              <small>D{item.documentGeneration} · {item.navigationId} · 关联证据 {item.relatedEvidenceCount}</small>
            </div>)
          : <div className={css.empty}>暂无 Action</div>}</section>
        <section><h3>Checkpoint</h3>{snapshot.diagnostic?.debugSession?.checkpoints.length
          ? snapshot.diagnostic.debugSession.checkpoints.map(item => <div className={css.diagnosticItem} key={item.checkpointId}>
              <span><strong>{item.checkpointId}</strong> · {item.label}</span>
              <small>{item.viewId} · D{item.documentGeneration} · {item.navigationId}</small>
            </div>)
          : <div className={css.empty}>暂无 Checkpoint</div>}</section>
        <section><h3>Compare</h3>{snapshot.diagnostic?.latestComparison === undefined
          ? <div className={css.empty}>暂无 Compare 摘要</div>
          : <div className={css.diagnosticItem}>
              <span><strong>{snapshot.diagnostic.latestComparison.overallVerdict}</strong> · {snapshot.diagnostic.latestComparison.beforeCheckpointId} → {snapshot.diagnostic.latestComparison.afterCheckpointId}</span>
              <small>{snapshot.diagnostic.latestComparison.comparable ? '环境可比' : '环境不可比'} · 新回归 {snapshot.diagnostic.latestComparison.newRegressionCount}</small>
              {snapshot.diagnostic.latestComparison.l3Verdict !== undefined && <small>L3 {snapshot.diagnostic.latestComparison.l3Verdict} · {snapshot.diagnostic.latestComparison.l3Comparable ? '上下文可比' : '上下文不可比'}</small>}
            </div>}</section>
        <section><h3>Incident</h3>{snapshot.diagnostic?.latestIncident === undefined
          ? <div className={css.empty}>暂无 Incident 摘要</div>
          : <div className={css.diagnosticItem}>
              <span><strong>{snapshot.diagnostic.latestIncident.incidentId}</strong> · {snapshot.diagnostic.latestIncident.verificationStatus}</span>
              <small>Facts {snapshot.diagnostic.latestIncident.factCount} · Candidates {snapshot.diagnostic.latestIncident.causalCandidateCount} · {snapshot.diagnostic.latestIncident.reportBytes} bytes</small>
              {snapshot.diagnostic.latestIncident.crossContextLinkCount !== undefined && <small>Cross Context Links {snapshot.diagnostic.latestIncident.crossContextLinkCount}{snapshot.diagnostic.latestIncident.l3Verdict === undefined ? '' : ` · L3 ${snapshot.diagnostic.latestIncident.l3Verdict}`}</small>}
            </div>}</section>
        <section><h3>Inspect</h3>{snapshot.diagnostic?.latestInspect === undefined
          ? <div className={css.empty}>当前页面没有可显示的 Inspect 摘要</div>
          : <div className={css.diagnosticItem}>
              <span><strong>{snapshot.diagnostic.latestInspect.ref}</strong> · {snapshot.diagnostic.latestInspect.target.tag}{snapshot.diagnostic.latestInspect.target.accessibleName === undefined ? '' : ` · ${snapshot.diagnostic.latestInspect.target.accessibleName}`}</span>
              <small>{snapshot.diagnostic.latestInspect.occluder === undefined ? '目标未被顶层元素遮挡' : `Occluder：${snapshot.diagnostic.latestInspect.occluder.tag}${snapshot.diagnostic.latestInspect.occluder.id === undefined ? '' : `#${snapshot.diagnostic.latestInspect.occluder.id}`}`}</small>
            </div>}</section>
        <section><h3>Takeover</h3>{snapshot.diagnostic?.takeover?.latestSummary === undefined
          ? <div className={css.empty}>{snapshot.diagnostic?.takeover?.active ? '人工接管进行中' : '暂无人工介入摘要'}</div>
          : <div className={css.diagnosticItem}>
              <span><strong>人工动作 {snapshot.diagnostic.takeover.latestSummary.actionCount}</strong> · {snapshot.diagnostic.takeover.active ? '接管中' : '已交还'}</span>
              <small>文档变化 {String(snapshot.diagnostic.takeover.latestSummary.documentChanged)} · 导航变化 {String(snapshot.diagnostic.takeover.latestSummary.navigationChanged)} · Console {snapshot.diagnostic.takeover.latestSummary.newConsoleErrors} · Network {snapshot.diagnostic.takeover.latestSummary.newFailedRequests}</small>
            </div>}</section>
      </div>}
      {view === 'console' && snapshot.available && snapshot.activeViewId !== undefined && (snapshot.console.length === 0
        ? <div className={css.empty}>暂无 Console 消息</div>
        : <pre>{snapshot.console.map(item => `[${item.level}] ${item.text}`).join('\n')}</pre>)}
      {view === 'network' && snapshot.available && snapshot.activeViewId !== undefined && <div className={css.domainPanel}>
        <div className={css.toolbar}>
          <input value={networkPattern} placeholder="URL Pattern" onChange={event => setNetworkPattern(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runNetwork({ action: 'enable', urlPattern: networkPattern || '*', requestStage: 'both' }) }}>启用拦截</button>
          <button type="button" onClick={() => { void runNetwork({ action: 'disable' }) }}>关闭拦截</button>
        </div>
        <section><h3>暂停请求</h3>{snapshot.pausedRequests?.length
          ? snapshot.pausedRequests.map(item => <div className={css.item} key={item.requestId}><span>{item.method} {item.requestStage} {item.url}</span><span>
            <button type="button" onClick={() => { void runNetwork({ action: 'continue', requestId: item.requestId }) }}>放行</button>
            <button type="button" onClick={() => { void runNetwork({ action: 'abort', requestId: item.requestId }) }}>中止</button>
            <button type="button" onClick={() => { void runNetwork({ action: 'body', requestId: item.requestId }) }}>Body</button>
            <button type="button" onClick={() => { void runNetwork({ action: 'replay', requestId: item.requestId }) }}>Replay</button>
          </span></div>)
          : <div className={css.empty}>暂无暂停请求</div>}</section>
        <section><h3>观察记录</h3>{snapshot.network.length === 0
          ? <div className={css.empty}>暂无 Network 请求</div>
          : <pre>{snapshot.network.map(item => `${item.method} ${item.status ?? '-'} ${item.type} ${item.url}`).join('\n')}</pre>}</section>
      </div>}
      {view === 'debugger' && snapshot.activeViewId !== undefined && <div className={css.debugger}>
        <div className={css.debuggerToolbar}>
          <span className={css.debuggerStatus} data-paused={snapshot.debugger?.paused || undefined} data-attached={snapshot.debugger?.attached || undefined}>{debuggerStatus}</span>
          <div className={css.actions}>{debuggerActions.map(item => <button type="button" key={item.action} onClick={() => { void runDebugger({ action: item.action }) }}>{item.label}</button>)}</div>
        </div>
        <div className={css.breakpoint}>
          <input value={breakpointUrl} placeholder="脚本 URL" onChange={event => setBreakpointUrl(event.currentTarget.value)} />
          <input value={breakpointLine} inputMode="numeric" aria-label="断点行号（一基）" title="按编辑器显示的一基行号填写" onChange={event => setBreakpointLine(event.currentTarget.value)} />
          <button type="button" onClick={() => { void addBreakpoint() }}>添加断点</button>
        </div>
        <div className={css.debuggerBody}>
          <section><h3>断点</h3>{snapshot.debugger?.breakpoints.length === 0 && <div className={css.empty}>暂无断点</div>}{snapshot.debugger?.breakpoints.map(item => <button type="button" key={item.breakpointId} onClick={() => { void runDebugger({ action: 'remove_breakpoint', breakpointId: item.breakpointId }) }}>{item.url}:{item.lineNumber + 1} ×</button>)}</section>
          <section><h3>调用栈</h3>{snapshot.debugger?.callFrames.length === 0 && <div className={css.empty}>页面未暂停</div>}{snapshot.debugger?.callFrames.map(frame => <div key={frame.callFrameId}><strong>{frame.functionName || '(anonymous)'}</strong> {frame.url}:{frame.lineNumber + 1}{frame.scopes.map((item, index) => <button type="button" key={`${frame.callFrameId}-${index}`} onClick={async () => {
            const result = await runDebugger({ action: 'scope_variables', callFrameId: frame.callFrameId, scopeNumber: index })
            const output = result as { data?: { properties?: unknown } } | undefined
            setScope(output?.data?.properties ?? result)
          }}>{item.name ?? item.type}</button>)}</div>)}</section>
          <section><h3>脚本</h3>{snapshot.debugger?.scripts.length === 0 ? <div className={css.empty}>暂无脚本</div> : snapshot.debugger?.scripts.map(item => <div key={item.scriptId}><span>{item.url}</span><span>
            <button type="button" onClick={async () => { setScope(await runDebugger({ action: 'script_source', scriptId: item.scriptId })) }}>源码</button>
            <button type="button" onClick={async () => { setScope(await runDebugger({ action: 'source_map', scriptId: item.scriptId })) }}>Map</button>
          </span></div>)}</section>
          <section><h3>Scope</h3>{scope === undefined ? <div className={css.empty}>暂停后选择 Scope 查看变量</div> : <pre>{JSON.stringify(scope, null, 2)}</pre>}</section>
        </div>
      </div>}
      {view === 'performance' && snapshot.activeViewId !== undefined && <div className={css.domainPanel}>
        <div className={css.toolbar}>
          <button type="button" onClick={() => { void runProfile({ action: 'trace_start' }) }}>Trace 开始</button>
          <button type="button" onClick={() => { void runProfile({ action: 'trace_stop' }) }}>Trace 停止</button>
          <button type="button" onClick={() => { void runProfile({ action: 'playwright_trace_start' }) }}>Playwright Trace 开始</button>
          <button type="button" onClick={() => { void runProfile({ action: 'playwright_trace_stop' }) }}>Playwright Trace 停止</button>
          <button type="button" onClick={() => { void runProfile({ action: 'cpu_start' }) }}>CPU 开始</button>
          <button type="button" onClick={() => { void runProfile({ action: 'cpu_stop' }) }}>CPU 停止</button>
          <button type="button" onClick={() => { void runProfile({ action: 'coverage_start' }) }}>Coverage 开始</button>
          <button type="button" onClick={() => { void runProfile({ action: 'coverage_stop' }) }}>Coverage 停止</button>
          <button type="button" onClick={() => { void runProfile({ action: 'heap_snapshot' }) }}>Heap Snapshot</button>
          <button type="button" onClick={() => { void runProfile({ action: 'heap_sampling_start' }) }}>Heap Sampling 开始</button>
          <button type="button" onClick={() => { void runProfile({ action: 'heap_sampling_stop' }) }}>Heap Sampling 停止</button>
        </div>
        <section><h3>制品</h3>{snapshot.artifacts?.length
          ? snapshot.artifacts.map(item => <div className={css.item} key={item.artifactId}>{item.kind} · {item.name} · {item.bytes} bytes · {item.artifactId}</div>)
          : <div className={css.empty}>暂无性能制品</div>}</section>
      </div>}
      {view === 'provider' && snapshot.activeViewId !== undefined && <div className={css.domainPanel}>
        <div className={css.status}>当前 Provider：{snapshot.capabilities?.provider ?? 'unknown'}</div>
        <div className={css.toolbar}>
          <button type="button" onClick={() => { void runProvider({ action: 'connect', provider: 'managed' }) }}>Managed</button>
          <input value={profileName} placeholder="插件 Profile 名称" onChange={event => setProfileName(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runProvider({ action: 'connect', provider: 'managed-persistent', profileName }) }}>Persistent</button>
          <input value={externalEndpoint} placeholder="CDP Endpoint" onChange={event => setExternalEndpoint(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runProvider({ action: 'connect', provider: 'external-cdp', endpoint: externalEndpoint }) }}>External CDP</button>
          <button type="button" onClick={() => { void runProvider({ action: 'disconnect' }) }}>断开并回到默认 Persistent</button>
        </div>
        <div className={css.message}>External CDP 只断开插件连接，不关闭用户浏览器；不会扫描调试端口。</div>
      </div>}
      {view === 'extensions' && snapshot.available && <div className={css.domainPanel}>
        <div className={css.status}>
          插件 Chromium：{snapshot.chromium?.installed ? '已安装' : '未安装'}；首次安装扩展时会按需下载。扩展仅属于当前 DSH Session 的 Persistent Profile。
        </div>
        <div className={css.toolbar}>
          <input value={extensionSource} aria-label="Chrome Web Store 扩展" placeholder="Chrome Web Store URL 或扩展 ID" onChange={event => setExtensionSource(event.currentTarget.value)} />
          <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined || extensionSource.trim() === ''} onClick={() => { requestExtensionMutation({ action: 'install', extension: extensionSource.trim() }) }}>{extensionBusy ? '正在处理扩展' : '从商店安装'}</button>
          <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined || !snapshot.extensions?.some(item => item.pendingRestart)} onClick={() => { requestExtensionMutation({ action: 'apply' }) }}>应用待生效变更</button>
        </div>
        <section><h3>当前 Session 扩展</h3>{snapshot.extensions?.length
          ? snapshot.extensions.map(item => <div className={css.item} key={item.extensionId}>
            <strong>{item.name}</strong>
            <span>{item.version} · {item.extensionId}</span>
            <span>{item.enabled ? '已启用' : '已禁用'} · {item.loaded ? '当前已加载' : '当前未加载'}{item.pendingRestart ? ' · 待重启生效' : ''}</span>
            <span>
              <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined || !item.loaded || item.actionPopup === undefined} title={item.actionPopup === undefined ? '该扩展没有声明 Popup' : !item.loaded ? '请先让扩展在当前浏览器中生效' : '在面板悬浮层中打开扩展 Popup'} onClick={() => { void openExtensionPopup(item.extensionId) }}>打开扩展</button>
              <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined} onClick={() => { requestExtensionMutation({ action: item.enabled ? 'disable' : 'enable', extensionId: item.extensionId }) }}>{item.enabled ? '禁用' : '启用'}</button>
              <button type="button" disabled={extensionBusy || pendingExtensionInput !== undefined} onClick={() => { requestExtensionMutation({ action: 'uninstall', extensionId: item.extensionId }) }}>卸载</button>
            </span>
          </div>)
          : <div className={css.empty}>当前 Session 尚未安装浏览器扩展</div>}</section>
      </div>}
      {view === 'emulation' && snapshot.activeViewId !== undefined && <div className={css.domainPanel}>
        <div className={css.toolbar}>
          <input value={viewportWidth} inputMode="numeric" aria-label="Viewport 宽度" onChange={event => setViewportWidth(event.currentTarget.value)} />
          <input value={viewportHeight} inputMode="numeric" aria-label="Viewport 高度" onChange={event => setViewportHeight(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runEmulate({ action: 'viewport', width: Number(viewportWidth), height: Number(viewportHeight) }) }}>应用 Viewport</button>
          <input value={locale} placeholder="Locale" onChange={event => setLocale(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runEmulate({ action: 'locale', locale }) }}>应用 Locale</button>
          <input value={timezone} placeholder="Timezone" onChange={event => setTimezone(event.currentTarget.value)} />
          <button type="button" onClick={() => { void runEmulate({ action: 'timezone', timezoneId: timezone }) }}>应用时区</button>
          <button type="button" onClick={() => { void runEmulate({ action: 'offline', offline: true }) }}>离线</button>
          <button type="button" onClick={() => { void runEmulate({ action: 'network', offline: false }) }}>恢复网络</button>
          <button type="button" onClick={() => { void runEmulate({ action: 'cpu', rate: 4 }) }}>CPU ×4</button>
          <button type="button" onClick={() => { void runEmulate({ action: 'reset' }) }}>全部重置</button>
        </div>
      </div>}
        </div>
        {snapshot.extensionPopup !== undefined && <div className={css.extensionPopupLayer} role="dialog" aria-modal="false" aria-label={`${snapshot.extensionPopup.name} 扩展`}>
          <div ref={extensionPopupWindowRef} className={css.extensionPopupWindow} style={{ left: extensionPopupPosition.x, top: extensionPopupPosition.y, width: `min(${snapshot.extensionPopup.width}px, calc(100% - 16px))`, height: `min(${snapshot.extensionPopup.height + 34}px, calc(100% - 16px))` }}>
            <header onPointerDown={beginExtensionPopupDrag}><strong>{snapshot.extensionPopup.name}</strong><button type="button" aria-label="关闭扩展 Popup" onPointerDown={event => { event.stopPropagation() }} onClick={() => { void runExtensions({ action: 'close_popup', extensionId: snapshot.extensionPopup?.extensionId }) }}>×</button></header>
            <div className={css.extensionPopupCanvas}>
              {snapshot.extensionPopup.frame === undefined ? <div className={css.empty}>等待扩展画面</div> : <img
                ref={extensionPopupRef}
                className={css.extensionPopupImage}
                src={`data:${snapshot.extensionPopup.frame.mediaType};base64,${snapshot.extensionPopup.frame.data}`}
                alt={`${snapshot.extensionPopup.name} 扩展画面`}
                tabIndex={0}
                onPointerDown={event => {
                  const target = popupPoint(event.clientX, event.clientY)
                  const identity = popupIdentity()
                  if (target === undefined || identity === undefined || event.button !== 0) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  const pressed = runInput({ action: 'mouse_down', ...target, ...identity, button: 'left', clickCount: Math.min(Math.max(event.detail || 1, 1), 3) }).then(result => (result as { ok?: boolean } | undefined)?.ok === true)
                  extensionPopupGesture.current = { identity, last: target, pressed, chain: pressed }
                }}
                onPointerMove={event => {
                  const gesture = extensionPopupGesture.current
                  const target = popupPoint(event.clientX, event.clientY, true)
                  if (gesture === undefined || target === undefined) return
                  gesture.last = target
                  gesture.chain = gesture.chain.then(async () => await gesture.pressed ? runInput({ action: 'mouse_move', ...target, ...gesture.identity }) : undefined)
                }}
                onPointerUp={event => {
                  const gesture = extensionPopupGesture.current
                  if (gesture === undefined) return
                  const target = popupPoint(event.clientX, event.clientY, true) ?? gesture.last
                  extensionPopupGesture.current = undefined
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                  gesture.chain = gesture.chain.then(async () => await gesture.pressed ? runInput({ action: 'mouse_up', ...target, ...gesture.identity }) : undefined)
                }}
                onWheel={event => {
                  const target = popupPoint(event.clientX, event.clientY)
                  const identity = popupIdentity()
                  if (target === undefined || identity === undefined) return
                  event.preventDefault()
                  void runInput({ action: 'mouse_wheel', ...target, ...identity, deltaX: event.deltaX, deltaY: event.deltaY })
                }}
                onKeyDown={event => {
                  const identity = popupIdentity()
                  if (identity === undefined || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return
                  event.preventDefault()
                  void runInput({ action: 'key_press', key: event.key, modifiers: modifiersOf(event), ...identity })
                }}
              />}
            </div>
          </div>
        </div>}
      </div>
    </section>
  )
}

export const inject = ['slots', 'connection']

export function apply(ctx: BrowserClientContext): void {
  const call = async <T,>(endpoint: string, payload: unknown): Promise<T> => valueOf<T>(await ctx.connection.rpc.call(CHANNEL, endpoint, payload))
  const port: Port = {
    controllerStatus: sessionId => call('controller_status', { sessionId }),
    controllerActivate: sessionId => call('controller_activate', { sessionId }),
    controllerDeactivate: sessionId => call('controller_deactivate', { sessionId }),
    controllerRelease: sessionId => call('controller_release', { sessionId }),
    snapshot: (sessionId, view, streamGeneration, sequence, splitCursors, popupCursor, diagnosticReadSequence) => call('snapshot', { sessionId, view, streamGeneration, sequence, splitCursors, popupCursor, diagnosticReadSequence }),
    tabs: (sessionId, input) => call('tabs', { sessionId, ...input }),
    debugger: (sessionId, input) => call('debugger', { sessionId, ...input }),
    network: (sessionId, input) => call('network', { sessionId, ...input }),
    profile: (sessionId, input) => call('profile', { sessionId, ...input }),
    provider: (sessionId, input) => call('provider', { sessionId, ...input }),
    extensions: (sessionId, input) => call('extensions', { sessionId, ...input }),
    emulate: (sessionId, input) => call('emulate', { sessionId, ...input }),
    liveView: (sessionId, input) => call('live_view', { sessionId, ...input }),
    splitView: (sessionId, input) => call('split_view', { sessionId, ...input }),
    takeover: (sessionId, input) => call('takeover', { sessionId, ...input }),
    input: (sessionId, input) => call('input', { sessionId, ...input }),
    inputTrace: (sessionId, input) => call('input_trace', { sessionId, ...input }),
    recorder: (sessionId, input) => call('recorder', { sessionId, ...input }),
    close: async (sessionId, view) => { await call('close', { sessionId, view }) },
  }
  let activeSessionId: string | undefined
  let activeView: BrowserPanelView | undefined
  let disposePanel = () => {}
  let disposeSplit = () => {}
  const listeners = new Set<(state: { open: boolean; sessionId?: string; view?: BrowserPanelView }) => void>()
  const notify = () => {
    const state = activeSessionId === undefined || activeView === undefined
      ? { open: false }
      : { open: true, sessionId: activeSessionId, view: activeView }
    for (const listener of listeners) listener(state)
  }
  const close = () => {
    if (activeSessionId !== undefined && activeView !== undefined) {
      // close 属于 UI 卸载时的尽力清理。Session 身份切换可能让旧 Controller 已先退出，
      // Host 此时拒绝旧 close RPC 是正确安全行为；必须收敛 Promise，避免形成页面未处理拒绝。
      void port.close(activeSessionId, activeView).catch(() => {})
    }
    activeSessionId = undefined
    activeView = undefined
    disposePanel()
    disposePanel = () => {}
    disposeSplit()
    disposeSplit = () => {}
    notify()
  }
  const controller: PanelController = {
    open(sessionId, view) {
      close()
      const split = setSplit(close)
      if (!split.ok) {
        notify()
        return split
      }
      disposeSplit = split.dispose
      activeSessionId = sessionId
      activeView = view
      disposePanel = ctx.slots.register({ name: 'details', priority: -100, inject: () => ({ port, view, onClose: close, onViewChange: (next: BrowserPanelView) => { controller.open(sessionId, next) } }) }, BrowserPanel)
      notify()
      return { ok: true }
    },
    close,
    subscribe(listener) {
      listeners.add(listener)
      listener(activeSessionId === undefined || activeView === undefined
        ? { open: false }
        : { open: true, sessionId: activeSessionId, view: activeView })
      return () => { listeners.delete(listener) }
    },
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'browser-panel', order: 50,
    inject: () => ({ controller, port }),
  }, BrowserControl))
  ctx.effect(() => close, 'browser panel cleanup')
}
