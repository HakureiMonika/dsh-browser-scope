import assert from 'node:assert/strict'
import { ApplicationRegistry } from '../src/application-registry.ts'
const registry = new ApplicationRegistry()
const shell = registry.upsert('a@1', { viewId: 'v1', kind: 'shell', name: 'Shell', origin: 'https://app.test', signals: ['main-frame'], counterEvidence: [], confidence: 'confirmed' })
const remote = registry.upsert('a@1', { viewId: 'v1', kind: 'module-federation', name: 'Release', rootSelector: '#release-root', signals: ['explicit-root-hint', 'remote-entry'], counterEvidence: [], confidence: 'confirmed', buildIds: ['b1'] })
registry.bindBuild('a@1', remote.applicationId, 'b2')
assert.notEqual(shell.applicationId, remote.applicationId)
assert.deepEqual(registry.snapshot('a@1').applications.find(item => item.applicationId === remote.applicationId)?.buildIds, ['b1', 'b2'])
registry.deactivateView('a@1', 'v1')
assert.equal(registry.snapshot('a@1').applications.every(item => !item.active), true)
registry.migrateSession('a@1', 'a@2')
assert.equal(registry.snapshot('a@2').applications.length, 2)
process.stdout.write(`${JSON.stringify({ ok: true, shellAndRemoteDistinct: true, buildsBounded: true, lifecycle: true, migrated: true }, null, 2)}\n`)
