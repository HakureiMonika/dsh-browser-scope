import assert from 'node:assert/strict'
import { InputTraceStore, classifyInputFailure, inputSensitivity, summarizeInputCharacters } from '../src/input-trace.ts'

const secret = 'Ab中 9!'
const characters = summarizeInputCharacters(secret)
assert.deepEqual(characters, { length: 6, asciiLetters: 2, digits: 1, whitespace: 1, punctuation: 1, cjk: 1, other: 0 })
assert.equal(inputSensitivity({ inputType: 'password' }), 'sensitive')
assert.equal(inputSensitivity({ autocomplete: 'one-time-code' }), 'security-challenge')
assert.equal(inputSensitivity({ name: 'email' }), 'potentially-sensitive')

const store = new InputTraceStore(2)
store.start({ inputTraceId: 'it1', sessionKey: 'a@1', viewId: 'v1', action: 'insert-text', sensitivity: 'normal', characters, composing: true, timestamp: 10 })
store.stage('a@1', 'it1', { stage: 'client-normalized', timestamp: 11, outcome: 'observed' })
store.stage('a@1', 'it1', { stage: 'rpc-received', timestamp: 12, outcome: 'delivered' })
store.stage('a@1', 'it1', { stage: 'host-dispatched', timestamp: 13, outcome: 'delivered' })
store.stage('a@1', 'it1', { stage: 'dom-observed', timestamp: 14, outcome: 'observed' })
const finished = store.finish('a@1', 'it1', { timestamp: 15, result: 'delivered' })
assert.equal(finished?.stages.length, 6)
assert.equal(JSON.stringify(finished).includes(secret), false)
store.ensure({ inputTraceId: 'it1', sessionKey: 'a@1', viewId: 'v1', action: 'insert-text', sensitivity: 'sensitive', characters, composing: false, timestamp: 16 })
assert.equal(store.get('a@1', 'it1')?.sensitivity, 'sensitive')
for (const result of ['dropped-at-client-normalization', 'dropped-at-rpc', 'dropped-at-host-bridge', 'dropped-before-dom-event', 'dropped-after-beforeinput'] as const) {
  const id = `failure-${result}`
  store.start({ inputTraceId: id, sessionKey: 'failure@1', viewId: 'v1', action: 'insert-text', sensitivity: 'normal', composing: false, timestamp: 1 })
  store.finish('failure@1', id, { timestamp: 2, result, reason: result })
  assert.equal(store.get('failure@1', id)?.result, result)
}
assert.equal(classifyInputFailure({ stage: 'client-normalized', outcome: 'lost' }), 'dropped-at-client-normalization')
assert.equal(classifyInputFailure({ stage: 'rpc-received', outcome: 'lost' }), 'dropped-at-rpc')
assert.equal(classifyInputFailure({ stage: 'host-dispatched', outcome: 'lost' }), 'dropped-at-host-bridge')
assert.equal(classifyInputFailure({ stage: 'dom-observed', outcome: 'lost' }), 'dropped-before-dom-event')
assert.equal(classifyInputFailure({ stage: 'final-state', outcome: 'lost', reason: 'beforeinput-without-input' }), 'dropped-after-beforeinput')
assert.equal(classifyInputFailure({ stage: 'final-state', outcome: 'prevented' }), 'prevented-by-page')
store.start({ inputTraceId: 'it2', sessionKey: 'a@1', viewId: 'v1', action: 'paste', sensitivity: 'sensitive', composing: false, timestamp: 20 })
store.start({ inputTraceId: 'it3', sessionKey: 'a@1', viewId: 'v1', action: 'key-press', sensitivity: 'normal', composing: false, timestamp: 30 })
assert.deepEqual(store.list('a@1').map(item => item.inputTraceId), ['it2', 'it3'])
store.migrateSession('a@1', 'a@2')
assert.equal(store.get('a@2', 'it3')?.sessionKey, 'a@2')

process.stdout.write(`${JSON.stringify({ ok: true, characters, sixStages: true, authoritativeSensitivity: true, failureResults: true, failureClassifier: true, plaintextAbsent: true, bounded: true, migrated: true }, null, 2)}\n`)
