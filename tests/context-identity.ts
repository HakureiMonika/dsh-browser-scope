import assert from 'node:assert/strict'
import { ContextIdentityRegistry } from '../src/context-registry.ts'
import { targetType, worldTypeOf } from '../src/context-identity.ts'

const registry = new ContextIdentityRegistry()
registry.startSession('session-a', 'session-a@1', 3)
registry.upsertTarget('session-a@1', {
  targetId: 'target-main',
  viewId: 'v1',
  type: 'page',
  browserContextGeneration: 3,
  url: 'http://127.0.0.1/',
  attached: true,
  owner: 'persistent',
  confidence: 'confirmed',
})
const main = registry.upsertFrame({ sessionKey: 'session-a@1', viewId: 'v1', frameId: 'frame-main', targetId: 'target-main', mainFrame: true, url: 'http://127.0.0.1/', loaderId: 'loader-1' })
const child = registry.upsertFrame({ sessionKey: 'session-a@1', viewId: 'v1', frameId: 'frame-child', targetId: 'target-main', parentFrameId: 'frame-main', mainFrame: false, url: 'http://localhost/child', loaderId: 'loader-c1' })
assert.equal(main.documentGeneration, 1)
assert.equal(child.documentGeneration, 1)

const repeated = registry.upsertFrame({ sessionKey: 'session-a@1', viewId: 'v1', frameId: 'frame-child', targetId: 'target-main', parentFrameId: 'frame-main', mainFrame: false, url: 'http://localhost/child', loaderId: 'loader-c1' })
assert.equal(repeated.documentGeneration, 1)
const navigated = registry.upsertFrame({ sessionKey: 'session-a@1', viewId: 'v1', frameId: 'frame-child', targetId: 'target-main', parentFrameId: 'frame-main', mainFrame: false, url: 'http://localhost/next', loaderId: 'loader-c2' })
assert.equal(navigated.documentGeneration, 2)
registry.updateSameDocument('session-a@1', 'frame-child', 'http://localhost/next#route')
assert.equal(registry.snapshot('session-a@1').frames.find(frame => frame.frameId === 'frame-child')?.documentGeneration, 2)

registry.upsertExecutionContext('session-a@1', {
  executionContextId: 17,
  viewId: 'v1',
  targetId: 'target-main',
  frameId: 'frame-child',
  worldType: 'main',
  origin: 'http://localhost',
  attached: true,
  confidence: 'confirmed',
})
assert.deepEqual(registry.executionContext('session-a@1', 17), {
  targetId: 'target-main',
  frameId: 'frame-child',
  frameDocumentGeneration: 2,
  executionContextId: 17,
  worldType: 'main',
})

registry.upsertTarget('session-a@1', {
  targetId: 'target-oopif',
  viewId: 'v1',
  type: 'iframe',
  parentTargetId: 'target-main',
  browserContextGeneration: 3,
  url: 'http://localhost/next#route',
  attached: true,
  owner: 'persistent',
  confidence: 'confirmed',
})
assert.equal(registry.alignOopif('session-a@1', 'target-oopif', 'http://localhost/next#route')?.frameId, 'frame-child')
assert.equal(registry.frameContext('session-a@1', 'frame-child').targetId, 'target-oopif')

registry.startSession('session-b', 'session-b@2', 3)
assert.equal(registry.snapshot('session-b@2').frames.length, 0)
registry.detachFrame('session-a@1', 'frame-child')
assert.deepEqual(registry.frameContext('session-a@1', 'frame-child'), {})
assert.equal(registry.executionContext('session-a@1', 17).targetId, undefined)

for (let index = 0; index < 20; index += 1) {
  registry.upsertTarget('session-a@1', {
    targetId: `target-${index}`,
    viewId: 'v1',
    type: 'other',
    browserContextGeneration: 3,
    url: `about:blank#${index}`,
    attached: true,
    owner: 'persistent',
    confidence: 'candidate',
  })
}
const bounded = registry.snapshot('session-a@1', { targets: 4, frames: 4, documents: 4, executionContexts: 4, degradations: 4 })
assert.equal(bounded.targets.length, 4)
assert.equal(bounded.truncated.targets, true)
assert.deepEqual(JSON.parse(JSON.stringify(bounded)), bounded)

registry.migrateSession('session-a@1', 'session-a@final')
assert.equal(registry.snapshot('session-a@final').sessionKey, 'session-a@final')
registry.invalidateSession('session-a@final', 4)
assert.equal(registry.snapshot('session-a@final').browserContextGeneration, 4)
assert.equal(registry.snapshot('session-a@final').targets.length, 0)
registry.invalidateSession('session-a@final')
assert.throws(() => registry.snapshot('session-a@final'))

assert.equal(targetType('iframe'), 'iframe')
assert.equal(targetType('service_worker'), 'worker')
assert.equal(worldTypeOf({ isDefault: true }), 'main')
assert.equal(worldTypeOf({ name: '__playwright_utility_world__' }), 'isolated')
assert.equal(worldTypeOf({ name: 'extension', origin: 'chrome-extension://test' }), 'extension')

process.stdout.write(`${JSON.stringify({
  ok: true,
  mainDocumentGeneration: main.documentGeneration,
  childDocumentGeneration: navigated.documentGeneration,
  oopifAligned: true,
  sessionIsolation: true,
  boundedTargets: bounded.targets.length,
  jsonRoundTrip: true,
}, null, 2)}\n`)
