import { existsSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { resolveConfig } from '../src/policy.ts'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const extensionId = 'aapbdbdomjkkjkaonfhkkikfgjllcleb'
const root = resolve('.extension-runtime-e2e')
const chromiumSource = resolve('.chromium-acceptance')
const chromiumLink = resolve(root, 'chromium')

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
assert(existsSync(resolve(chromiumSource, 'chromium-1228', 'chrome-win64', 'chrome.exe')), 'extension runtime test requires the temporary plugin Chromium')
await symlink(chromiumSource, chromiumLink, 'junction')

const runtime = new BrowserRuntime(resolveConfig({
  artifactRoot: root,
  headless: true,
  allowLoopback: true,
  allowPrivateNetwork: true,
}), {
  async saveImage() {
    throw new Error('extension runtime test does not save images')
  },
} as never)

try {
  const tab = await runtime.panelTabs('extension-runtime', { action: 'new' })
  assert(tab.ok === true, 'extension runtime test could not create the default persistent browser')
  const installed = await runtime.panelExtensions('extension-runtime', {
    action: 'install',
    extension: extensionId,
    applyMode: 'now',
  })
  assert(installed.ok === true, `extension runtime install failed: ${JSON.stringify(installed)}`)
  const snapshot = await runtime.panelSnapshot('extension-runtime', 'extensions')
  const extension = snapshot.extensions?.find(item => item.extensionId === extensionId)
  assert(extension?.name === 'Google Translate' && extension.version === '2.0.17', 'extension runtime metadata is incorrect')
  assert(extension.enabled === true && extension.loaded === true && extension.pendingRestart === false, 'extension runtime did not report the installed extension as loaded')

  const state = (runtime as unknown as { state: { sessions: Map<string, { context: { serviceWorkers(): Array<{ url(): string }> } }> } }).state
  const session = [...state.sessions.values()][0]
  assert(session !== undefined, 'extension runtime session state is missing')
  let workers = session.context.serviceWorkers()
  for (let attempt = 0; attempt < 30 && workers.length === 0; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    workers = session.context.serviceWorkers()
  }
  assert(workers.some(worker => worker.url().startsWith(`chrome-extension://${extensionId}/`)), 'installed Chrome Web Store extension service worker did not load')

  const removed = await runtime.panelExtensions('extension-runtime', {
    action: 'uninstall',
    extensionId,
    applyMode: 'now',
  })
  assert(removed.ok === true, `extension runtime uninstall failed: ${JSON.stringify(removed)}`)
  const after = await runtime.panelSnapshot('extension-runtime', 'extensions')
  assert(after.extensions?.some(item => item.extensionId === extensionId) !== true, 'extension remained registered after immediate uninstall')
  process.stdout.write(`${JSON.stringify({ ok: true, extensionId, name: extension.name, version: extension.version })}\n`)
} finally {
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
}
