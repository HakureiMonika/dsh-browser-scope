export type RendererType = 'html' | 'shadow-dom' | 'svg' | 'canvas' | 'unknown'
export type ClosedShadowCapability = 'open-inspectable' | 'closed-observable-readonly' | 'host-only' | 'closed-unavailable' | 'not-shadow-host'

export interface SurfacePoint {
  x: number
  y: number
}

export interface SurfaceRect extends SurfacePoint {
  width: number
  height: number
}

export interface SurfaceMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface ShadowSurfaceEvidence {
  rendererType: 'shadow-dom'
  rootType: 'open' | 'closed' | 'unknown'
  capability: ClosedShadowCapability
  depth: number
  maxDepth: number
  truncated: boolean
  degradationReason?: 'max-shadow-depth-exceeded'
  rootGeneration: number
  shadowHosts: Array<{ tag: string; id?: string }>
  slotPath: Array<{ name: string; assigned: boolean }>
  composedTreePath: string[]
  retargetedTarget?: { tag: string; id?: string }
  shadowTargetMatches: boolean
}

export interface SvgSurfaceEvidence {
  rendererType: 'svg'
  tag: string
  localBBox?: SurfaceRect
  clientRect: SurfaceRect
  ctm?: SurfaceMatrix
  screenCtm?: SurfaceMatrix
  viewBox?: SurfaceRect
  preserveAspectRatio?: string
  fill: string
  stroke: string
  pointerEvents: string
  clipPath?: string
  mask?: string
  filter?: string
  pointerHit: boolean
}

export interface CanvasCoordinateMapping {
  viewportPoint: SurfacePoint
  canvasCssPoint: SurfacePoint
  canvasBackingPoint: SurfacePoint
  inBounds: boolean
}

export interface CanvasSurfaceEvidence {
  rendererType: 'canvas'
  capabilityLevel: 'surface-only' | 'pixel-summary-available' | 'tainted' | 'unavailable'
  contextType: '2d' | 'webgl' | 'webgl2' | 'bitmaprenderer' | 'unknown'
  cssWidth: number
  cssHeight: number
  backingWidth: number
  backingHeight: number
  deviceScaleFactor: number
  backingScaleX: number | null
  backingScaleY: number | null
  coordinate: CanvasCoordinateMapping
}

export type SurfaceEvidence =
  | { rendererType: 'html' }
  | ShadowSurfaceEvidence
  | SvgSurfaceEvidence
  | CanvasSurfaceEvidence
  | { rendererType: 'unknown' }

export function transformPoint(matrix: SurfaceMatrix, point: SurfacePoint): SurfacePoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

export function canvasCoordinateMapping(input: {
  rect: SurfaceRect
  backingWidth: number
  backingHeight: number
  viewportPoint: SurfacePoint
}): CanvasCoordinateMapping {
  const local = {
    x: input.viewportPoint.x - input.rect.x,
    y: input.viewportPoint.y - input.rect.y,
  }
  const scaleX = input.rect.width === 0 ? 0 : input.backingWidth / input.rect.width
  const scaleY = input.rect.height === 0 ? 0 : input.backingHeight / input.rect.height
  return {
    viewportPoint: input.viewportPoint,
    canvasCssPoint: local,
    canvasBackingPoint: { x: local.x * scaleX, y: local.y * scaleY },
    inBounds: local.x >= 0 && local.y >= 0 && local.x < input.rect.width && local.y < input.rect.height,
  }
}

export function matrixFrom(value: { a: number; b: number; c: number; d: number; e: number; f: number } | null): SurfaceMatrix | undefined {
  if (value === null) return undefined
  return { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f }
}
