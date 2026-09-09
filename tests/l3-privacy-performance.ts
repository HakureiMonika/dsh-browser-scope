import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { FlightRecorderStore } from '../src/flight-recorder.ts'
import { summarizeInputCharacters } from '../src/input-trace.ts'

const canaries = [
  'L3-OFF-Canary-11a7',
  'L3-ROLLING-Canary-22b8',
  'L3-DEEP-Canary-33c9',
  'L3-OVERLOAD-Canary-44d0',
  'L3-INCIDENT-Canary-55e1',
] as const

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(Math.ceil(ordered.length * ratio) - 1, ordered.length - 1)] ?? 0
}

function sample(mode: 'off' | 'rolling' | 'deep', runs = 10, events = 1000): number[] {
  const durations: number[] = []
  for (let run = 0; run < runs; run += 1) {
    let now = run * 100000
    const recorder = new FlightRecorderStore({ now: () => now })
    recorder.setMode(`perf-${mode}`, `perf-${mode}@${run}`, mode)
    const startedAt = performance.now()
    for (let index = 0; index < events; index += 1) {
      now += 1
      recorder.record(`perf-${mode}`, `perf-${mode}@${run}`, {
        source: mode === 'deep' ? 'system' : 'agent',
        kind: mode === 'deep' ? 'visual-frame' : 'action',
        viewId: 'v1',
        metrics: mode === 'deep'
          ? { width: 1280, height: 720, frameSequence: index + 1, viewportGeneration: 1 }
          : { durationMs: index % 7 },
      })
    }
    durations.push(performance.now() - startedAt)
    recorder.disposeSession(`perf-${mode}@${run}`)
  }
  return durations
}

const privacy = new FlightRecorderStore({ maxEvents: 2, maxBytes: 100000 })
assert.equal(privacy.record('privacy', 'privacy@1', { source: 'user', kind: 'off-input', viewId: 'v1' }), undefined)
privacy.setMode('privacy', 'privacy@1', 'rolling')
privacy.record('privacy', 'privacy@1', { source: 'user', kind: 'rolling-input', viewId: 'v1', input: { sensitivity: 'normal', characters: summarizeInputCharacters(canaries[1]), composing: false, result: 'delivered' } })
privacy.setMode('privacy', 'privacy@1', 'deep')
privacy.record('privacy', 'privacy@1', { source: 'user', kind: 'deep-input', viewId: 'v1', input: { sensitivity: 'sensitive', characters: summarizeInputCharacters(canaries[2]), composing: false, result: 'delivered' } })
const incident = privacy.mark('privacy@1')
privacy.record('privacy', 'privacy@1', { source: 'page', kind: 'incident-error', viewId: 'v1', outcome: 'failed' })
privacy.complete('privacy@1', incident.incidentId)
const privacySerialized = JSON.stringify({ snapshot: privacy.snapshot('privacy@1'), chunks: privacy.chunks('privacy@1'), incident: privacy.incident('privacy@1', incident.incidentId) })
assert.equal(canaries.some(canary => privacySerialized.includes(canary)), false)
assert.equal(privacy.snapshot('privacy@1').overload, 'metadata-only')
privacy.disposeSession('privacy@1')

const off = sample('off')
const rolling = sample('rolling')
const deep = sample('deep')
const offMedian = percentile(off, 0.5)
const rollingP95 = percentile(rolling, 0.95)
const deepP95 = percentile(deep, 0.95)
assert.ok(rollingP95 - offMedian < 100, `Rolling Host hot-path p95 increment is too high: ${rollingP95 - offMedian}ms per 1000 events`)
assert.ok(deepP95 - offMedian < 100, `Deep Host hot-path p95 increment is too high: ${deepP95 - offMedian}ms per 1000 events`)

let virtualNow = 0
const longRun = new FlightRecorderStore({ now: () => virtualNow })
longRun.setMode('long-run', 'long-run@1', 'rolling')
const heapBefore = process.memoryUsage().heapUsed
for (let second = 0; second <= 1800; second += 1) {
  virtualNow = second * 1000
  longRun.record('long-run', 'long-run@1', { source: 'agent', kind: 'virtual-minute-action', viewId: 'v1', metrics: { second } })
}
const heapAfter = process.memoryUsage().heapUsed
const longSnapshot = longRun.snapshot('long-run@1')
assert.ok((longSnapshot.oldestEventAt ?? 0) >= virtualNow - 180000)
assert.ok(longSnapshot.eventCount <= 181)
assert.ok(longSnapshot.byteSize < 1024 * 1024)
longRun.disposeSession('long-run@1')
assert.equal(longRun.record('long-run', 'long-run@1', { source: 'agent', kind: 'after-dispose', viewId: 'v1' }), undefined)

process.stdout.write(`${JSON.stringify({
  ok: true,
  privacyStages: ['off', 'rolling', 'deep', 'metadata-only', 'incident'],
  canaryHits: 0,
  samples: { off: off.length, rolling: rolling.length, deep: deep.length },
  millisecondsPer1000Events: {
    off: { median: offMedian, p95: percentile(off, 0.95), p99: percentile(off, 0.99) },
    rolling: { median: percentile(rolling, 0.5), p95: rollingP95, p99: percentile(rolling, 0.99) },
    deep: { median: percentile(deep, 0.5), p95: deepP95, p99: percentile(deep, 0.99) },
  },
  virtualLongRun: {
    durationMinutes: 30,
    retentionMs: longSnapshot.retentionMs,
    eventCount: longSnapshot.eventCount,
    byteSize: longSnapshot.byteSize,
    heapDeltaBytes: heapAfter - heapBefore,
    overload: longSnapshot.overload,
  },
}, null, 2)}\n`)
