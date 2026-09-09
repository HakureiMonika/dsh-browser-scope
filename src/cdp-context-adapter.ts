import type { Frame } from 'playwright-core'
import { targetType, worldTypeOf, type ContextTopologySnapshot, type EvidenceContextIdentity, type TargetIdentity } from './context-identity.ts'
import { ContextIdentityRegistry } from './context-registry.ts'

export interface ContextCdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  on(event: string, listener: (payload: Record<string, unknown>) => void): ContextCdpTransport
  off?(event: string, listener: (payload: Record<string, unknown>) => void): ContextCdpTransport
}

interface ContextAdapterOptions {
  sessionId: string
  sessionKey: string
  viewId: string
  browserContextGeneration: number
  owner: TargetIdentity['owner']
}

interface FramePayload {
  id: string
  parentId?: string
  loaderId?: string
  url: string
  name?: string
  securityOrigin?: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}


function framePayload(value: unknown): FramePayload | undefined {
  const frame = record(value)
  const id = string(frame.id)
  if (id === '') return undefined
  const parentId = string(frame.parentId)
  const loaderId = string(frame.loaderId)
  const name = string(frame.name)
  const securityOrigin = string(frame.securityOrigin)
  return {
    id,
    ...(parentId === '' ? {} : { parentId }),
    ...(loaderId === '' ? {} : { loaderId }),
    url: string(frame.url),
    ...(name === '' ? {} : { name }),
    ...(securityOrigin === '' ? {} : { securityOrigin }),
  }
}

export class CdpContextAdapter {
  private readonly client: ContextCdpTransport
  private readonly registry: ContextIdentityRegistry
  private readonly options: ContextAdapterOptions
  private readonly listeners: Array<{ event: string; listener: (payload: Record<string, unknown>) => void }> = []
  private enabled = false
  private disposed = false
  private mainTargetId = ''
  private mainFrameId = ''
  private readonly scriptContexts = new Map<string, EvidenceContextIdentity[]>()
  private readonly resourceContexts = new Map<string, EvidenceContextIdentity[]>()
  private readonly attachedTargetSessions = new Set<string>()
  private readonly limitedOopifTargets = new Set<string>()

  constructor(client: ContextCdpTransport, registry: ContextIdentityRegistry, options: ContextAdapterOptions) {
    this.client = client
    this.registry = registry
    this.options = options
  }

  private listen(event: string, listener: (payload: Record<string, unknown>) => void): void {
    this.client.on(event, listener)
    this.listeners.push({ event, listener })
  }

  private target(input: Record<string, unknown>, confidence: TargetIdentity['confidence'] = 'confirmed'): TargetIdentity | undefined {
    const targetId = string(input.targetId)
    if (targetId === '') return undefined
    const openerId = string(input.openerId)
    const parentTargetId = string(input.parentTargetId) || openerId
    const value = this.registry.upsertTarget(this.options.sessionKey, {
      targetId,
      viewId: this.options.viewId,
      type: targetType(string(input.type)),
      ...(parentTargetId === '' && targetType(string(input.type)) !== 'iframe'
        ? {}
        : { parentTargetId: parentTargetId || this.mainTargetId }),
      browserContextGeneration: this.options.browserContextGeneration,
      url: string(input.url),
      attached: true,
      owner: this.options.owner,
      confidence,
    })
    if (value.type === 'page' && this.mainTargetId === '') this.mainTargetId = value.targetId
    if (value.type === 'iframe') {
      const matchCount = this.registry.matchingFrameCount(this.options.sessionKey, this.options.viewId, value.url)
      const aligned = this.registry.alignOopif(this.options.sessionKey, value.targetId, value.url)
      if (aligned === undefined && matchCount === 0) {
        // Chromium的OOPIF不会继续出现在父Page的FrameTree中；iframe Target的targetId就是该跨进程Frame的协议身份，不能因父树不可见而丢失Frame。
        this.registry.upsertFrame({
          sessionKey: this.options.sessionKey,
          viewId: this.options.viewId,
          frameId: value.targetId,
          targetId: value.targetId,
          ...(this.mainFrameId === '' ? {} : { parentFrameId: this.mainFrameId }),
          mainFrame: false,
          url: value.url,
          oopif: true,
          documentCommitted: true,
          confidence: value.parentTargetId === this.mainTargetId ? 'confirmed' : 'candidate',
        })
      }
      if (!this.limitedOopifTargets.has(value.targetId)) {
        this.limitedOopifTargets.add(value.targetId)
        this.registry.degrade(this.options.sessionKey, {
          code: 'oopif-target-context-limited',
          viewId: this.options.viewId,
          targetId: value.targetId,
          frameId: aligned?.frameId ?? value.targetId,
          reason: 'The OOPIF target and frame are identified, but its isolated Execution Context and Debugger Script stream are not attached in L3-A.',
        })
      }
    }
    return value
  }

  private frame(input: FramePayload, confidence: 'confirmed' | 'candidate' = 'confirmed'): void {
    const mainFrame = input.parentId === undefined
    if (mainFrame) this.mainFrameId = input.id
    this.registry.upsertFrame({
      sessionKey: this.options.sessionKey,
      viewId: this.options.viewId,
      frameId: input.id,
      targetId: this.mainTargetId || `${this.options.viewId}-page`,
      ...(input.parentId === undefined ? {} : { parentFrameId: input.parentId }),
      mainFrame,
      url: input.url,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.loaderId === undefined ? {} : { loaderId: input.loaderId }),
      ...(input.securityOrigin === undefined ? {} : { securityOrigin: input.securityOrigin }),
      confidence,
    })
  }

  private frameTree(value: unknown): void {
    const node = record(value)
    const frame = framePayload(node.frame)
    if (frame !== undefined) this.frame(frame)
    const children = Array.isArray(node.childFrames) ? node.childFrames : []
    for (const child of children) this.frameTree(child)
  }

  private installListeners(): void {
    this.listen('Page.frameAttached', payload => {
      const frameId = string(payload.frameId)
      if (frameId === '') return
      const parentFrameId = string(payload.parentFrameId)
      this.frame({ id: frameId, ...(parentFrameId === '' ? {} : { parentId: parentFrameId }), url: 'about:blank' }, 'candidate')
    })
    this.listen('Page.frameDetached', payload => {
      const frameId = string(payload.frameId)
      // Chromium将跨进程iframe迁移表示为reason=swap；此时逻辑Frame仍存在，只是后续事件改由OOPIF Target承载，不能按DOM删除清理身份。
      if (frameId !== '' && string(payload.reason) !== 'swap') this.registry.detachFrame(this.options.sessionKey, frameId)
    })
    this.listen('Page.frameNavigated', payload => {
      const frame = framePayload(payload.frame)
      if (frame !== undefined) this.frame(frame)
    })
    this.listen('Page.navigatedWithinDocument', payload => {
      const frameId = string(payload.frameId)
      const url = string(payload.url)
      if (frameId !== '' && url !== '') this.registry.updateSameDocument(this.options.sessionKey, frameId, url)
    })
    this.listen('Runtime.executionContextCreated', payload => {
      const context = record(payload.context)
      const id = number(context.id)
      if (id === undefined) return
      const auxData = record(context.auxData)
      const frameId = string(auxData.frameId)
      const origin = string(context.origin)
      const name = string(context.name)
      this.registry.upsertExecutionContext(this.options.sessionKey, {
        executionContextId: id,
        viewId: this.options.viewId,
        targetId: this.mainTargetId || `${this.options.viewId}-page`,
        ...(frameId === '' ? {} : { frameId }),
        worldType: worldTypeOf({ isDefault: auxData.isDefault === true, name, origin }),
        ...(origin === '' ? {} : { origin }),
        ...(name === '' ? {} : { name }),
        attached: true,
        confidence: frameId === '' ? 'candidate' : 'confirmed',
      })
    })
    this.listen('Runtime.executionContextDestroyed', payload => {
      const id = number(payload.executionContextId)
      if (id !== undefined) this.registry.destroyExecutionContext(this.options.sessionKey, id)
    })
    this.listen('Runtime.executionContextsCleared', () => {
      this.registry.clearExecutionContexts(this.options.sessionKey, this.mainTargetId || undefined)
    })
    this.listen('Target.attachedToTarget', payload => {
      const sessionId = string(payload.sessionId)
      if (sessionId !== '') this.attachedTargetSessions.add(sessionId)
      this.target(record(payload.targetInfo))
    })
    this.listen('Target.detachedFromTarget', payload => {
      const sessionId = string(payload.sessionId)
      if (sessionId !== '') this.attachedTargetSessions.delete(sessionId)
      const targetId = string(payload.targetId)
      if (targetId !== '') this.registry.detachTarget(this.options.sessionKey, targetId)
    })
    this.listen('Target.targetInfoChanged', payload => {
      this.target(record(payload.targetInfo))
    })
  }

  async enable(): Promise<void> {
    if (this.enabled || this.disposed) return
    this.registry.startSession(this.options.sessionId, this.options.sessionKey, this.options.browserContextGeneration)
    this.installListeners()
    await this.client.send('Page.enable')
    try {
      const result = await this.client.send('Target.getTargetInfo')
      this.target(record(result.targetInfo))
    } catch (error) {
      this.mainTargetId = `${this.options.viewId}-page`
      this.registry.upsertTarget(this.options.sessionKey, {
        targetId: this.mainTargetId,
        viewId: this.options.viewId,
        type: 'page',
        browserContextGeneration: this.options.browserContextGeneration,
        url: '',
        attached: true,
        owner: this.options.owner,
        confidence: 'candidate',
      })
      this.registry.degrade(this.options.sessionKey, {
        code: 'target-info-unavailable',
        viewId: this.options.viewId,
        targetId: this.mainTargetId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    const tree = await this.client.send('Page.getFrameTree')
    this.frameTree(tree.frameTree)
    await this.client.send('Runtime.enable')
    try {
      await this.client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    } catch (error) {
      this.registry.degrade(this.options.sessionKey, {
        code: 'target-auto-attach-unavailable',
        viewId: this.options.viewId,
        targetId: this.mainTargetId || undefined,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    this.enabled = true
  }

  isEnabled(): boolean {
    return this.enabled && !this.disposed
  }

  isDisposed(): boolean {
    return this.disposed
  }

  contextForExecution(executionContextId: number): EvidenceContextIdentity {
    return this.registry.executionContext(this.options.sessionKey, executionContextId)
  }

  contextForFrame(frame: Frame): EvidenceContextIdentity {
    if (frame.parentFrame() === null) return this.registry.frameContext(this.options.sessionKey, this.mainFrameId)
    const snapshot = this.registry.snapshot(this.options.sessionKey)
    const parent = frame.parentFrame()
    const parentContext = parent === null ? {} : this.contextForFrame(parent)
    const candidates = snapshot.frames.filter(value => value.attached
      && !value.mainFrame
      && value.url === frame.url()
      && (frame.name() === '' || value.name === undefined || value.name === frame.name())
      && (parentContext.frameId === undefined || value.parentFrameId === parentContext.frameId))
    return candidates.length === 1 ? this.registry.frameContext(this.options.sessionKey, candidates[0]?.frameId) : {}
  }

  contextForUrl(url: string): EvidenceContextIdentity {
    const scripts = this.scriptContexts.get(url) ?? []
    if (scripts.length === 1) return scripts[0] ?? {}
    const resources = this.resourceContexts.get(url) ?? []
    if (resources.length === 1) return resources[0] ?? {}
    return this.registry.uniqueFrameContext(this.options.sessionKey, this.options.viewId, url)
  }

  registerResource(url: string, identity: EvidenceContextIdentity): void {
    if (url === '' || identity.targetId === undefined) return
    const values = this.resourceContexts.get(url) ?? []
    const duplicate = values.some(value => value.targetId === identity.targetId
      && value.frameId === identity.frameId
      && value.frameDocumentGeneration === identity.frameDocumentGeneration)
    if (!duplicate) values.push(identity)
    this.resourceContexts.set(url, values)
  }

  registerScript(url: string, identity: EvidenceContextIdentity): void {
    if (url === '' || identity.targetId === undefined) return
    const values = this.scriptContexts.get(url) ?? []
    const duplicate = values.some(value => value.executionContextId === identity.executionContextId
      && value.frameId === identity.frameId
      && value.frameDocumentGeneration === identity.frameDocumentGeneration)
    if (!duplicate) values.push(identity)
    this.scriptContexts.set(url, values)
  }

  mainContext(): EvidenceContextIdentity {
    return this.registry.frameContext(this.options.sessionKey, this.mainFrameId)
  }

  snapshot(): ContextTopologySnapshot {
    return this.registry.snapshot(this.options.sessionKey)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { event, listener } of this.listeners) this.client.off?.(event, listener)
    this.listeners.length = 0
    this.scriptContexts.clear()
    this.resourceContexts.clear()
    void this.client.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
    for (const sessionId of this.attachedTargetSessions) {
      void this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
    this.attachedTargetSessions.clear()
    this.limitedOopifTargets.clear()
    this.registry.removeView(this.options.sessionKey, this.options.viewId)
  }
}
