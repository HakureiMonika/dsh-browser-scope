import assert from 'node:assert/strict'
import { CdpContextAdapter, type ContextCdpTransport } from '../src/cdp-context-adapter.ts'
import { ContextIdentityRegistry } from '../src/context-registry.ts'

class FakeTransport implements ContextCdpTransport {
  readonly calls: string[] = []
  readonly listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>()

  async send(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method)
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-main', type: 'page', url: 'https://shell.test/' } }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main', loaderId: 'loader-main', url: 'https://shell.test/', securityOrigin: 'https://shell.test' } } }
    return {}
  }

  on(event: string, listener: (payload: Record<string, unknown>) => void): ContextCdpTransport {
    const values = this.listeners.get(event) ?? new Set()
    values.add(listener)
    this.listeners.set(event, values)
    return this
  }

  off(event: string, listener: (payload: Record<string, unknown>) => void): ContextCdpTransport {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

const registry = new ContextIdentityRegistry()
const transport = new FakeTransport()
const adapter = new CdpContextAdapter(transport, registry, {
  sessionId: 'session-a',
  sessionKey: 'session-a@1',
  viewId: 'v1',
  browserContextGeneration: 2,
  owner: 'persistent',
})

await adapter.enable()
assert.deepEqual(transport.calls.slice(0, 4), ['Page.enable', 'Target.getTargetInfo', 'Page.getFrameTree', 'Runtime.enable'])
assert.equal(adapter.snapshot().frames.find(frame => frame.mainFrame)?.documentGeneration, 1)

transport.emit('Page.frameAttached', { frameId: 'frame-child', parentFrameId: 'frame-main' })
assert.equal(adapter.snapshot().frames.find(frame => frame.frameId === 'frame-child')?.documentGeneration, 0)
transport.emit('Page.frameNavigated', { frame: { id: 'frame-child', parentId: 'frame-main', loaderId: 'loader-child-1', url: 'https://shell.test/child', name: 'child' } })
assert.equal(adapter.snapshot().frames.find(frame => frame.frameId === 'frame-child')?.documentGeneration, 1)
transport.emit('Page.navigatedWithinDocument', { frameId: 'frame-child', url: 'https://shell.test/child#route' })
assert.equal(adapter.snapshot().frames.find(frame => frame.frameId === 'frame-child')?.documentGeneration, 1)
transport.emit('Page.frameNavigated', { frame: { id: 'frame-child', parentId: 'frame-main', loaderId: 'loader-child-2', url: 'https://shell.test/child-next', name: 'child' } })
assert.equal(adapter.snapshot().frames.find(frame => frame.frameId === 'frame-child')?.documentGeneration, 2)

transport.emit('Runtime.executionContextCreated', { context: { id: 7, origin: 'https://shell.test', name: '', auxData: { frameId: 'frame-child', isDefault: true } } })
assert.equal(adapter.contextForExecution(7).worldType, 'main')
transport.emit('Page.frameDetached', { frameId: 'frame-child', reason: 'swap' })
assert.equal(adapter.snapshot().frames.some(frame => frame.frameId === 'frame-child'), true)
transport.emit('Page.frameAttached', { frameId: 'target-oopif-race', parentFrameId: 'frame-main' })
transport.emit('Page.frameNavigated', { frame: { id: 'target-oopif-race', parentId: 'frame-main', url: 'https://cross.test/race' } })
assert.equal(adapter.snapshot().frames.find(frame => frame.frameId === 'target-oopif-race')?.documentGeneration, 0)
transport.emit('Target.attachedToTarget', { sessionId: 'oopif-race-session', targetInfo: { targetId: 'target-oopif-race', type: 'iframe', url: 'https://cross.test/race', openerId: 'target-main' } })
const oopifRace = adapter.snapshot().frames.find(frame => frame.frameId === 'target-oopif-race')
assert.equal(oopifRace?.oopif, true)
assert.equal(oopifRace?.documentGeneration, 1)
assert.equal(adapter.snapshot().documents.some(document => document.frameId === 'target-oopif-race' && document.documentGeneration === 1), true)
transport.emit('Target.attachedToTarget', { sessionId: 'oopif-session', targetInfo: { targetId: 'target-oopif', type: 'iframe', url: 'https://cross.test/frame', openerId: 'target-main' } })
const oopif = adapter.snapshot().frames.find(frame => frame.targetId === 'target-oopif')
assert.equal(oopif?.oopif, true)
assert.equal(oopif?.documentGeneration, 1)
assert.equal(adapter.snapshot().degradations.some(item => item.code === 'oopif-target-context-limited'), true)

transport.emit('Page.frameDetached', { frameId: 'frame-child', reason: 'remove' })
assert.equal(adapter.snapshot().frames.some(frame => frame.frameId === 'frame-child'), false)
adapter.dispose()
assert.equal(adapter.isDisposed(), true)
assert.equal(transport.calls.includes('Target.setAutoAttach'), true)
assert.equal(transport.calls.includes('Target.detachFromTarget'), true)

process.stdout.write(`${JSON.stringify({
  ok: true,
  enableOrder: transport.calls.slice(0, 4),
  sameDocumentPreserved: true,
  crossDocumentAdvanced: true,
  oopifIdentified: true,
  oopifPlaceholderCommitted: true,
  swapPreserved: true,
  removeDetached: true,
  disposeDetachedTarget: true,
}, null, 2)}\n`)
