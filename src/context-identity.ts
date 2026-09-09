export type ContextConfidence = 'confirmed' | 'candidate'
export type WorldType = 'main' | 'isolated' | 'extension' | 'unknown'

export interface TargetIdentity {
  targetId: string
  viewId: string
  type: 'page' | 'iframe' | 'worker' | 'other'
  parentTargetId?: string
  browserContextGeneration: number
  url: string
  attached: boolean
  owner: 'managed' | 'persistent' | 'external'
  confidence: ContextConfidence
}

export interface FrameIdentity {
  frameId: string
  viewId: string
  targetId: string
  parentFrameId?: string
  mainFrame: boolean
  url: string
  origin: string
  name?: string
  documentGeneration: number
  loaderId?: string
  securityOrigin?: string
  attached: boolean
  oopif: boolean
  confidence: ContextConfidence
}

export interface DocumentIdentity {
  navigationId: string
  frameId: string
  documentGeneration: number
  url: string
  loaderId?: string
  createdAt: number
}

export interface ExecutionContextIdentity {
  executionContextId: number
  viewId: string
  targetId: string
  frameId?: string
  documentGeneration?: number
  worldType: WorldType
  origin?: string
  name?: string
  attached: boolean
  confidence: ContextConfidence
}

export interface CapabilityDegradation {
  code: string
  viewId: string
  targetId?: string
  frameId?: string
  reason: string
  observedAt: number
}

export interface EvidenceContextIdentity {
  targetId?: string
  frameId?: string
  frameDocumentGeneration?: number
  executionContextId?: number
  worldType?: WorldType
  loaderId?: string
}

export interface ContextTopologySnapshot {
  contextTopologySchemaVersion: 1
  sessionId: string
  sessionKey: string
  browserContextGeneration: number
  targets: TargetIdentity[]
  frames: FrameIdentity[]
  documents: DocumentIdentity[]
  executionContexts: ExecutionContextIdentity[]
  degradations: CapabilityDegradation[]
  truncated: {
    targets: boolean
    frames: boolean
    documents: boolean
    executionContexts: boolean
    degradations: boolean
  }
}

export interface ContextTopologyLimits {
  targets: number
  frames: number
  documents: number
  executionContexts: number
  degradations: number
}

export const DEFAULT_CONTEXT_TOPOLOGY_LIMITS: ContextTopologyLimits = {
  targets: 8,
  frames: 16,
  documents: 16,
  executionContexts: 24,
  degradations: 16,
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

export function targetType(value: string): TargetIdentity['type'] {
  if (value === 'page') return 'page'
  if (value === 'iframe') return 'iframe'
  if (/worker/i.test(value)) return 'worker'
  return 'other'
}

export function worldTypeOf(input: { isDefault?: boolean; name?: string; origin?: string }): WorldType {
  if (input.isDefault === true) return 'main'
  if (/extension/i.test(`${input.name ?? ''} ${input.origin ?? ''}`)) return 'extension'
  if ((input.name ?? '') !== '') return 'isolated'
  return 'unknown'
}
