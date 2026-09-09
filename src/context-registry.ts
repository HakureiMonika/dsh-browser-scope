import {
  DEFAULT_CONTEXT_TOPOLOGY_LIMITS,
  originOf,
  type CapabilityDegradation,
  type ContextTopologyLimits,
  type ContextTopologySnapshot,
  type DocumentIdentity,
  type EvidenceContextIdentity,
  type ExecutionContextIdentity,
  type FrameIdentity,
  type TargetIdentity,
} from './context-identity.ts'

interface SessionTopology {
  sessionId: string
  sessionKey: string
  browserContextGeneration: number
  targets: Map<string, TargetIdentity>
  frames: Map<string, FrameIdentity>
  documents: Map<string, DocumentIdentity>
  executionContexts: Map<number, ExecutionContextIdentity>
  degradations: CapabilityDegradation[]
}

interface FrameInput {
  sessionKey: string
  viewId: string
  frameId: string
  targetId: string
  parentFrameId?: string
  mainFrame: boolean
  url: string
  name?: string
  loaderId?: string
  securityOrigin?: string
  oopif?: boolean
  documentCommitted?: boolean
  confidence?: FrameIdentity['confidence']
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function limited<T>(values: T[], maximum: number): { values: T[]; truncated: boolean } {
  return { values: values.slice(0, maximum), truncated: values.length > maximum }
}

export class ContextIdentityRegistry {
  private readonly sessions = new Map<string, SessionTopology>()

  startSession(sessionId: string, sessionKey: string, browserContextGeneration: number): void {
    const existing = this.sessions.get(sessionKey)
    if (existing !== undefined) {
      if (existing.browserContextGeneration !== browserContextGeneration) this.invalidateSession(sessionKey, browserContextGeneration)
      return
    }
    this.sessions.set(sessionKey, {
      sessionId: bounded(sessionId, 200),
      sessionKey,
      browserContextGeneration,
      targets: new Map(),
      frames: new Map(),
      documents: new Map(),
      executionContexts: new Map(),
      degradations: [],
    })
  }

  private session(sessionKey: string): SessionTopology {
    const value = this.sessions.get(sessionKey)
    if (value === undefined) throw new Error('context identity session is not active')
    return value
  }

  upsertTarget(sessionKey: string, target: TargetIdentity): TargetIdentity {
    const session = this.session(sessionKey)
    const value: TargetIdentity = {
      ...target,
      targetId: bounded(target.targetId, 200),
      viewId: bounded(target.viewId, 200),
      url: bounded(target.url, 1600),
      ...(target.parentTargetId === undefined ? {} : { parentTargetId: bounded(target.parentTargetId, 200) }),
    }
    session.targets.set(value.targetId, value)
    return value
  }

  detachTarget(sessionKey: string, targetId: string): void {
    const session = this.session(sessionKey)
    const target = session.targets.get(targetId)
    if (target !== undefined) target.attached = false
    for (const frame of session.frames.values()) {
      if (frame.targetId === targetId) frame.attached = false
    }
    for (const context of session.executionContexts.values()) {
      if (context.targetId === targetId) context.attached = false
    }
  }

  upsertFrame(input: FrameInput): FrameIdentity {
    const session = this.session(input.sessionKey)
    const previous = session.frames.get(input.frameId)
    const loaderChanged = input.loaderId !== undefined && input.loaderId !== previous?.loaderId
    const firstDocument = previous === undefined
    const placeholderCommitted = previous?.documentGeneration === 0 && input.documentCommitted === true
    // frameAttached只提供无Loader的结构占位，不代表新Document已经提交；首次获得Loader或OOPIF Target确认文档已提交时从Generation 1开始，后续Loader变化才递增。
    const documentGeneration = firstDocument
      ? input.loaderId === undefined && input.documentCommitted !== true ? 0 : 1
      : placeholderCommitted ? 1 : loaderChanged ? previous.documentGeneration + 1 : previous.documentGeneration
    const value: FrameIdentity = {
      frameId: bounded(input.frameId, 200),
      viewId: bounded(input.viewId, 200),
      targetId: bounded(input.targetId, 200),
      ...(input.parentFrameId === undefined ? {} : { parentFrameId: bounded(input.parentFrameId, 200) }),
      mainFrame: input.mainFrame,
      url: bounded(input.url, 1600),
      origin: originOf(input.url),
      ...(input.name === undefined || input.name === '' ? {} : { name: bounded(input.name, 200) }),
      documentGeneration,
      ...(input.loaderId === undefined || input.loaderId === '' ? {} : { loaderId: bounded(input.loaderId, 200) }),
      ...(input.securityOrigin === undefined || input.securityOrigin === '' ? {} : { securityOrigin: bounded(input.securityOrigin, 500) }),
      attached: true,
      oopif: input.oopif ?? previous?.oopif ?? false,
      confidence: input.confidence ?? previous?.confidence ?? 'confirmed',
    }
    session.frames.set(value.frameId, value)
    for (const context of session.executionContexts.values()) {
      if (context.frameId !== value.frameId || !context.attached) continue
      context.targetId = value.targetId
      context.documentGeneration = value.documentGeneration
      context.confidence = value.confidence
    }
    if (documentGeneration > 0 && (firstDocument || placeholderCommitted || loaderChanged)) {
      session.documents.set(`${value.frameId}@${value.documentGeneration}`, {
        navigationId: `${value.frameId}-d${value.documentGeneration}`,
        frameId: value.frameId,
        documentGeneration: value.documentGeneration,
        url: value.url,
        ...(value.loaderId === undefined ? {} : { loaderId: value.loaderId }),
        createdAt: Date.now(),
      })
      for (const context of session.executionContexts.values()) {
        if (context.frameId === value.frameId && context.documentGeneration !== value.documentGeneration) context.attached = false
      }
    }
    return value
  }

  updateSameDocument(sessionKey: string, frameId: string, url: string): void {
    const session = this.session(sessionKey)
    const frame = session.frames.get(frameId)
    if (frame === undefined) return
    frame.url = bounded(url, 1600)
    frame.origin = originOf(url)
    const document = session.documents.get(`${frame.frameId}@${frame.documentGeneration}`)
    if (document !== undefined) document.url = frame.url
  }

  detachFrame(sessionKey: string, frameId: string): void {
    const session = this.session(sessionKey)
    const pending = [frameId]
    while (pending.length > 0) {
      const current = pending.shift()
      if (current === undefined) continue
      const frame = session.frames.get(current)
      if (frame !== undefined) frame.attached = false
      for (const child of session.frames.values()) {
        if (child.parentFrameId === current && child.attached) pending.push(child.frameId)
      }
      for (const context of session.executionContexts.values()) {
        if (context.frameId === current) context.attached = false
      }
    }
  }

  upsertExecutionContext(sessionKey: string, context: ExecutionContextIdentity): ExecutionContextIdentity {
    const session = this.session(sessionKey)
    const frame = context.frameId === undefined ? undefined : session.frames.get(context.frameId)
    const value: ExecutionContextIdentity = {
      ...context,
      viewId: bounded(context.viewId, 200),
      targetId: bounded(context.targetId, 200),
      ...(context.frameId === undefined ? {} : { frameId: bounded(context.frameId, 200) }),
      ...(frame === undefined ? {} : { documentGeneration: frame.documentGeneration }),
      ...(context.origin === undefined ? {} : { origin: bounded(context.origin, 500) }),
      ...(context.name === undefined ? {} : { name: bounded(context.name, 500) }),
    }
    session.executionContexts.set(value.executionContextId, value)
    return value
  }

  destroyExecutionContext(sessionKey: string, executionContextId: number): void {
    const context = this.session(sessionKey).executionContexts.get(executionContextId)
    if (context !== undefined) context.attached = false
  }

  clearExecutionContexts(sessionKey: string, targetId?: string): void {
    for (const context of this.session(sessionKey).executionContexts.values()) {
      if (targetId === undefined || context.targetId === targetId) context.attached = false
    }
  }

  alignOopif(sessionKey: string, targetId: string, url: string): FrameIdentity | undefined {
    const session = this.session(sessionKey)
    const candidates = [...session.frames.values()].filter(frame => frame.attached && !frame.mainFrame && frame.url === url)
    if (candidates.length > 1) {
      this.degrade(sessionKey, {
        code: 'oopif-frame-ambiguous',
        viewId: candidates[0]?.viewId ?? session.targets.get(targetId)?.viewId ?? 'unknown',
        targetId,
        reason: 'More than one logical frame matches the attached iframe target URL.',
      })
      return undefined
    }
    if (candidates.length === 0) return undefined
    const frame = candidates[0]
    if (frame === undefined) return undefined
    // OOPIF切换存在事件竞态：父Page可能先留下Generation 0占位，再由iframe Target确认已提交文档。必须经统一入口晋升到首代文档并同步关联Context。
    return this.upsertFrame({
      sessionKey,
      viewId: frame.viewId,
      frameId: frame.frameId,
      targetId,
      ...(frame.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
      mainFrame: false,
      url: frame.url,
      ...(frame.name === undefined ? {} : { name: frame.name }),
      ...(frame.loaderId === undefined ? {} : { loaderId: frame.loaderId }),
      ...(frame.securityOrigin === undefined ? {} : { securityOrigin: frame.securityOrigin }),
      oopif: true,
      documentCommitted: true,
      confidence: 'confirmed',
    })
  }

  matchingFrameCount(sessionKey: string, viewId: string, url: string): number {
    return [...this.session(sessionKey).frames.values()].filter(frame => frame.attached && frame.viewId === viewId && !frame.mainFrame && frame.url === url).length
  }

  degrade(sessionKey: string, input: Omit<CapabilityDegradation, 'observedAt'>): void {
    const session = this.session(sessionKey)
    session.degradations.push({ ...input, reason: bounded(input.reason, 1000), observedAt: Date.now() })
    if (session.degradations.length > 100) session.degradations.splice(0, session.degradations.length - 100)
  }

  frameContext(sessionKey: string, frameId: string | undefined): EvidenceContextIdentity {
    if (frameId === undefined) return {}
    const frame = this.session(sessionKey).frames.get(frameId)
    if (frame === undefined || !frame.attached) return {}
    return {
      targetId: frame.targetId,
      frameId: frame.frameId,
      frameDocumentGeneration: frame.documentGeneration,
      ...(frame.loaderId === undefined ? {} : { loaderId: frame.loaderId }),
    }
  }

  uniqueFrameContext(sessionKey: string, viewId: string, url: string): EvidenceContextIdentity {
    if (url === '') return {}
    const candidates = [...this.session(sessionKey).frames.values()].filter(frame => frame.attached && frame.viewId === viewId && frame.url === url)
    return candidates.length === 1 ? this.frameContext(sessionKey, candidates[0]?.frameId) : {}
  }

  executionContext(sessionKey: string, executionContextId: number): EvidenceContextIdentity {
    const context = this.session(sessionKey).executionContexts.get(executionContextId)
    if (context === undefined || !context.attached) return {}
    return {
      targetId: context.targetId,
      ...(context.frameId === undefined ? {} : { frameId: context.frameId }),
      ...(context.documentGeneration === undefined ? {} : { frameDocumentGeneration: context.documentGeneration }),
      executionContextId: context.executionContextId,
      worldType: context.worldType,
    }
  }

  snapshot(sessionKey: string, limits: ContextTopologyLimits = DEFAULT_CONTEXT_TOPOLOGY_LIMITS): ContextTopologySnapshot {
    const session = this.session(sessionKey)
    const targets = limited([...session.targets.values()].filter(value => value.attached), limits.targets)
    const frames = limited([...session.frames.values()].filter(value => value.attached), limits.frames)
    const activeFrameKeys = new Set(frames.values.map(frame => `${frame.frameId}@${frame.documentGeneration}`))
    const documents = limited([...session.documents.entries()].filter(([key]) => activeFrameKeys.has(key)).map(([, value]) => value), limits.documents)
    const contexts = limited([...session.executionContexts.values()].filter(value => value.attached), limits.executionContexts)
    const degradations = limited([...session.degradations].reverse(), limits.degradations)
    return {
      contextTopologySchemaVersion: 1,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      browserContextGeneration: session.browserContextGeneration,
      targets: targets.values,
      frames: frames.values,
      documents: documents.values,
      executionContexts: contexts.values,
      degradations: degradations.values,
      truncated: {
        targets: targets.truncated,
        frames: frames.truncated,
        documents: documents.truncated,
        executionContexts: contexts.truncated,
        degradations: degradations.truncated,
      },
    }
  }

  removeView(sessionKey: string, viewId: string): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    for (const target of session.targets.values()) if (target.viewId === viewId) target.attached = false
    for (const frame of session.frames.values()) if (frame.viewId === viewId) frame.attached = false
    for (const context of session.executionContexts.values()) if (context.viewId === viewId) context.attached = false
  }

  migrateSession(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return
    const session = this.sessions.get(previousKey)
    if (session === undefined) return
    if (this.sessions.has(nextKey)) throw new Error('cannot migrate context identity into an existing session')
    session.sessionKey = nextKey
    this.sessions.set(nextKey, session)
    this.sessions.delete(previousKey)
  }

  invalidateSession(sessionKey: string, browserContextGeneration?: number): void {
    const session = this.sessions.get(sessionKey)
    if (session === undefined) return
    if (browserContextGeneration === undefined) {
      this.sessions.delete(sessionKey)
      return
    }
    session.browserContextGeneration = browserContextGeneration
    session.targets.clear()
    session.frames.clear()
    session.documents.clear()
    session.executionContexts.clear()
    session.degradations = []
  }

  clear(): void {
    this.sessions.clear()
  }
}
