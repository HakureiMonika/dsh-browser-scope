import { createHash } from 'node:crypto'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

export interface GeneratedLocation {
  url: string
  line: number
  column: number
}

export interface SourceMapBuildInput {
  documentUrl: string
  generatedContentSha256: string
  buildId?: string
}

export interface SourceMapBuildIdentity {
  buildId: string
  documentUrl: string
  generatedUrl: string
  generatedContentSha256: string
  sourceMapSha256: string
}

export interface SourceMapResolution {
  schemaVersion?: 2
  confidence: 'confirmed' | 'candidate' | 'external' | 'unavailable'
  generated: GeneratedLocation
  sourceMapUrl?: string
  sourceMapId?: string
  build?: SourceMapBuildIdentity
  workspace?: {
    path: string
    confidence: 'mapped-workspace-unconfirmed' | 'external'
    sourcesContentSha256?: string
  }
  original?: {
    source: string
    line: number
    column: number
    name?: string
    sourcesContentBytes?: number
    sourcesContentSha256?: string
  }
  reason?: string
}

function normalizeSourceCandidate(source: string): { path: string; confidence: 'mapped-workspace-unconfirmed' | 'external' } {
  const normalizedSeparators = source.replace(/\\/g, '/')
  if (/^(?:https?:|node:|data:|chrome-extension:|edge-extension:|file:)/i.test(normalizedSeparators)) {
    return { path: normalizedSeparators.slice(0, 1000), confidence: 'external' }
  }
  const withoutBundlerScheme = normalizedSeparators.replace(/^(?:webpack|vite|rollup):\/+?/i, '')
  const withoutSuffix = withoutBundlerScheme.replace(/[?#].*$/, '')
  const parts: string[] = []
  for (const part of withoutSuffix.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      continue
    }
    parts.push(part)
  }
  const path = parts.join('/').slice(0, 1000)
  const external = path === '' || path.includes('/node_modules/') || path.startsWith('node_modules/')
  return { path: path || normalizedSeparators.slice(0, 1000), confidence: external ? 'external' : 'mapped-workspace-unconfirmed' }
}

export function parseGeneratedLocation(stack: string | undefined): GeneratedLocation | undefined {
  if (stack === undefined) return undefined
  const matches = [...stack.matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)]
  const match = matches.at(-1)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined
  return {
    url: match[1],
    line: Number(match[2]),
    column: Math.max(0, Number(match[3]) - 1),
  }
}

export function resolveSourceMap(
  generated: GeneratedLocation,
  sourceMapUrl: string,
  sourceMap: unknown,
  buildInput?: SourceMapBuildInput,
): SourceMapResolution {
  try {
    const sourceMapSha256 = createHash('sha256').update(JSON.stringify(sourceMap)).digest('hex')
    const sourceMapId = `sm-${sourceMapSha256.slice(0, 20)}`
    const build = buildInput === undefined
      ? undefined
      : {
          buildId: buildInput.buildId ?? `build-${createHash('sha256').update(JSON.stringify([
            buildInput.documentUrl,
            generated.url,
            buildInput.generatedContentSha256,
            sourceMapSha256,
          ])).digest('hex').slice(0, 20)}`,
          documentUrl: buildInput.documentUrl,
          generatedUrl: generated.url,
          generatedContentSha256: buildInput.generatedContentSha256,
          sourceMapSha256,
        }
    const map = new TraceMap(sourceMap as ConstructorParameters<typeof TraceMap>[0], sourceMapUrl)
    const original = originalPositionFor(map, { line: generated.line, column: generated.column })
    if (original.source === null || original.line === null || original.column === null) {
      return { schemaVersion: 2, confidence: 'unavailable', generated, sourceMapUrl, sourceMapId, ...(build === undefined ? {} : { build }), reason: 'generated position has no original mapping' }
    }
    const sourceIndex = map.resolvedSources.findIndex(source => source === original.source)
    const declaredSource = sourceIndex < 0 ? original.source : map.sources[sourceIndex] ?? original.source
    const content = sourceIndex < 0 ? null : map.sourcesContent?.[sourceIndex] ?? null
    const external = /^(?:https?:|node:)/i.test(declaredSource)
    const workspaceCandidate = normalizeSourceCandidate(declaredSource)
    const sourcesContentSha256 = content === null ? undefined : createHash('sha256').update(content).digest('hex')
    return {
      schemaVersion: 2,
      confidence: external ? 'external' : content === null ? 'candidate' : 'confirmed',
      generated,
      sourceMapUrl,
      sourceMapId,
      ...(build === undefined ? {} : { build }),
      workspace: {
        ...workspaceCandidate,
        ...(sourcesContentSha256 === undefined ? {} : { sourcesContentSha256 }),
      },
      original: {
        source: declaredSource,
        line: original.line,
        column: original.column,
        ...(original.name === null ? {} : { name: original.name }),
        ...(content === null
          ? {}
          : {
              sourcesContentBytes: Buffer.byteLength(content),
              sourcesContentSha256,
            }),
      },
    }
  } catch (error) {
    return {
      schemaVersion: 2,
      confidence: 'unavailable',
      generated,
      sourceMapUrl,
      reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }
  }
}
