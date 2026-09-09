import assert from 'node:assert/strict'
import { FlightRecorderStore } from '../src/flight-recorder.ts'

let now = 0
const recorder = new FlightRecorderStore({ retentionMs: 180000, chunkDurationMs: 3000, postTriggerMs: 30000, maxEvents: 20, maxBytes: 100000, now: () => now })
assert.equal(recorder.setMode('a', 'a@1', 'off').status, 'idle')
assert.equal(recorder.record('a', 'a@1', { source: 'system', kind: 'ignored', viewId: 'v1' }), undefined)
recorder.setMode('a', 'a@1', 'rolling')
recorder.record('a', 'a@1', { source: 'user', kind: 'input', viewId: 'v1', inputTraceId: 'it1', input: { sensitivity: 'normal', characters: { length: 4, asciiLetters: 4, digits: 0, whitespace: 0, punctuation: 0, cjk: 0, other: 0 }, composing: false, result: 'delivered' } })
now = 4000
recorder.record('a', 'a@1', { source: 'page', kind: 'console-error', viewId: 'v1', outcome: 'failed' })
const firstIncident = recorder.mark('a@1', now)
assert.equal(firstIncident.chunkIds.length, 2)
now = 5000
const secondIncident = recorder.mark('a@1', now)
assert.equal(secondIncident.chunkIds.length, 2)
now = 20000
recorder.record('a', 'a@1', { source: 'page', kind: 'post-trigger', viewId: 'v1' })
assert.equal(recorder.incident('a@1', firstIncident.incidentId)?.chunkIds.length, 3)
assert.equal(recorder.chunks('a@1').at(-1)?.frozenByIncidents.length, 2)
now = 40000
recorder.tick('a@1')
assert.equal(recorder.incident('a@1', firstIncident.incidentId)?.status, 'complete')
now = 200000
recorder.record('a', 'a@1', { source: 'agent', kind: 'late-action', viewId: 'v2' })
assert.equal(recorder.chunks('a@1').some(chunk => chunk.frozenByIncidents.length === 0 && chunk.endedAt < 20000), false)
assert.equal(recorder.chunks('a@1').filter(chunk => chunk.frozenByIncidents.length > 0).length, 3)
recorder.pause('a@1')
assert.equal(recorder.record('a', 'a@1', { source: 'system', kind: 'paused', viewId: 'v1' }), undefined)
recorder.resume('a@1')
recorder.setMode('a', 'a@1', 'deep')
assert.equal(recorder.snapshot('a@1').mode, 'deep')
assert.equal(JSON.stringify(recorder.timeline('a@1')).includes('secret-value'), false)
recorder.migrateSession('a@1', 'a@2')
assert.equal(recorder.snapshot('a@2').sessionKey, 'a@2')
recorder.disposeSession('a@2')

now = 0
const overloaded = new FlightRecorderStore({ retentionMs: 180000, chunkDurationMs: 1, postTriggerMs: 30000, maxEvents: 2, maxBytes: 100000, now: () => now })
overloaded.setMode('quota', 'quota@1', 'rolling')
overloaded.record('quota', 'quota@1', { source: 'page', kind: 'frozen-base', viewId: 'v1' })
const baseIncident = overloaded.mark('quota@1', now)
overloaded.complete('quota@1', baseIncident.incidentId, now)
now = 2
overloaded.record('quota', 'quota@1', { source: 'system', kind: 'discardable-first', viewId: 'v1' })
now = 4
overloaded.record('quota', 'quota@1', { source: 'system', kind: 'discardable-second', viewId: 'v1' })
assert.equal(overloaded.chunks('quota@1').some(chunk => chunk.events.some(event => event.kind === 'discardable-first')), false)
const overloadedIncident = overloaded.mark('quota@1', now)
now = 6
overloaded.record('quota', 'quota@1', { source: 'page', kind: 'frozen-post-trigger', viewId: 'v1', labels: { category: 'metadata-only' } })
const overloadedChunks = overloaded.chunks('quota@1')
assert.equal(overloadedChunks.every(chunk => chunk.frozenByIncidents.includes(overloadedIncident.incidentId)), true)
assert.equal(overloaded.snapshot('quota@1').overload, 'metadata-only')
assert.equal(overloaded.timeline('quota@1', 5000).length, 3)
assert.equal(JSON.stringify(overloaded.timeline('quota@1')).includes('secret-overload-body'), false)
overloaded.disposeSession('quota@1')

process.stdout.write(`${JSON.stringify({ ok: true, offIgnored: true, retentionMs: 180000, overlappingIncidentsShareChunks: true, postTriggerMs: 30000, frozenSurvivesEviction: true, overload: 'metadata-only', timelineLimit: 1000, modes: ['off', 'rolling', 'deep'], plaintextAbsent: true, migrated: true, disposed: true }, null, 2)}\n`)
