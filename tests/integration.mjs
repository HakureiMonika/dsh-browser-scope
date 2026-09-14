import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 默认验证工作树构建；冻结包验收通过该只读入口改为加载 npm 隔离安装后的包字节。
const packageSourceRoot = resolve(
  process.env.DSH_BROWSER_SCOPE_PACKAGE_ROOT
    ?? root,
)
const runtime = join(root, '.runtime')
const home = join(runtime, 'home')
const profile = join(home, 'profiles', 'test')
const modules = join(profile, 'node_modules')
const require = createRequire(import.meta.url)
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installedPackageRoot = name => dirname(require.resolve(`${name}/package.json`))
const installedPackageEntry = name => require.resolve(name)
const installedPackages = new Set([
  ...Object.keys(packageManifest.dependencies ?? {}),
  ...Object.keys(packageManifest.devDependencies ?? {}),
].filter(name => name.startsWith('@deepseek-ai/') || name === 'playwright-core'))
const appBootAnchor = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
const artifactRoot = join(runtime, 'artifacts')
// 浏览器集成复用已验收的离线 Chromium 缓存，禁止回归过程隐式下载，也禁止把内部 .acceptance 路径写入公开源码。
const chromiumRootInput = process.env.DSH_BROWSER_SCOPE_CHROMIUM_ROOT
if (chromiumRootInput === undefined || chromiumRootInput.trim() === '') {
  throw new Error('DSH_BROWSER_SCOPE_CHROMIUM_ROOT is required for the full browser integration test')
}
const acceptanceChromiumRoot = resolve(chromiumRootInput)
const clientSource = readFileSync(join(root, 'src', 'client', 'index.tsx'), 'utf8')
const runtimeSource = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8')
const controllerSource = readFileSync(join(root, 'src', 'browser-controller.ts'), 'utf8')
const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const panelCssSource = readFileSync(join(root, 'src', 'client', 'panel.module.css'), 'utf8')
const result = { ok: false, stages: {}, cleanup: {} }
const packageName = 'dsh-browser-scope'
class WallClockMeasurementComplete extends Error {
  constructor() {
    super('wall-clock measurement complete')
    this.name = 'WallClockMeasurementComplete'
  }
}
let ctx
let server
let port
let externalBrowser
let externalCdpPort
const seededExtensionPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' })

function extensionIdFromPublicKey(publicKey) {
  return [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
    .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join('')
}

function assert(value, message) { if (!value) throw new Error(message) }
function profileSegment(sessionId) { return createHash('sha256').update(sessionId).digest('hex').slice(0, 32) }
function runtimeCanaryHits(path, canaries) {
  if (!existsSync(path)) return []
  const hits = []
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', 'chromium', 'extensions', 'seed-extensions'].includes(entry.name)) continue
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
        continue
      }
      let data
      try {
        data = readFileSync(target)
      } catch {
        continue
      }
      for (const canary of canaries) if (data.includes(Buffer.from(canary))) hits.push({ path: target, canary })
    }
  }
  return hits
}
function seedSharedExtension(enabled = false) {
  // 测试扩展的registry ID、Manifest key和Chromium运行时Origin必须来自同一SPKI，否则Popup导航会被浏览器按未知扩展Origin拒绝。
  const extensionId = extensionIdFromPublicKey(seededExtensionPublicKey)
  const path = join(artifactRoot, 'seed-extensions', 'shared', extensionId)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Seed shared', version: '1.0.0', key: seededExtensionPublicKey.toString('base64'), action: { default_popup: 'popup.html' } }))
  writeFileSync(join(path, 'popup.html'), '<!doctype html><button id="popup-action">Popup action</button>')
  const directory = join(artifactRoot, 'extensions', 'shared')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'registry.json'), `${JSON.stringify({ version: 1, extensions: [{ extensionId, name: 'Seed shared', version: '1.0.0', enabled, installedAt: 1, sourceUrl: 'https://chromewebstore.google.com/', path }] }, null, 2)}\n`)
  return extensionId
}
function link(target, path) { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path, 'junction') }
function fakeAgent(id, origin) {
  const events = [{ type: 'turn/start', data: { turn: 0 } }]
  const injected = []
  return {
    id,
    injected,
    inject(message) { injected.push(message) },
    session: {
      id,
      header: { id, createdAt: id === 'a' ? 1 : 2, ...(origin === undefined ? {} : { origin }) },
      events,
      get seq() { return events.length },
      eventAt(sequence) { return events[Number(sequence)] },
      append(type, data) { const event = { type, data }; events.push(event); return event },
    },
  }
}
async function closed(value) {
  return await new Promise(resolveClosed => {
    const socket = net.createConnection({ host: '127.0.0.1', port: value })
    socket.once('connect', () => { socket.destroy(); resolveClosed(false) })
    socket.once('error', () => resolveClosed(true))
  })
}
async function freePort() {
  const listener = net.createServer()
  await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen))
  const value = listener.address().port
  await new Promise(resolveClose => listener.close(resolveClose))
  return value
}
async function waitForCdp(value) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${value}/json/version`)
      if (response.ok) return
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('external CDP browser did not start')
}

try {
  assert(!clientSource.includes('window.confirm('), 'extension client must not call the DSH alpha1 native confirm bridge')
  assert(clientSource.includes('requestExtensionMutation'), 'extension client panel confirmation entry is missing')
  assert(clientSource.includes('下次启动生效') && clientSource.includes('立即生效') && clientSource.includes('取消'), 'extension client confirmation choices are incomplete')
  assert(clientSource.includes("inputType !== '' && inputType !== 'insertText'"), 'client ordinary character fallback for missing inputType is absent')
  assert(clientSource.includes('extensionPopupLayer') && clientSource.includes('beginExtensionPopupDrag') && clientSource.includes('使用扩展') && clientSource.includes("action: 'open_popup'"), 'extension popup multi-level floating client entry is missing')
  assert(clientSource.lastIndexOf('snapshot.extensionPopup !== undefined') > clientSource.lastIndexOf("view === 'emulation'"), 'extension popup is still nested inside one panel view')
  assert(clientSource.includes('let mergedSnapshot = next') && clientSource.includes('frame: previous.extensionPopup.frame') && !clientSource.includes('main frame preservation returned before popup merge'), 'extension popup frame preservation can still be skipped by an earlier main-frame return')
  assert(!clientSource.includes("reportSidebarDebug('H3'") && !clientSource.includes("reportSidebarDebug('H4'") && !clientSource.includes('observed extension popup snapshot delta'), 'accepted extension popup instrumentation is still active')
  assert(clientSource.includes('if (extensionRpcActive.current)') && !clientSource.includes("view === 'extensions' && extensionRpcActive.current"), 'extension RPC snapshot exclusion is still limited to the extensions view')
  assert(panelCssSource.includes('resize: both') && panelCssSource.includes('pointer-events: none'), 'extension popup move and resize styles are missing')
  assert(clientSource.includes("commitImeText(' ')"), 'client whitespace keydown text fallback is missing')
  assert(clientSource.includes('inputTraceId: `client-${sessionId}-${clientRawAt}-${nextInputTrace.current++}`')
    && clientSource.includes('clientRawAt,')
    && clientSource.includes('clientNormalizedAt: Date.now()')
    && clientSource.includes('port.input(sessionId, { ...input, ...trace } as BrowserUserInput)')
    && clientSource.includes("composing ? 'composition_commit' : 'insert_text'")
    && runtimeSource.includes("Input.imeSetComposition"),
  'new client six-stage Composition input trace envelope is missing')
  assert(clientSource.includes("diagnostic: '诊断'") && clientSource.includes('打开诊断') && clientSource.includes('Action Timeline'), 'phase 2E diagnostic panel client entry is missing')
  assert(clientSource.includes('diagnosticReadSequence') && clientSource.includes('未读异常') && clientSource.includes('页面与证据同 View'), 'phase 2E diagnostic session status or unread acknowledgement is missing')
  assert(clientSource.includes('diagnosticOverlay') && clientSource.includes('diagnosticOccluder') && panelCssSource.includes('.diagnosticOverlay') && panelCssSource.includes('pointer-events: none'), 'phase 2E inspect or occluder overlay is missing')
  assert(
    runtimeSource.includes('input.maxNodes ?? 80')
      && runtimeSource.includes('), 300)')
      && runtimeSource.includes('snapshotLimit = Math.min(this.config.maxOutputChars, 6000)'),
    'compact snapshot limits are missing',
  )
  assert(runtimeSource.includes('input.limit ?? 10') && runtimeSource.includes(').slice(0, 400)'), 'compact query limits are missing')
  assert(
    runtimeSource.includes('private async releaseViewRefs(view: ViewState)')
      && runtimeSource.includes('await this.releaseHandles(handles.filter(handle => !retainedHandles.has(handle)))')
      && runtimeSource.match(/refs\.clear\(\)/g)?.length === 1,
    'Snapshot or query ElementHandle ownership is not centralized and bounded',
  )
  assert(indexSource.includes('text: JSON.stringify(value)') && !indexSource.includes('Browser ${value.action}:'), 'compact tool render is missing')
  assert(
    clientSource.includes('const loadingController = controllerState === undefined')
      && clientSource.includes('控制器状态读取中')
      && clientSource.includes('完整浏览器面板不会在此期间启动')
      && clientSource.includes('!loadingController && !active && !confirmActivate'),
    'controller loading state can still be misreported as other or expose activation actions early',
  )
  // DSH 的空白 Hero Session 会在首条消息后切换为正式 Session；RC.1 的右侧栏状态按 Session 保存，
  // 因此门禁必须同时锁定 Hero 禁用、Controller 快照身份绑定、Tab 生命周期回报，以及切换 Session 时不误关旧标签。
  assert(
    clientSource.includes("const currentSessionBlank = useSession((state: { readonly blank: boolean }) => state.blank)")
      && clientSource.includes('const panelAvailable = currentSessionBlank === false')
      && clientSource.includes('controllerBinding?.sessionId === sessionId')
      && clientSource.includes('setControllerBinding({ sessionId, snapshot })')
      && clientSource.includes('return controller.subscribe(sessionId, state =>')
      && clientSource.includes('controller.attach(')
      && clientSource.includes('controller.update(sessionId, tab.id, view)')
      && clientSource.includes('不能因为输入区组件切换身份就关闭旧 Session 的标签')
      && clientSource.includes('void port.close(sessionId, view).catch(() => {})')
      && clientSource.includes('disabled={switching || !panelAvailable}')
      && clientSource.includes('当前会话使用临时空白 Session')
      && clientSource.includes('当前会话尚未形成正式 Agent Session'),
    'blank-to-formal session identity can still reuse a stale controller snapshot or close the wrong RC.1 sidebar tab',
  )
  assert(
    controllerSource.includes('bindingGeneration')
      && controllerSource.includes('async waitUntilReady(sessionId: string)')
      && controllerSource.includes('state.agent !== agent || state.bindingGeneration !== bindingGeneration')
      && indexSource.includes('await controller?.waitUntilReady(sessionId)')
      && indexSource.includes('const replacement = ctx.agents.get(SessionId(sessionId))')
      && indexSource.includes('if (replacement !== undefined && replacement !== agent) return'),
    'same-session Agent replacement can still clear the new controller scope or dispose its browser runtime',
  )
  assert(runtimeSource.includes('receivedAt - state.lastAcceptedFrameAt < 33'), '30 FPS screencast acceptance budget is missing')
  assert(runtimeSource.includes('静态页面重排后不一定产生新的合成事件')
    && runtimeSource.includes('await this.restartScreencast(session, view)')
    && runtimeSource.includes('state.screencastConsumers.values().next().value')
    && runtimeSource.includes('await this.ensureScreencast(session, view, consumer)'),
  'adaptive reflow screencast restart or consumer preservation is missing')
  assert(runtimeSource.includes('popupUrl.origin !== base.origin'), 'extension popup origin boundary is missing')
  assert(runtimeSource.includes("providerBinding: { kind: 'shared-persistent' }") && runtimeSource.includes('pageOwners') && runtimeSource.includes('queueSharedContext'), 'shared persistent provider ownership model is missing')
  rmSync(runtime, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
  assert(existsSync(join(acceptanceChromiumRoot, 'chromium-1228', 'chrome-win64', 'chrome.exe')), 'offline acceptance Chromium cache is missing')
  // 启用本地Seed扩展需要插件Chromium；测试只联接已验证的验收缓存，禁止每轮回归访问Playwright CDN。
  link(acceptanceChromiumRoot, join(artifactRoot, 'chromium'))
  const seededExtensionA = seedSharedExtension()
  const seededExtensionB = seededExtensionA
  const seededExtensionFullAccess = seededExtensionA
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(modules, packageName), { recursive: true })
  mkdirSync(join(modules, 'browser-test-connection'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-permission-presets'), { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) copyFileSync(join(packageSourceRoot, file), join(modules, packageName, file))
  mkdirSync(join(modules, packageName, 'lib'), { recursive: true })
  copyFileSync(join(packageSourceRoot, 'lib', 'index.mjs'), join(modules, packageName, 'lib', 'index.mjs'))
  copyFileSync(join(packageSourceRoot, 'lib', 'index.d.mts'), join(modules, packageName, 'lib', 'index.d.mts'))
  // 完整集成使用当前项目锁定的 RC.1 npm 包，按消费者入口解析后链接到隔离 Profile；禁止依赖工作区外 DSH 源码树。
  for (const name of installedPackages) {
    if (name === packageName) continue
    link(installedPackageRoot(name), join(modules, ...name.split('/')))
  }
  writeFileSync(join(modules, 'browser-test-permission-presets', 'package.json'), JSON.stringify({
    name: 'browser-test-permission-presets',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2))
  writeFileSync(join(modules, 'browser-test-permission-presets', 'index.mjs'), [
    "export function apply(ctx) {",
    "  ctx.provide('permissionPresets', { current: session => String(session.id).includes('full-access') ? 'danger-full-access' : undefined })",
    "}",
  ].join('\n'))
  writeFileSync(join(modules, 'browser-test-connection', 'package.json'), JSON.stringify({ name: 'browser-test-connection', version: '0.0.0', type: 'module', main: './index.mjs' }, null, 2))
  writeFileSync(join(modules, 'browser-test-connection', 'index.mjs'), [
    "export function apply(ctx) {",
    "  ctx.provide('connection', {",
    "    fetch: {",
    "      register(route) {",
    "        globalThis.__browserToolsRpc = {",
    "          path: route.path,",
    "          methods: route.methods,",
    "          requestBody: route.requestBody,",
    "          removed: false,",
    "          handler: async (endpoint, payload, signal) => {",
    "            const rpcId = `browser-tools-${endpoint}`",
    "            const response = await route.fetch(new Request('http://dsh.internal/api/browser-tools', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'browser-tools', payload: { endpoint, payload } }), signal }))",
    "            return (await response.json()).result",
    "          },",
    "        }",
    "        return async () => { globalThis.__browserToolsRpc.removed = true }",
    "      },",
    "    },",
    "  })",
    "}",
  ].join('\n'))

  const fixture = readFileSync(join(root, 'tests', 'fixture.html'))
  const diagnosticSourceMap = Buffer.from(JSON.stringify({ version: 3, file: 'diagnostic-app.js', names: [], sources: ['../src/diagnostic-fixture.ts'], sourcesContent: ['export function triggerDiagnosticFailure(): void { throw new Error("diagnostic-page-error") }'], mappings: 'AAAA' })).toString('base64')
  const diagnosticScript = `document.querySelector('#diagnostic-error').addEventListener('click',()=>{console.error('diagnostic-console-error token=visible-secret');void fetch('/diagnostic-fail?token=visible-secret');void Promise.all([fetch('/diagnostic-race?slot=1'),fetch('/diagnostic-race?slot=2')]);void Promise.reject(new Error('diagnostic-unhandled-rejection secret=visible-secret'));setTimeout(()=>{throw new Error('diagnostic-page-error password=visible-secret')},0)});\n//# sourceMappingURL=data:application/json;base64,${diagnosticSourceMap}`
  const l3FrameDocument = kind => Buffer.from(`<!doctype html><meta charset="utf-8"><title>L3 ${kind} Frame</title><body><button id="frame-action">Frame action</button><script src="/l3-frame-script.js?kind=${kind}"></script></body>`)
  const l3FrameScript = kind => `globalThis.__l3FrameKind=${JSON.stringify(kind)};console.error('l3-${kind}-frame-console');fetch('/l3-frame-fail?kind=${kind}');`
  const adaptiveOverflowFixture = Buffer.from('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0}main{position:relative;min-width:768px;height:100vh}.search-row{position:relative;width:580px;height:45px;margin-left:auto}.search-row input{width:100%;height:45px;box-sizing:border-box}#adaptive-target{position:absolute;right:0;top:0;width:50px;height:45px}#mode::after{content:"wide"}@media(max-width:700px){#mode::after{content:"narrow"}}</style><main><span id="mode"></span><div class="search-row"><input id="adaptive-input"><button id="adaptive-target">target</button></div></main><script>window.adaptiveClicked=0;document.querySelector("#adaptive-target").addEventListener("click",()=>window.adaptiveClicked+=1)</script>')
  server = http.createServer((request, response) => {
    if (request.url === '/sw.js') { response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end("self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()))"); return }
    if (request.url === '/api') { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ ok: true, source: 'browser-tools-v2' })); return }
    if (request.url === '/diagnostic-app.js') { response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(diagnosticScript); return }
    if (request.url?.startsWith('/l3-frame-script.js')) { const kind = new URL(request.url, 'http://fixture').searchParams.get('kind') || 'unknown'; response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(l3FrameScript(kind)); return }
    if (request.url?.startsWith('/l3-frame-fail')) { response.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: 'l3-frame-conflict' })); return }
    if (request.url?.startsWith('/l3-frame')) { const kind = new URL(request.url, 'http://fixture').searchParams.get('kind') || 'unknown'; response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(l3FrameDocument(kind)); return }
    if (request.url === '/slow') { setTimeout(() => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fixture) }, 5000); return }
    if (request.url === '/disconnect') { response.destroy(); return }
    if (request.url?.startsWith('/diagnostic-fail')) { response.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: 'diagnostic-conflict' })); return }
    if (request.url?.startsWith('/diagnostic-race')) { const status = request.url.includes('slot=1') ? 200 : 409; setTimeout(() => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ status })) }, status === 200 ? 80 : 20); return }
    if (request.url === '/adaptive-overflow') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(adaptiveOverflowFixture); return }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(fixture)
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'browser-scope-test-profile', private: true, dsh: { profile: { bundles: [packageName] } } }, null, 2))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  const isolatedPackageEntry = join(modules, packageName, 'lib', 'index.mjs')
  const connectionEntry = join(modules, 'browser-test-connection', 'index.mjs')
  const permissionPresetsEntry = join(modules, 'browser-test-permission-presets', 'index.mjs')
  const patch = [
    '- insert:',
    '    - id: system-prompt',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-system-prompt'))}`,
    '      config:',
    '        includeHarnessIdentity: false',
    '        includeRuntimeContext: false',
    "        persona: ''",
    '    - id: attachments',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-attachment-local'))}`,
    '      config:',
    `        dshHome: ${JSON.stringify(home)}`,
    '    - id: tools',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-tools'))}`,
    '    - id: sessions',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-session'))}`,
    '    - id: agent',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-agent'))}`,
    '    - id: approval',
    `      name: ${JSON.stringify(installedPackageEntry('@deepseek-ai/dsh-user-approval'))}`,
    '    - id: connection',
    `      name: ${JSON.stringify(connectionEntry)}`,
    '    - id: permission-presets',
    `      name: ${JSON.stringify(permissionPresetsEntry)}`,
    '    - id: browser-tools',
    `      name: ${JSON.stringify(isolatedPackageEntry)}`,
    '      config:',
    '        allowLoopback: true',
    `        allowedOrigins: [${JSON.stringify(origin)}]`,
    `        artifactRoot: ${JSON.stringify(artifactRoot)}`,
    '        interceptionTimeoutMs: 1000',
  ].join('\n') + '\n'
  writeFileSync(join(modules, packageName, 'cordis.patch.yml'), patch)

  const appBoot = await import('@deepseek-ai/dsh-app-boot')
  const llm = await import('@deepseek-ai/dsh-llm')
  const sessionApi = await import('@deepseek-ai/dsh-session')
  const loaded = appBoot.loadProfile('dsh-browser-scope-test', 'test', appBootAnchor, home)
  ctx = await appBoot.boot('dsh-browser-scope-test', join(profile, 'cordis.patch.yml'), loaded.layers.flatMap(layer => layer.patches))
  const tools = ctx.get('tools')
  const browserSchemas = tools.schemas().filter(tool => tool.name.startsWith('browser_'))
  const names = browserSchemas.map(tool => tool.name).sort()
  assert(names.length === 30, `expected 30 browser tools, got ${names.length}`)
  const schemaByName = new Map(browserSchemas.map(schema => [schema.name, schema]))
  for (const name of ['browser_click', 'browser_type', 'browser_press_key']) assert(schemaByName.get(name)?.parameters?.properties?.element === undefined, `${name} still exposes the unused element parameter`)
  assert(schemaByName.get('browser_query')?.parameters?.properties?.field?.enum?.includes('refs')
    && schemaByName.get('browser_query')?.parameters?.properties?.frameId?.type === 'string',
  'browser_query schema does not expose refs recovery mode and same-origin Frame selection')
  const diagnoseSchema = schemaByName.get('browser_diagnose')?.parameters?.properties
  assert(diagnoseSchema?.action?.enum?.includes('report')
    && diagnoseSchema.action.enum.includes('status')
    && diagnoseSchema.sinceActionId !== undefined
    && diagnoseSchema.untilActionId !== undefined
    && diagnoseSchema.sinceCheckpointId !== undefined
    && diagnoseSchema.sinceCursor !== undefined,
  'browser_diagnose schema is missing stage 2A actions or incremental range parameters')
  const diagnoseDescription = String(schemaByName.get('browser_diagnose')?.description)
  // 完成指导必须保留通用的身份×顺序×上下文反例矩阵，防止模型只用同身份样例证明单调性。
  for (const phrase of ['same-identity tests alone', 'identity unchanged/changed', 'evidence claims must not exceed']) {
    assert(diagnoseDescription.includes(phrase), `browser_diagnose description is missing acceptance guidance: ${phrase}`)
  }
  for (const name of ['browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_wait_for', 'browser_handle_dialog', 'browser_takeover']) {
    const description = String(schemaByName.get(name)?.description)
    assert(description.includes('CAPTCHA') && description.includes('Passkey'), `${name} is missing security verification takeover guidance`)
  }
  const rpcRegistration = globalThis.__browserToolsRpc
  assert(rpcRegistration?.path === '/api/browser-tools', 'browser panel authenticated Fetch RPC route was not registered')
  assert(rpcRegistration?.methods?.length === 1 && rpcRegistration.methods[0] === 'POST', 'browser panel RPC route must accept POST only')
  assert(rpcRegistration?.requestBody === 'buffered', 'browser panel RPC route must use the authenticated buffered JSON carrier')
  const primaryViews = new Map()
  const rpc = async (endpoint, payload) => {
    const primaryViewId = primaryViews.get(payload.sessionId)
    const normalizedPayload = payload.viewId === 'v1' && primaryViewId !== undefined
      ? { ...payload, viewId: primaryViewId }
      : payload
    const response = await rpcRegistration.handler(endpoint, normalizedPayload, new AbortController().signal)
    if (response.ok !== true) throw new Error(`browser panel RPC failed: ${JSON.stringify(response)}`)
    if (endpoint === 'extensions' && (payload.action === 'apply' || payload.applyMode === 'now')) primaryViews.clear()
    if (endpoint === 'provider' && (payload.action === 'connect' || payload.action === 'disconnect')) primaryViews.delete(payload.sessionId)
    const returnedViewId = response.value?.activeViewId ?? response.value?.viewId
    if (typeof returnedViewId === 'string' && primaryViews.get(payload.sessionId) === undefined) primaryViews.set(payload.sessionId, returnedViewId)
    return response.value
  }
  const rpcWithin = async (stage, timeoutMs, endpoint, payload) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException(`${stage} timed out`, 'AbortError')), timeoutMs)
    try {
      return await Promise.race([
        rpcRegistration.handler(endpoint, payload, controller.signal).then(response => {
          if (response.ok !== true) throw new Error(`${stage} failed: ${JSON.stringify(response)}`)
          return response.value
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs + 100)),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const a = fakeAgent('a')
  const b = fakeAgent('b', 'subagent')
  const c = fakeAgent('c')
  const persistentCacheAgent = fakeAgent('persistent-cache')
  const fullAccessAgent = fakeAgent('full-access')
  const noChannel = await tools.execute({ agent: a, callId: llm.ToolCallId('no-channel'), name: 'browser_navigate', arguments: { url: origin }, signal: new AbortController().signal })
  assert(noChannel.isError === true, `missing approval answerer did not fail closed: ${JSON.stringify(noChannel)}`)
  a.session.append('approval/policy', { policy: 'never' })
  let neverCalled = false
  const neverAnswerer = ctx.on('approval/request', () => { neverCalled = true; return Promise.resolve('allowed-once') })
  const never = await tools.execute({ agent: a, callId: llm.ToolCallId('never'), name: 'browser_navigate', arguments: { url: origin }, signal: new AbortController().signal })
  const neverTabNavigation = await tools.execute({ agent: a, callId: llm.ToolCallId('never-tab-navigation'), name: 'browser_tabs', arguments: { action: 'new', url: origin }, signal: new AbortController().signal })
  const neverEvaluate = await tools.execute({ agent: a, callId: llm.ToolCallId('never-evaluate'), name: 'browser_evaluate', arguments: { action: 'isolated', expression: '1 + 1' }, signal: new AbortController().signal })
  const neverBlankBefore = await tools.execute({ agent: a, callId: llm.ToolCallId('never-blank-before'), name: 'browser_tabs', arguments: { action: 'list' }, signal: new AbortController().signal })
  const neverBlankTab = await tools.execute({ agent: a, callId: llm.ToolCallId('never-blank-tab'), name: 'browser_tabs', arguments: { action: 'new', url: 'about:blank' }, signal: new AbortController().signal })
  const neverBlankClose = await tools.execute({ agent: a, callId: llm.ToolCallId('never-blank-close'), name: 'browser_tabs', arguments: { action: 'close', viewId: neverBlankTab.value?.viewId }, signal: new AbortController().signal })
  fullAccessAgent.session.append('approval/policy', { policy: 'never' })
  const fullAccessNavigation = await tools.execute({ agent: fullAccessAgent, callId: llm.ToolCallId('full-access-navigation'), name: 'browser_navigate', arguments: { url: origin }, signal: new AbortController().signal })
  const fullAccessExtensionEnable = await tools.execute({ agent: fullAccessAgent, callId: llm.ToolCallId('full-access-extension-enable'), name: 'browser_extensions', arguments: { action: 'enable', extensionId: seededExtensionFullAccess, applyMode: 'next_start' }, signal: new AbortController().signal })
  neverAnswerer()
  assert(never.isError === true && neverCalled === false, 'never policy did not reject before answerers')
  assert(neverTabNavigation.isError === true && neverCalled === false, 'browser_tabs URL navigation bypassed never approval policy')
  assert(neverEvaluate.isError === true && neverCalled === false, 'isolated browser_evaluate bypassed never approval policy')
  assert(neverBlankBefore.isError === false && neverBlankTab.isError === false && neverBlankTab.value.data.tabs.length === neverBlankBefore.value.data.tabs.length + 1 && neverBlankTab.value.data.tabs.some(tab => tab.viewId === neverBlankTab.value.viewId && tab.url === 'about:blank'), `browser_tabs blank new incorrectly required approval or failed to add one blank tab: ${JSON.stringify({ before: neverBlankBefore, created: neverBlankTab })}`)
  assert(neverBlankClose.isError === false && neverBlankClose.value.data.tabs.length === neverBlankBefore.value.data.tabs.length, `browser_tabs blank approval regression cleanup failed: ${JSON.stringify(neverBlankClose)}`)
  assert(fullAccessNavigation.isError === false && neverCalled === false, 'danger-full-access did not bypass interactive browser approval')
  assert(fullAccessExtensionEnable.isError === false && fullAccessExtensionEnable.value.data.extensions[0].pendingRestart === true && neverCalled === false, 'danger-full-access did not bypass browser extension approval')
  a.session.append('approval/policy', { policy: 'ask' })
  c.session.append('approval/policy', { policy: 'ask' })
  persistentCacheAgent.session.append('approval/policy', { policy: 'ask' })
  const allow = ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  const call = async (agent, callId, name, args, signal = new AbortController().signal) => {
    const primaryViewId = primaryViews.get(agent.id)
    const normalizedArgs = args.viewId === 'v1' && primaryViewId !== undefined
      ? { ...args, viewId: primaryViewId }
      : args
    const response = await tools.execute({ agent, callId: llm.ToolCallId(callId), name, arguments: normalizedArgs, signal })
    if (response.isError === false && name === 'browser_extensions' && (args.action === 'apply' || args.applyMode === 'now')) primaryViews.clear()
    if (response.isError === false && name === 'browser_provider' && (args.action === 'connect' || args.action === 'disconnect')) primaryViews.delete(agent.id)
    if (response.isError === false && typeof response.value?.viewId === 'string' && primaryViews.get(agent.id) === undefined) primaryViews.set(agent.id, response.value.viewId)
    return response
  }
  const persistentCacheNav = await call(persistentCacheAgent, 'persistent-cache-nav', 'browser_navigate', { url: origin })
  assert(persistentCacheNav.isError === false, `default persistent cache session navigation failed: ${JSON.stringify(persistentCacheNav)}`)
  const persistentCacheSeed = await call(persistentCacheAgent, 'persistent-cache-seed', 'browser_evaluate', {
    action: 'main_world',
    expression: `(async () => {
      document.cookie = 'dshPersistentCookie=preserved; path=/; Max-Age=3600; SameSite=Lax'
      localStorage.setItem('dshPersistentLocal', 'preserved')
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('dsh-persistent-db', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('values')
        request.onsuccess = () => {
          const transaction = request.result.transaction('values', 'readwrite')
          transaction.objectStore('values').put('preserved', 'key')
          transaction.oncomplete = () => { request.result.close(); resolve(undefined) }
          transaction.onerror = () => reject(transaction.error)
        }
        request.onerror = () => reject(request.error)
      })
      const cache = await caches.open('dsh-persistent-cache')
      await cache.put('/cached-value', new Response('preserved'))
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      return { cookie: document.cookie, local: localStorage.getItem('dshPersistentLocal'), serviceWorkerScope: registration.scope }
    })()`,
    awaitPromise: true,
  })
  assert(
    persistentCacheSeed.isError === false && persistentCacheSeed.value.data.value.local === 'preserved',
    `persistent cache seed failed: ${JSON.stringify(persistentCacheSeed)}`,
  )
  const sharedStorageNav = await call(c, 'shared-storage-nav-c', 'browser_navigate', { url: origin })
  const sharedStorageReadBeforeRestart = await call(c, 'shared-storage-read-c', 'browser_evaluate', {
    action: 'main_world',
    expression: `({ sessionMarker: document.cookie.includes('dshPersistentCookie=preserved'), local: localStorage.getItem('dshPersistentLocal') })`,
  })
  assert(sharedStorageNav.isError === false
    && sharedStorageReadBeforeRestart.isError === false
    && sharedStorageReadBeforeRestart.value.data.value.sessionMarker === true
    && sharedStorageReadBeforeRestart.value.data.value.local === 'preserved',
  `default sessions did not share cookie and localStorage before restart: ${JSON.stringify(sharedStorageReadBeforeRestart)}`)
  const persistentCacheRestart = await call(persistentCacheAgent, 'persistent-cache-restart', 'browser_extensions', { action: 'apply', applyMode: 'now' })
  assert(persistentCacheRestart.isError === false, 'persistent browser context restart failed')
  const persistentCacheRead = await call(persistentCacheAgent, 'persistent-cache-read', 'browser_evaluate', {
    action: 'main_world',
    expression: `(async () => {
      const indexed = await new Promise((resolve, reject) => {
        const request = indexedDB.open('dsh-persistent-db', 1)
        request.onsuccess = () => {
          const transaction = request.result.transaction('values', 'readonly')
          const value = transaction.objectStore('values').get('key')
          value.onsuccess = () => { request.result.close(); resolve(value.result) }
          value.onerror = () => reject(value.error)
        }
        request.onerror = () => reject(request.error)
      })
      const cached = await (await caches.open('dsh-persistent-cache')).match('/cached-value')
      const registrations = await navigator.serviceWorker.getRegistrations()
      return { sessionMarker: document.cookie.includes('dshPersistentCookie=preserved'), local: localStorage.getItem('dshPersistentLocal'), indexed, cached: await cached?.text(), serviceWorkers: registrations.length }
    })()`,
    awaitPromise: true,
  })
  assert(persistentCacheRead.isError === false
    && persistentCacheRead.value.data.value.sessionMarker === true
    && persistentCacheRead.value.data.value.local === 'preserved'
    && persistentCacheRead.value.data.value.indexed === 'preserved'
    && persistentCacheRead.value.data.value.cached === 'preserved'
    && persistentCacheRead.value.data.value.serviceWorkers > 0,
  `persistent browser data did not survive context restart: ${JSON.stringify(persistentCacheRead)}`)
  const sharedStorageReadAfterRestart = await call(c, 'shared-storage-read-after-restart-c', 'browser_evaluate', {
    action: 'main_world',
    expression: `({ sessionMarker: document.cookie.includes('dshPersistentCookie=preserved'), local: localStorage.getItem('dshPersistentLocal') })`,
  })
  const sharedTabsAfterRestart = await call(c, 'shared-tabs-after-restart-c', 'browser_tabs', { action: 'list' })
  assert(sharedStorageReadAfterRestart.isError === false
    && sharedStorageReadAfterRestart.value.data.value.sessionMarker === true
    && sharedStorageReadAfterRestart.value.data.value.local === 'preserved'
    && sharedTabsAfterRestart.isError === false
    && sharedTabsAfterRestart.value.data.tabs.length === 1
    && sharedTabsAfterRestart.value.data.tabs[0].url === `${origin}/`,
  'global extension restart did not restore another shared session and its shared website state')
  const draftFirstNew = await rpc('tabs', { sessionId: 'draft-first', action: 'new' })
  await rpc('close', { sessionId: 'draft-first', view: 'live' })
  const draftFirstBeforeAdopt = await rpc('snapshot', { sessionId: 'draft-first', view: 'console' })
  const draftFirstSession = ctx.sessions.create(sessionApi.SessionId('draft-first'))
  const draftFirstAgent = { ...fakeAgent('draft-first'), session: draftFirstSession }
  const draftFirstModelTabs = await call(draftFirstAgent, 'draft-first-model-tabs', 'browser_tabs', { action: 'list' })
  const draftFirstAfterAdopt = await rpc('snapshot', { sessionId: 'draft-first', view: 'console' })
  assert(draftFirstNew.ok === true && draftFirstBeforeAdopt.tabs.length === 1 && draftFirstBeforeAdopt.activeViewId === draftFirstNew.viewId && draftFirstBeforeAdopt.tabs[0].url === 'about:blank', 'closing the browser panel destroyed or changed the pending draft browser session')
  assert(draftFirstModelTabs.isError === false && draftFirstModelTabs.value.viewId === draftFirstNew.viewId && draftFirstModelTabs.value.data.tabs.length === 1, 'model browser tools did not adopt the draft browser session')
  assert(draftFirstAfterAdopt.activeViewId === draftFirstNew.viewId && draftFirstAfterAdopt.tabs.length === 1, 'draft browser session adoption changed or lost the active tab')
  const panelFirstSession = ctx.sessions.create(sessionApi.SessionId('panel-first'))
  const panelFirstAgent = { ...fakeAgent('panel-first'), session: panelFirstSession }
  const panelFirstNew = await rpc('tabs', { sessionId: 'panel-first', action: 'new' })
  const panelFirstSnapshot = await rpc('snapshot', { sessionId: 'panel-first', view: 'console' })
  const panelFirstModelTabs = await call(panelFirstAgent, 'panel-first-model-tabs', 'browser_tabs', { action: 'list' })
  assert(panelFirstNew.ok === true && panelFirstSnapshot.tabs.length === 1 && panelFirstSnapshot.tabs[0].url === 'about:blank', 'browser panel could not create the first tab before any model browser tool call')
  assert(panelFirstModelTabs.isError === false && panelFirstModelTabs.value.viewId === panelFirstNew.viewId && panelFirstModelTabs.value.data.tabs.length === 1, 'model browser tools did not reuse the panel-created browser session')
  const splitOpened = await rpc('split_view', { sessionId: 'panel-first', action: 'open' })
  const splitRatio = await rpc('split_view', { sessionId: 'panel-first', action: 'ratio', ratio: 0.9 })
  let splitLive
  for (let attempt = 0; attempt < 40; attempt += 1) {
    splitLive = await rpc('snapshot', { sessionId: 'panel-first', view: 'live' })
    if (splitLive.splitView?.panes?.length === 2 && splitLive.splitView.panes.every(item => item.frame?.data.length > 0)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(splitOpened.ok === true && splitOpened.data.enabled === true && splitOpened.data.topViewId !== splitOpened.data.bottomViewId, 'single-tab split did not create two distinct panes')
  assert(splitRatio.ok === true && splitRatio.data.ratio === 0.6, 'split ratio did not clamp to the 60 percent upper bound')
  const splitBottomResize = await rpc('split_view', { sessionId: 'panel-first', action: 'resize', pane: 'bottom', width: 613, height: 200 })
  let splitAfterCompactResize
  for (let attempt = 0; attempt < 40; attempt += 1) {
    splitAfterCompactResize = await rpc('snapshot', { sessionId: 'panel-first', view: 'live' })
    const bottom = splitAfterCompactResize.splitView?.panes?.find(item => item.pane === 'bottom')
    if (bottom?.liveView.height === 200 && splitAfterCompactResize.splitView.panes.every(item => item.frame?.data.length > 0)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const splitPreference = JSON.parse(readFileSync(join(artifactRoot, 'layout', 'sessions', profileSegment('panel-first'), 'split-view.json'), 'utf8'))
  assert(splitPreference.version === 1 && splitPreference.ratio === 0.6, 'split ratio was not persisted for the DSH Session')
  assert(splitBottomResize.ok === true, 'split pane resize rejected an operable height below the single-page minimum')
  assert(splitAfterCompactResize?.splitView?.panes?.find(item => item.pane === 'bottom')?.liveView.height === 200, 'compact split pane did not use its real viewport height')
  splitLive = splitAfterCompactResize
  assert(splitLive?.splitView?.panes?.length === 2 && splitLive.splitView.panes.every(item => item.frame?.data.length > 0), 'top and bottom split panes did not produce independent live frames')
  const splitBeforeRestart = splitLive.splitView
  const splitRestart = await rpc('extensions', { sessionId: 'panel-first', action: 'apply', applyMode: 'now' })
  let splitAfterRestart
  for (let attempt = 0; attempt < 40; attempt += 1) {
    splitAfterRestart = await rpc('snapshot', { sessionId: 'panel-first', view: 'live' })
    if (splitAfterRestart.splitView?.panes?.length === 2 && splitAfterRestart.splitView.panes.every(item => item.frame?.data.length > 0)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(splitRestart.ok === true && splitAfterRestart?.splitView?.enabled === true && splitAfterRestart.splitView.ratio === 0.6, 'persistent context restart did not restore split state and ratio')
  assert(splitAfterRestart.splitView.topViewId !== splitBeforeRestart.topViewId && splitAfterRestart.splitView.bottomViewId !== splitBeforeRestart.bottomViewId, 'persistent context restart reused stale split view identities')
  assert(splitAfterRestart.splitView.panes.every(item => item.frame?.data.length > 0), 'split panes did not resume live frames after persistent context restart')
  splitLive = splitAfterRestart
  const splitBeforeSwap = splitLive.splitView
  const splitSwapped = await rpc('split_view', { sessionId: 'panel-first', action: 'swap' })
  assert(splitSwapped.ok === true && splitSwapped.data.topViewId === splitBeforeSwap.bottomViewId && splitSwapped.data.bottomViewId === splitBeforeSwap.topViewId, 'split swap did not exchange pane tabs')
  const splitVisibleClose = await rpc('tabs', { sessionId: 'panel-first', action: 'close', viewId: splitSwapped.data.topViewId })
  const splitAfterClose = await rpc('snapshot', { sessionId: 'panel-first', view: 'console' })
  assert(splitVisibleClose.ok === true && splitAfterClose.splitView.enabled === false && splitAfterClose.tabs.length === 1, 'closing a visible split tab did not return to one surviving tab')
  const navA = await call(a, 'nav-a', 'browser_navigate', { url: origin })
  assert(navA.isError === false, 'session A navigation failed')
  const snapA = await call(a, 'snap-a', 'browser_snapshot', {})
  if (snapA.isError === true || !snapA.value.data.snapshot.includes('BROWSER TOOLS FIXTURE')) throw new Error(`session A snapshot failed: ${JSON.stringify(snapA)}`)
  const replace = /^(e\d+).*Replace target/m.exec(snapA.value.data.snapshot)?.[1]
  const target = /^(e\d+).*Target 1/m.exec(snapA.value.data.snapshot)?.[1]
  assert(replace !== undefined, 'replace ref missing')
  assert(target !== undefined, 'target ref missing')
  const click = await call(a, 'click-a', 'browser_click', { element: 'Target 1', ref: target })
  assert(click.isError === false && typeof click.value.data.changed === 'boolean' && typeof click.value.data.changeSignals === 'object', 'click did not return bounded post-action signals')
  const query = await call(a, 'query-a', 'browser_query', { selector: '#result', field: 'text' })
  assert(query.value.data.values[0] === 'clicked-1', 'query did not observe click')
  await call(a, 'replace-a', 'browser_click', { element: 'Replace target', ref: replace })
  const stale = await call(a, 'stale-a', 'browser_click', { element: 'Old target', ref: target })
  assert(stale.isError === false && stale.value.ok === false && stale.value.data.code === 'STALE_REF', 'stale ref did not return a recoverable result')
  const customSnapshot = await call(a, 'custom-snapshot-a', 'browser_snapshot', {})
  const customSnapshotRef = /^(e\d+).*Custom login/m.exec(customSnapshot.value.data.snapshot)?.[1]
  assert(typeof customSnapshotRef === 'string', 'snapshot did not expose a conservative custom div button ref')
  const customQuery = await call(a, 'custom-query-refs-a', 'browser_query', { selector: '#custom-login', field: 'refs', limit: 5 })
  const customQueryRef = customQuery.value.data.refs?.[0]?.ref
  assert(customQuery.isError === false && typeof customQueryRef === 'string', 'browser_query refs did not return a short-lived custom control ref')
  const invalidatedCustomSnapshotRef = await call(a, 'custom-old-ref-a', 'browser_click', { ref: customSnapshotRef })
  assert(invalidatedCustomSnapshotRef.isError === false && invalidatedCustomSnapshotRef.value.ok === false && invalidatedCustomSnapshotRef.value.data.code === 'STALE_REF', 'query refs did not invalidate the previous snapshot generation')
  const customClick = await call(a, 'custom-click-a', 'browser_click', { ref: customQueryRef })
  const customClicked = await call(a, 'custom-clicked-a', 'browser_query', { selector: '#result', field: 'text' })
  assert(customClick.isError === false && customClicked.value.data.values[0] === 'custom-login-clicked', 'custom div ref click did not reach the page')
  const compactSnapshot = await call(a, 'compact-snapshot-a', 'browser_snapshot', { includeDiff: true, maxNodes: 1000 })
  assert(compactSnapshot.isError === false && compactSnapshot.value.data.snapshot.length <= 6000 && (compactSnapshot.value.data.diff === null || compactSnapshot.value.data.diff.length <= 2000) && compactSnapshot.value.data.diff !== compactSnapshot.value.data.snapshot, 'browser_snapshot did not enforce compact snapshot and real diff bounds')
  const unchangedSnapshot = await call(a, 'unchanged-snapshot-a', 'browser_snapshot', {})
  const forcedFullSnapshot = await call(a, 'forced-full-snapshot-a', 'browser_snapshot', { includeDiff: false })
  assert(unchangedSnapshot.isError === false
    && unchangedSnapshot.value.data.snapshotMode === 'incremental'
    && unchangedSnapshot.value.data.unchanged === true
    && unchangedSnapshot.value.data.snapshot.length < forcedFullSnapshot.value.data.snapshot.length
    && forcedFullSnapshot.value.data.snapshotMode === 'full'
    && forcedFullSnapshot.value.data.snapshot.includes('BROWSER TOOLS FIXTURE'),
  'browser_snapshot automatic incremental mode or full recovery mode failed')
  const compactQuerySetup = await call(a, 'query-long-text-setup-a', 'browser_evaluate', { action: 'main_world', viewId: compactSnapshot.value.viewId, expression: `document.querySelector('#result').textContent = 'x'.repeat(1000)` })
  const compactQuery = await call(a, 'query-long-text-a', 'browser_query', { selector: '#result', field: 'text', limit: 100 })
  assert(compactQuerySetup.isError === false && compactQuery.isError === false && compactQuery.value.data.values[0].length === 400, 'browser_query did not enforce compact text bounds')
  const diagnosticSnapshot = await call(a, 'diagnostic-snapshot-a', 'browser_snapshot', { includeDiff: false })
  const diagnosticRef = /^(e\d+).*Trigger diagnostic error/m.exec(diagnosticSnapshot.value.data.snapshot)?.[1]
  const occludedRef = /^(e\d+).*Occluded target/m.exec(diagnosticSnapshot.value.data.snapshot)?.[1]
  const canvasRef = /^(e\d+).*Diagnostic canvas/m.exec(diagnosticSnapshot.value.data.snapshot)?.[1]
  const portalRef = /^(e\d+).*Diagnostic portal/m.exec(diagnosticSnapshot.value.data.snapshot)?.[1]
  assert(typeof diagnosticRef === 'string' && typeof occludedRef === 'string' && typeof canvasRef === 'string' && typeof portalRef === 'string', 'diagnostic inspect fixture refs are missing')
  const privacyCanaries = [
    'L3-NORMAL-Canary-7f3a',
    'L3-PASSWORD-Canary-9d2b',
    '73194628',
    'L3-CHALLENGE-Canary-5c8e',
  ]
  const privacyGeometry = await call(a, 'privacy-geometry-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `['text', 'privacy-password', 'privacy-otp', 'privacy-challenge'].map(id => { const rect = document.getElementById(id).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })`,
  })
  let privacyLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    privacyLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (privacyLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const privacyRects = privacyGeometry.value?.data?.value
  assert(privacyGeometry.isError === false
    && privacyLive?.frame !== undefined
    && Array.isArray(privacyRects)
    && privacyRects.length === 4
    && privacyRects.every(rect => {
      return rect !== undefined && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    }),
  `privacy fixture geometry or live frame is unavailable: ${JSON.stringify({ privacyGeometry, hasFrame: privacyLive?.frame !== undefined })}`)
  const privacyIdentity = { viewId: privacyLive.activeViewId, streamGeneration: privacyLive.frame.streamGeneration, frameSequence: privacyLive.frame.sequence, viewportGeneration: privacyLive.frame.viewportGeneration }
  const privacyTakeover = await rpc('takeover', { sessionId: 'a', action: 'request', viewId: privacyIdentity.viewId })
  const privacyTargets = [
    ['text', privacyCanaries[0]],
    ['privacy-password', privacyCanaries[1]],
    ['privacy-otp', privacyCanaries[2]],
    ['privacy-challenge', privacyCanaries[3]],
  ]
  const privacyInputs = []
  for (const [index, [, value]] of privacyTargets.entries()) {
    const rect = privacyRects[index]
    privacyInputs.push(await rpc('input', { sessionId: 'a', action: 'mouse_click', ...privacyIdentity, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }))
    privacyInputs.push(await rpc('input', { sessionId: 'a', action: 'insert_text', ...privacyIdentity, text: value }))
  }
  const privacyReturned = await rpc('takeover', { sessionId: 'a', action: 'return', viewId: privacyIdentity.viewId })
  await rpc('close', { sessionId: 'a', view: 'live' })
  assert(privacyTakeover.ok === true && privacyInputs.every(item => item.ok === true) && privacyReturned.ok === true, 'privacy canary input through the real panel pipeline failed')
  const diagnosticStart = await call(a, 'diagnostic-start-a', 'browser_diagnose', { action: 'start', viewId: diagnosticSnapshot.value.viewId })
  const diagnosticStatus = await call(a, 'diagnostic-status-a', 'browser_diagnose', { action: 'status' })
  const diagnosticInspect = await call(a, 'diagnostic-inspect-a', 'browser_diagnose', { action: 'inspect', ref: diagnosticRef })
  const occludedInspect = await call(a, 'diagnostic-inspect-occluded-a', 'browser_diagnose', { action: 'inspect', ref: occludedRef })
  const canvasInspect = await call(a, 'diagnostic-inspect-canvas-a', 'browser_diagnose', { action: 'inspect', ref: canvasRef })
  const portalInspect = await call(a, 'diagnostic-inspect-portal-a', 'browser_diagnose', { action: 'inspect', ref: portalRef })
  const diagnosticBaseline = await call(a, 'diagnostic-baseline-a', 'browser_diagnose', { action: 'checkpoint', ref: diagnosticRef, label: 'baseline', screenshot: true })
  const diagnosticScreenshotRef = diagnosticBaseline.value?.data?.checkpoint?.screenshot
  const storedDiagnosticScreenshot = diagnosticScreenshotRef === undefined ? undefined : await ctx.attachments.readImage(diagnosticScreenshotRef)
  const privacyBrowser = await chromium.launch({ executablePath: join(acceptanceChromiumRoot, 'chromium-1228', 'chrome-win64', 'chrome.exe'), headless: true })
  let privacyPixels
  try {
    const page = await privacyBrowser.newPage()
    const screenshotBase64 = Buffer.from(storedDiagnosticScreenshot?.data ?? []).toString('base64')
    const points = privacyTargets.map((_, index) => {
      const rect = privacyRects[index]
      return { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) }
    })
    privacyPixels = await page.evaluate(async ({ screenshotBase64, points }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${screenshotBase64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0)
      return points.map(point => [...context.getImageData(point.x, point.y, 1, 1).data])
    }, { screenshotBase64, points })
  } finally {
    await privacyBrowser.close()
  }
  const privacyCleared = await call(a, 'privacy-clear-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `(() => { for (const id of ['text', 'privacy-password', 'privacy-otp']) document.getElementById(id).value = ''; document.getElementById('privacy-challenge').textContent = ''; delete globalThis.__pasteFixture; return true })()`,
  })
  assert(diagnosticStart.isError === false
    && diagnosticStart.value.data.diagnosticContext.schemaVersion === 2
    && typeof diagnosticStart.value.data.diagnosticContext.navigationId === 'string'
    && diagnosticStatus.isError === false
    && diagnosticStatus.value.data.active === true
    && diagnosticStatus.value.data.diagnosticContext.debugSessionId === diagnosticStart.value.data.debugSessionId
    && diagnosticInspect.isError === false
    && diagnosticInspect.value.data.element.visible === true
    && diagnosticInspect.value.data.element.viewportIntersection === true
    && diagnosticInspect.value.data.element.identity.resolution === 'resolved-by-ref'
    && diagnosticInspect.value.data.element.identity.navigationId === diagnosticStart.value.data.diagnosticContext.navigationId
    && occludedInspect.isError === false
    && occludedInspect.value.data.element.hitTest.targetMatches === false
    && occludedInspect.value.data.element.hitTest.topElement.id === 'transparent-overlay'
    && occludedInspect.value.data.element.hitTest.occlusionChain.some(element => element.id === 'transparent-overlay')
    && occludedInspect.value.data.element.styles.pointerEvents === 'auto'
    && canvasInspect.isError === false
    && canvasInspect.value.data.element.canvas.backingWidth === 300
    && canvasInspect.value.data.element.canvas.backingHeight === 150
    && canvasInspect.value.data.element.canvas.cssWidth === 150
    && canvasInspect.value.data.element.canvas.cssHeight === 75
    && canvasInspect.value.data.element.canvas.backingScaleX === 2
    && canvasInspect.value.data.element.canvas.backingScaleY === 2
    && portalInspect.isError === false
    && portalInspect.value.data.element.portal.candidate === true
    && portalInspect.value.data.element.portal.root.id === 'portal-root'
    && portalInspect.value.data.element.portal.overflow.right === 0
    && portalInspect.value.data.element.portal.overflow.bottom === 0
    && diagnosticBaseline.isError === false
    && diagnosticBaseline.value.data.checkpoint.schemaVersion === 2
    && diagnosticBaseline.value.data.checkpoint.environment.provider === 'managed-persistent'
    && diagnosticBaseline.value.data.checkpoint.environment.controlOwner === 'model'
    && diagnosticBaseline.value.data.checkpoint.journalRange.eventCount === 0
    && diagnosticBaseline.value.data.checkpoint.summaries.performance.status === 'unavailable'
    && diagnosticBaseline.value.data.checkpoint.artifactManifest.length === 1
    && diagnosticBaseline.value.data.checkpoint.artifactManifest[0].kind === 'screenshot'
    && storedDiagnosticScreenshot?.ref.attachmentId === diagnosticScreenshotRef.attachmentId
    && privacyPixels.length === 4
    && privacyPixels.every(pixel => pixel[0] === 91 && pixel[1] === 33 && pixel[2] === 182 && pixel[3] === 255)
    && privacyCleared.isError === false
    && diagnosticBaseline.value.data.checkpoint.l3.l3CheckpointSchemaVersion === 1
    && diagnosticBaseline.value.data.checkpoint.l3.contextTopology.contextTopologySchemaVersion === 1
    && diagnosticBaseline.value.data.checkpoint.l3.recorder.recorderSchemaVersion === 1
    && Array.isArray(diagnosticBaseline.value.data.checkpoint.l3.builds)
    && diagnosticBaseline.value.data.checkpoint.l3.applications.some(application => application.kind === 'shell')
    && diagnosticBaseline.value.data.checkpoint.l3.surface.rendererType === 'html',
  `browser_diagnose start, enhanced inspect, or baseline checkpoint failed: ${JSON.stringify({ diagnosticInspect, occludedInspect, canvasInspect, portalInspect })}`)
  const diagnosticTrigger = await call(a, 'diagnostic-trigger-a', 'browser_click', { ref: diagnosticRef })
  assert(diagnosticTrigger.isError === false, 'diagnostic trigger click failed')
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
  const diagnosticReproduction = await call(a, 'diagnostic-reproduction-a', 'browser_diagnose', { action: 'checkpoint', ref: diagnosticRef, label: 'reproduction' })
  assert(diagnosticReproduction.isError === false, `browser_diagnose reproduction checkpoint failed: ${JSON.stringify(diagnosticReproduction)}`)
  const diagnosticBaselineId = diagnosticBaseline.value.data.checkpoint.checkpointId
  const diagnosticReproductionId = diagnosticReproduction.value.data.checkpoint.checkpointId
  const diagnosticCompare = await call(a, 'diagnostic-compare-a', 'browser_diagnose', { action: 'compare', beforeCheckpointId: diagnosticBaselineId, afterCheckpointId: diagnosticReproductionId })
  const diagnosticReport = await call(a, 'diagnostic-report-a', 'browser_diagnose', { action: 'report' })
  assert(diagnosticCompare.isError === false, `browser_diagnose compare failed: ${JSON.stringify(diagnosticCompare)}`)
  assert(diagnosticReport.isError === false, `browser_diagnose report failed: ${JSON.stringify(diagnosticReport)}`)
  const diagnosticFailedStatuses = diagnosticReport.value.data.evidence.failedRequests.map(request => request.status).filter(status => status !== undefined).sort((left, right) => left - right)
  const diagnosticSourceMapCount = diagnosticReport.value.data.sourceMaps.length
  const diagnosticSourceMapSummary = diagnosticReport.value.data.sourceMaps.map(mapping => mapping.confidence).join(',')
  const diagnosticClickTimeline = diagnosticReport.value.data.actionTimeline.find(item => item.toolName === 'browser_click')
  assert(typeof diagnosticClickTimeline?.actionId === 'string', `browser_diagnose did not return an action id: ${JSON.stringify(diagnosticReport.value.data.actionTimeline)}`)
  const diagnosticIncrementalReport = await call(a, 'diagnostic-report-incremental-a', 'browser_diagnose', { action: 'report', sinceActionId: diagnosticClickTimeline.actionId })
  assert(diagnosticIncrementalReport.isError === false, `browser_diagnose incremental report failed: ${JSON.stringify(diagnosticIncrementalReport)}`)
  assert(diagnosticCompare.value.data.console.added.some(event => event.text.includes('diagnostic-page-error'))
    && diagnosticCompare.value.data.network.added.some(event => event.status === 409)
    && diagnosticCompare.value.data.schemaVersion === 2
    && diagnosticCompare.value.data.comparability.comparable === true
    && diagnosticCompare.value.data.overallVerdict === 'regressed'
    && diagnosticCompare.value.data.verdicts.console === 'regressed'
    && diagnosticCompare.value.data.verdicts.network === 'regressed'
    && diagnosticCompare.value.data.verdicts.performance === 'evidence-insufficient'
    && diagnosticCompare.value.data.newRegressions.errors.length >= 1
    && diagnosticCompare.value.data.newRegressions.failedRequests.length >= 1
    && diagnosticCompare.value.data.l3Comparison.l3CompareSchemaVersion === 1
    && diagnosticCompare.value.data.l3Comparison.comparability.comparable === true
    && diagnosticCompare.value.data.l3Comparison.verdict !== 'incomparable'
    && diagnosticReport.value.data.evidence.errors.some(event => event.text.includes('diagnostic-page-error'))
    && diagnosticReport.value.data.evidence.errors.some(event => event.text.includes('diagnostic-console-error'))
    && diagnosticReport.value.data.evidence.errors.some(event => event.text.includes('diagnostic-unhandled-rejection'))
    && diagnosticReport.value.data.evidence.errors.every(event => !event.text.includes('visible-secret') && !String(event.stack).includes('visible-secret'))
    && diagnosticReport.value.data.evidence.failedRequests.every(request => !request.url.includes('visible-secret'))
    && diagnosticReport.value.data.evidence.failedRequests.some(request => request.url.includes('/diagnostic-fail') && request.url.includes('REDACTED'))
    && diagnosticFailedStatuses.filter(status => status === 409).length >= 2
    && diagnosticReport.value.data.correlations.some(correlation => correlation.toolName === 'browser_click' && correlation.evidenceEventIds.length >= 2)
    && diagnosticReport.value.data.actionTimeline.some(item => item.actionId === diagnosticClickTimeline.actionId
      && item.evidence.confirmed.length === 0
      && item.evidence.strongCandidates.length + item.evidence.temporalCandidates.length >= 2)
    && diagnosticReport.value.data.incident.schemaVersion === 2
    && diagnosticReport.value.data.incident.triggerActionId === diagnosticClickTimeline.actionId
    && diagnosticReport.value.data.incident.facts.some(fact => fact.kind === 'runtime-error')
    && diagnosticReport.value.data.incident.facts.some(fact => fact.kind === 'failed-request')
    && diagnosticReport.value.data.incident.facts.some(fact => fact.kind === 'source-mapping')
    && diagnosticReport.value.data.incident.causalCandidates.every(candidate => candidate.confidence === 'correlated')
    && diagnosticReport.value.data.markdown.includes(diagnosticReport.value.data.incident.incidentId)
    && diagnosticReport.value.data.markdown.includes(diagnosticReport.value.data.incident.facts[0].evidenceId)
    && diagnosticReport.value.data.artifactManifest.some(artifact => artifact.checkpointId === diagnosticBaselineId && artifact.kind === 'screenshot')
    && diagnosticReport.value.data.incident.costs.artifactCount === 1
    && diagnosticReport.value.data.incident.costs.browserContextCount === 'unavailable'
    && diagnosticReport.value.data.incident.costs.workspaceFixDurationMs === 'unavailable'
    && diagnosticReport.value.data.incident.costs.reportGenerationDurationMs >= 0
    && diagnosticReport.value.data.incident.costs.reportBytes > 0
    && diagnosticIncrementalReport.value.data.range.source === 'action'
    && diagnosticIncrementalReport.value.data.actionTimeline.some(item => item.actionId === diagnosticClickTimeline.actionId)
    && diagnosticIncrementalReport.value.data.evidence.errors.some(event => event.text.includes('diagnostic-page-error'))
    && diagnosticIncrementalReport.value.data.evidence.failedRequests.some(request => request.status === 409)
    && diagnosticSourceMapCount >= 1
    && diagnosticReport.value.data.sourceMaps.some(mapping => mapping.confidence === 'confirmed'
      && mapping.original?.source === '../src/diagnostic-fixture.ts'
      && mapping.workspace?.path === 'src/diagnostic-fixture.ts'
      && mapping.workspace?.confidence === 'mapped-workspace-unconfirmed'
      && typeof mapping.sourceMapId === 'string'
      && typeof mapping.build?.buildId === 'string'
      && mapping.build?.documentUrl === new URL(origin).href
      && typeof mapping.build?.generatedContentSha256 === 'string'),
  `browser_diagnose evidence chain failed: ${JSON.stringify({ compare: diagnosticCompare.value, report: diagnosticReport.value })}`)
  const diagnosticPanelInspect = await call(a, 'diagnostic-panel-inspect-a', 'browser_diagnose', { action: 'inspect', ref: occludedRef })
  assert(diagnosticPanelInspect.isError === false, `browser_diagnose panel inspect failed: ${JSON.stringify(diagnosticPanelInspect)}`)
  const diagnosticPanelBeforeRead = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic' })
  assert(diagnosticPanelBeforeRead.diagnostic?.active === true
    && diagnosticPanelBeforeRead.diagnostic.recording === true
    && diagnosticPanelBeforeRead.diagnostic.debugSession?.debugSessionId === diagnosticStart.value.data.debugSessionId
    && diagnosticPanelBeforeRead.diagnostic.debugSession.checkpointCount === 2
    && diagnosticPanelBeforeRead.diagnostic.debugSession.checkpoints.some(item => item.checkpointId === diagnosticBaselineId)
    && diagnosticPanelBeforeRead.diagnostic.synchronization.status === 'same-view'
    && diagnosticPanelBeforeRead.diagnostic.currentIdentity.viewport.deviceScaleFactor === 1
    && diagnosticPanelBeforeRead.diagnostic.currentIdentity.viewport.mobile === false
    && diagnosticPanelBeforeRead.diagnostic.contextTopology?.contextTopologySchemaVersion === 1
    && diagnosticPanelBeforeRead.diagnostic.contextTopology.targetCount >= 1
    && diagnosticPanelBeforeRead.diagnostic.contextTopology.frameCount >= 1
    && diagnosticPanelBeforeRead.diagnostic.contextTopology.executionContextCount >= 1
    && typeof diagnosticPanelBeforeRead.diagnostic.contextTopology.mainFrameId === 'string'
    && diagnosticPanelBeforeRead.diagnostic.unread.total >= 1
    && diagnosticPanelBeforeRead.diagnostic.timeline.some(item => item.actionId === diagnosticClickTimeline.actionId && item.humanInitiated === false)
    && diagnosticPanelBeforeRead.diagnostic.latestInspect?.occluder?.id === 'transparent-overlay'
    && diagnosticPanelBeforeRead.diagnostic.latestComparison?.overallVerdict === 'regressed'
    && diagnosticPanelBeforeRead.diagnostic.latestIncident?.incidentId === diagnosticReport.value.data.incident.incidentId,
  `phase 2E diagnostic panel snapshot is incomplete: ${JSON.stringify(diagnosticPanelBeforeRead.diagnostic)}`)
  const diagnosticPanelAfterRead = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic', diagnosticReadSequence: diagnosticPanelBeforeRead.diagnostic.unread.latestSequence })
  assert(diagnosticPanelAfterRead.diagnostic?.unread.total === 0
    && diagnosticPanelAfterRead.diagnostic.timeline.length === diagnosticPanelBeforeRead.diagnostic.timeline.length,
  'phase 2E unread acknowledgement removed journal evidence or did not clear the current view count')
  const shadowQuery = await call(a, 'l3-shadow-query-a', 'browser_query', { selector: '#l3-shadow-target', field: 'refs', limit: 1 })
  const shadowRef = shadowQuery.value?.data?.refs?.[0]?.ref
  const shadowInspect = await call(a, 'l3-shadow-inspect-a', 'browser_diagnose', { action: 'inspect', ref: shadowRef })
  const shadowGeneration = shadowInspect.value?.data?.element?.surface?.rootGeneration
  const rebuildShadow = await call(a, 'l3-shadow-rebuild-a', 'browser_evaluate', { action: 'main_world', viewId: diagnosticSnapshot.value.viewId, expression: `document.querySelector('#l3-shadow-rebuild').click(); true` })
  const staleShadowInspect = await call(a, 'l3-shadow-stale-a', 'browser_diagnose', { action: 'inspect', ref: shadowRef })
  const shadowNextQuery = await call(a, 'l3-shadow-next-query-a', 'browser_query', { selector: '#l3-shadow-target', field: 'refs', limit: 1 })
  const shadowNextInspect = await call(a, 'l3-shadow-next-inspect-a', 'browser_diagnose', { action: 'inspect', ref: shadowNextQuery.value?.data?.refs?.[0]?.ref })
  assert(shadowQuery.isError === false
    && shadowInspect.isError === false
    && shadowInspect.value.data.element.surface.rendererType === 'shadow-dom'
    && shadowInspect.value.data.element.surface.rootType === 'open'
    && shadowInspect.value.data.element.surface.capability === 'open-inspectable'
    && shadowInspect.value.data.element.surface.depth === 1
    && shadowInspect.value.data.element.surface.shadowHosts.some(host => host.id === 'l3-shadow-host')
    && shadowInspect.value.data.element.surface.composedTreePath.includes('button')
    && shadowInspect.value.data.element.application.name === 'Workflow Designer'
    && shadowInspect.value.data.element.application.kind === 'root'
    && shadowInspect.value.data.element.surface.retargetedTarget.id === 'l3-shadow-host'
    && shadowInspect.value.data.element.surface.shadowTargetMatches === true
    && shadowInspect.value.data.element.hitTest.targetMatches === true
    && rebuildShadow.isError === false
    && staleShadowInspect.isError === true
    && staleShadowInspect.error?.info?.code === 'STALE_REF'
    && shadowNextInspect.isError === false
    && shadowNextInspect.value.data.element.surface.rootGeneration > shadowGeneration,
  `Open Shadow identity, inspect, or root generation failed: ${JSON.stringify({ shadowInspect, staleShadowInspect, shadowNextInspect })}`)
  const shadowCheckpoint = await call(a, 'l3-shadow-checkpoint-a', 'browser_diagnose', { action: 'checkpoint', ref: shadowNextQuery.value?.data?.refs?.[0]?.ref, label: 'shadow-context' })
  const htmlToShadowCompare = await call(a, 'l3-html-shadow-compare-a', 'browser_diagnose', { action: 'compare', beforeCheckpointId: diagnosticReproductionId, afterCheckpointId: shadowCheckpoint.value?.data?.checkpoint?.checkpointId })
  assert(shadowCheckpoint.isError === false
    && shadowCheckpoint.value.data.checkpoint.l3.surface.rendererType === 'shadow-dom'
    && shadowCheckpoint.value.data.checkpoint.l3.selectedApplicationId === shadowCheckpoint.value.data.checkpoint.element.application.applicationId
    && shadowCheckpoint.value.data.checkpoint.element.application.name === 'Workflow Designer'
    && htmlToShadowCompare.isError === false
    && htmlToShadowCompare.value.data.l3Comparison.comparability.comparable === false
    && htmlToShadowCompare.value.data.l3Comparison.comparability.reasons.includes('surface renderer differs')
    && htmlToShadowCompare.value.data.l3Comparison.verdict === 'incomparable',
  `L3 Checkpoint or surface comparability is invalid: ${JSON.stringify({ shadowCheckpoint, htmlToShadowCompare })}`)
  const closedShadowQuery = await call(a, 'l3-closed-shadow-query-a', 'browser_query', { selector: '#l3-closed-shadow-host', field: 'refs', limit: 1 })
  const closedShadowInspect = await call(a, 'l3-closed-shadow-inspect-a', 'browser_diagnose', { action: 'inspect', ref: closedShadowQuery.value?.data?.refs?.[0]?.ref })
  assert(closedShadowInspect.isError === false
    && closedShadowInspect.value.data.element.surface.rendererType === 'shadow-dom'
    && closedShadowInspect.value.data.element.surface.rootType === 'closed'
    && closedShadowInspect.value.data.element.surface.capability === 'host-only'
    && JSON.stringify(closedShadowInspect.value.data.element).includes('Closed internal') === false,
  `Closed Shadow capability was overstated or leaked internal content: ${JSON.stringify(closedShadowInspect)}`)
  const svgQuery = await call(a, 'l3-svg-query-a', 'browser_query', { selector: '#l3-svg-target', field: 'refs', limit: 1 })
  const svgInspect = await call(a, 'l3-svg-inspect-a', 'browser_diagnose', { action: 'inspect', ref: svgQuery.value?.data?.refs?.[0]?.ref })
  const svgSurface = svgInspect.value?.data?.element?.surface
  assert(svgInspect.isError === false
    && svgSurface.rendererType === 'svg'
    && svgSurface.tag === 'rect'
    && svgSurface.localBBox.x === 2
    && svgSurface.localBBox.y === 3
    && svgSurface.localBBox.width === 20
    && svgSurface.localBBox.height === 10
    && svgSurface.viewBox.width === 100
    && svgSurface.viewBox.height === 50
    && typeof svgSurface.ctm.a === 'number'
    && typeof svgSurface.screenCtm.e === 'number'
    && svgSurface.pointerEvents === 'all'
    && svgSurface.pointerHit === true,
  `SVG surface evidence is invalid: ${JSON.stringify(svgInspect)}`)
  const canvasSurfaceQuery = await call(a, 'l3-canvas-query-a', 'browser_query', { selector: '#l3-canvas', field: 'refs', limit: 1 })
  const canvasSurfaceInspect = await call(a, 'l3-canvas-inspect-a', 'browser_diagnose', { action: 'inspect', ref: canvasSurfaceQuery.value?.data?.refs?.[0]?.ref })
  const canvasSurface = canvasSurfaceInspect.value?.data?.element?.surface
  assert(canvasSurfaceInspect.isError === false
    && canvasSurface.rendererType === 'canvas'
    && canvasSurface.capabilityLevel === 'surface-only'
    && canvasSurface.cssWidth === 180
    && canvasSurface.cssHeight === 90
    && canvasSurface.backingWidth === 360
    && canvasSurface.backingHeight === 180
    && canvasSurface.backingScaleX === 2
    && canvasSurface.backingScaleY === 2
    && Math.abs(canvasSurface.coordinate.canvasBackingPoint.x - 180) <= 0.5
    && Math.abs(canvasSurface.coordinate.canvasBackingPoint.y - 90) <= 0.5
    && canvasSurface.coordinate.inBounds === true,
  `Canvas surface evidence is invalid: ${JSON.stringify(canvasSurfaceInspect)}`)
  const releaseQuery = await call(a, 'l3-release-query-a', 'browser_query', { selector: '#l3-release-action', field: 'refs', limit: 1 })
  const releaseInspect = await call(a, 'l3-release-inspect-a', 'browser_diagnose', { action: 'inspect', ref: releaseQuery.value?.data?.refs?.[0]?.ref })
  const applicationStatus = await call(a, 'l3-application-status-a', 'browser_diagnose', { action: 'status' })
  const initialApplications = applicationStatus.value?.data?.applicationTopology?.applications ?? []
  assert(releaseInspect.isError === false
    && releaseInspect.value.data.element.application.name === 'Release Center'
    && releaseInspect.value.data.element.application.kind === 'module-federation'
    && releaseInspect.value.data.element.application.confidence === 'confirmed'
    && initialApplications.some(application => application.kind === 'shell' && application.confidence === 'confirmed')
    && initialApplications.some(application => application.name === 'Workflow Designer' && application.kind === 'root' && application.confidence === 'confirmed')
    && initialApplications.some(application => application.name === 'Release Center' && application.kind === 'module-federation' && application.confidence === 'confirmed' && application.signals.includes('explicit-remote-entry'))
    && initialApplications.some(application => application.name === 'Incomplete Remote' && application.kind === 'module-federation' && application.confidence === 'candidate' && application.counterEvidence.length === 1),
  `Application root detection or element attribution is invalid: ${JSON.stringify({ releaseInspect, initialApplications })}`)
  const crossOrigin = `http://localhost:${port}`
  const l3FramesCreated = await call(a, 'l3-frames-create-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `(async () => {
      const create = (id, src) => new Promise((resolve, reject) => {
        const frame = document.createElement('iframe')
        frame.id = id
        frame.name = id
        frame.addEventListener('load', () => resolve(frame.src), { once: true })
        frame.addEventListener('error', reject, { once: true })
        frame.src = src
        document.body.appendChild(frame)
      })
      return Promise.all([
        create('l3-same-frame', ${JSON.stringify(`${origin}/l3-frame?kind=same`)}),
        create('l3-cross-frame', ${JSON.stringify(`${crossOrigin}/l3-frame?kind=cross`)}),
      ])
    })()`,
    awaitPromise: true,
  })
  assert(l3FramesCreated.isError === false, `L3 frame fixture creation failed: ${JSON.stringify(l3FramesCreated)}`)
  await new Promise(resolveWait => setTimeout(resolveWait, 300))
  const l3StatusInitial = await call(a, 'l3-status-initial-a', 'browser_diagnose', { action: 'status' })
  const l3TopologyInitial = l3StatusInitial.value?.data?.contextTopology
  const l3MainFrame = l3TopologyInitial?.frames.find(frame => frame.mainFrame)
  const l3SameFrame = l3TopologyInitial?.frames.find(frame => frame.url.includes('/l3-frame?kind=same'))
  const l3CrossFrame = l3TopologyInitial?.frames.find(frame => frame.url.includes('/l3-frame?kind=cross'))
  assert(l3StatusInitial.isError === false
    && l3TopologyInitial?.contextTopologySchemaVersion === 1
    && l3TopologyInitial.targets.length >= 1
    && l3TopologyInitial.frames.length >= 3
    && l3TopologyInitial.executionContexts.some(context => context.worldType === 'main')
    && typeof l3MainFrame?.frameId === 'string'
    && l3SameFrame?.parentFrameId === l3MainFrame.frameId
    && l3CrossFrame?.parentFrameId === l3MainFrame.frameId
    && l3SameFrame.frameId !== l3CrossFrame.frameId
    && l3CrossFrame.oopif === true
    && l3CrossFrame.documentGeneration === 1
    && l3TopologyInitial.degradations.some(item => item.code === 'oopif-target-context-limited' && item.frameId === l3CrossFrame.frameId),
  `L3 initial context topology is invalid: ${JSON.stringify(l3TopologyInitial)}`)
  const l3SameFrameQuery = await call(a, 'l3-same-frame-query-a', 'browser_query', {
    frameId: l3SameFrame.frameId,
    selector: '#frame-action',
    field: 'refs',
    limit: 1,
  })
  const l3SameFrameRef = l3SameFrameQuery.value?.data?.refs?.[0]?.ref
  const l3SameFrameInspect = await call(a, 'l3-same-frame-inspect-a', 'browser_diagnose', { action: 'inspect', ref: l3SameFrameRef })
  assert(l3SameFrameQuery.isError === false
    && typeof l3SameFrameRef === 'string'
    && l3SameFrameQuery.value.data.targetId === l3SameFrame.targetId
    && l3SameFrameQuery.value.data.frameId === l3SameFrame.frameId
    && l3SameFrameQuery.value.data.frameDocumentGeneration === l3SameFrame.documentGeneration
    && l3SameFrameInspect.isError === false
    && l3SameFrameInspect.value.data.element.identity.targetId === l3SameFrame.targetId
    && l3SameFrameInspect.value.data.element.identity.frameId === l3SameFrame.frameId
    && l3SameFrameInspect.value.data.element.identity.frameDocumentGeneration === l3SameFrame.documentGeneration,
  `same-origin Frame query or inspect identity is invalid: ${JSON.stringify({ query: l3SameFrameQuery, inspect: l3SameFrameInspect })}`)
  const l3CrossFrameQuery = await call(a, 'l3-cross-frame-query-a', 'browser_query', {
    frameId: l3CrossFrame.frameId,
    selector: '#frame-action',
    field: 'refs',
    limit: 1,
  })
  assert(l3CrossFrameQuery.isError === true
    && l3CrossFrameQuery.error.info?.code === 'POLICY_DENIED'
    && JSON.stringify(l3CrossFrameQuery.error).includes('FRAME_QUERY_CROSS_ORIGIN_UNAVAILABLE'),
  `cross-origin or OOPIF Frame query did not fail closed: ${JSON.stringify(l3CrossFrameQuery)}`)
  const l3Applications = l3StatusInitial.value?.data?.applicationTopology?.applications ?? []
  assert(l3Applications.some(application => application.kind === 'iframe' && application.frameId === l3SameFrame.frameId && application.confidence === 'confirmed')
    && l3Applications.some(application => application.kind === 'iframe' && application.frameId === l3CrossFrame.frameId && application.confidence === 'confirmed'),
  `iframe and OOPIF Application Identity is invalid: ${JSON.stringify(l3Applications)}`)
  const l3ClosureReport = await call(a, 'l3-closure-report-a', 'browser_diagnose', { action: 'report' })
  const l3Incident = l3ClosureReport.value?.data?.l3Incident
  const surfaceLinks = l3ClosureReport.value?.data?.crossContextLinks?.filter(link => link.relation === 'surface-owned-by-application') ?? []
  assert(l3ClosureReport.isError === false
    && l3Incident.l3IncidentSchemaVersion === 1
    && l3Incident.context.contextTopologySchemaVersion === 1
    && l3Incident.recorder.recorderSchemaVersion === 1
    && l3Incident.applications.some(application => application.name === 'Workflow Designer')
    && Array.isArray(l3Incident.builds)
    && Array.isArray(l3Incident.degradations)
    && l3Incident.degradations.includes('oopif-target-context-limited')
    && l3Incident.comparison.verdict === 'incomparable'
    && l3Incident.uncertainty.some(value => value.includes('Application identities remain candidates'))
    && surfaceLinks.length === 1
    && surfaceLinks[0].toId === shadowCheckpoint.value.data.checkpoint.element.application.applicationId
    && JSON.parse(JSON.stringify(l3ClosureReport.value.data.l3Incident)).l3IncidentSchemaVersion === 1,
  `L3 Incident, CrossContextLink, degradation, or lossless JSON is invalid: ${JSON.stringify(l3ClosureReport)}`)
  const l3Scripts = await call(a, 'l3-frame-scripts-a', 'browser_debugger', { action: 'scripts', viewId: diagnosticSnapshot.value.viewId })
  const l3SameScript = l3Scripts.value?.data?.scripts?.find(script => script.url.includes('/l3-frame-script.js?kind=same'))
  assert(l3Scripts.isError === false
    && l3SameScript?.frameId === l3SameFrame.frameId
    && l3SameScript.frameDocumentGeneration === l3SameFrame.documentGeneration
    && typeof l3SameScript.executionContextId === 'number'
    && l3SameScript.worldType === 'main',
  `L3 same-frame script identity is invalid: ${JSON.stringify(l3SameScript)}`)
  const l3SameGeneration = l3SameFrame.documentGeneration
  const l3SameRoute = await call(a, 'l3-same-route-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `document.querySelector('#l3-same-frame').contentWindow.location.hash = 'route-2'; true`,
  })
  assert(l3SameRoute.isError === false, 'L3 same-document frame route failed')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  const l3StatusRoute = await call(a, 'l3-status-route-a', 'browser_diagnose', { action: 'status' })
  const l3SameAfterRoute = l3StatusRoute.value.data.contextTopology.frames.find(frame => frame.frameId === l3SameFrame.frameId)
  assert(l3SameAfterRoute?.documentGeneration === l3SameGeneration && l3SameAfterRoute.url.endsWith('#route-2'), `same-document frame route incorrectly changed document generation: ${JSON.stringify(l3SameAfterRoute)}`)
  const l3SameNavigate = await call(a, 'l3-same-navigate-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `(async () => {
      const frame = document.querySelector('#l3-same-frame')
      await new Promise((resolve, reject) => {
        frame.addEventListener('load', resolve, { once: true })
        frame.addEventListener('error', reject, { once: true })
        frame.src = ${JSON.stringify(`${origin}/l3-frame?kind=same-next`)}
      })
      return true
    })()`,
    awaitPromise: true,
  })
  assert(l3SameNavigate.isError === false, 'L3 cross-document frame navigation failed')
  await new Promise(resolveWait => setTimeout(resolveWait, 200))
  const l3StatusNavigated = await call(a, 'l3-status-navigated-a', 'browser_diagnose', { action: 'status' })
  const l3SameNavigated = l3StatusNavigated.value.data.contextTopology.frames.find(frame => frame.frameId === l3SameFrame.frameId)
  assert(l3SameNavigated?.documentGeneration === l3SameGeneration + 1 && l3SameNavigated.url.includes('kind=same-next'), `cross-document frame navigation did not advance document generation: ${JSON.stringify(l3SameNavigated)}`)
  const l3FrameReport = await call(a, 'l3-frame-report-a', 'browser_diagnose', { action: 'report', sinceCursor: diagnosticPanelBeforeRead.diagnostic.unread.latestSequence })
  const l3FrameErrors = l3FrameReport.value?.data?.evidence?.errors ?? []
  const l3FrameRequests = l3FrameReport.value?.data?.evidence?.failedRequests ?? []
  assert(l3FrameReport.isError === false
    && l3FrameErrors.some(event => event.text.includes('l3-same-frame-console') && event.frameId === l3SameFrame.frameId)
    && l3FrameRequests.some(event => event.url.includes('kind=same') && event.frameId === l3SameFrame.frameId)
    && l3FrameRequests.some(event => event.url.includes('kind=cross') && event.frameId === l3CrossFrame.frameId)
    && l3FrameRequests.every(event => event.frameId !== l3MainFrame.frameId || !event.url.includes('/l3-frame-fail')),
  `L3 frame evidence attribution failed: ${JSON.stringify({ errors: l3FrameErrors, requests: l3FrameRequests, topology: l3StatusNavigated.value?.data?.contextTopology })}`)
  const l3RemoveFrame = await call(a, 'l3-frame-remove-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: diagnosticSnapshot.value.viewId,
    expression: `document.querySelector('#l3-same-frame').remove(); true`,
  })
  assert(l3RemoveFrame.isError === false, 'L3 frame removal failed')
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  const l3StatusRemoved = await call(a, 'l3-status-removed-a', 'browser_diagnose', { action: 'status' })
  assert(!l3StatusRemoved.value.data.contextTopology.frames.some(frame => frame.frameId === l3SameFrame.frameId), 'detached frame remained active in L3 topology')
  const l3SessionCStart = await call(c, 'l3-session-c-start', 'browser_diagnose', { action: 'start' })
  const l3SessionCStatus = await call(c, 'l3-session-c-status', 'browser_diagnose', { action: 'status' })
  const l3SessionCStop = await call(c, 'l3-session-c-stop', 'browser_diagnose', { action: 'stop' })
  assert(l3SessionCStart.isError === false
    && l3SessionCStatus.isError === false
    && l3SessionCStatus.value.data.contextTopology.frames.every(frame => !frame.url.includes('/l3-frame'))
    && l3SessionCStatus.value.data.contextTopology.targets.every(target => !l3TopologyInitial.targets.some(other => other.targetId === target.targetId))
    && l3SessionCStop.isError === false,
  `L3 context topology leaked across DSH sessions: ${JSON.stringify(l3SessionCStatus.value?.data?.contextTopology)}`)
  const navB = await call(b, 'nav-b', 'browser_navigate', { url: origin })
  assert(navB.isError === false, 'subagent read-only navigation failed')
  const subagentDiagnoseDenied = await call(b, 'diagnostic-start-b', 'browser_diagnose', { action: 'start' })
  const consoleB = await call(b, 'diagnostic-console-b', 'browser_console_messages', {})
  const networkB = await call(b, 'diagnostic-network-b', 'browser_network_requests', {})
  assert(subagentDiagnoseDenied.isError === true, 'subagent browser_diagnose was not denied')
  assert(consoleB.isError === false && consoleB.value.data.messages.every(message => !message.text.includes('diagnostic-')), 'session A diagnostic console events leaked into session B')
  assert(networkB.isError === false && networkB.value.data.requests.every(request => !request.url.includes('/diagnostic-fail') && !request.url.includes('/diagnostic-race')), 'session A diagnostic network events leaked into session B')
  const denied = await call(b, 'click-b', 'browser_click', { element: 'Target 1', ref: target })
  assert(denied.isError === true, 'subagent interactive call was not denied')
  const subagentDebuggerAttach = await call(b, 'debugger-attach-b', 'browser_debugger', { action: 'attach', viewId: 'v1' })
  assert(subagentDebuggerAttach.isError === false, 'subagent debugger read-only attach was denied')
  const subagentDebuggerDenied = await call(b, 'debugger-pause-b', 'browser_debugger', { action: 'pause', viewId: 'v1' })
  assert(subagentDebuggerDenied.isError === true, 'subagent debugger mutation was not denied')
  const subagentSplitStatus = await call(b, 'split-status-b', 'browser_split_view', { action: 'status' })
  const subagentSplitDenied = await call(b, 'split-open-b', 'browser_split_view', { action: 'open' })
  assert(subagentSplitStatus.isError === false && subagentSplitDenied.isError === true, 'subagent split view boundary failed')
  const extensionsA = await call(a, 'extensions-list-a', 'browser_extensions', { action: 'list' })
  const extensionsB = await call(b, 'extensions-list-b', 'browser_extensions', { action: 'list' })
  const subagentExtensionDenied = await call(b, 'extensions-enable-b', 'browser_extensions', { action: 'enable', extensionId: seededExtensionB, applyMode: 'next_start' })
  assert(extensionsA.isError === false && extensionsA.value.data.extensions.length === 1 && extensionsA.value.data.extensions[0].extensionId === seededExtensionA, 'session A extension registry was not loaded')
  assert(extensionsB.isError === false && extensionsB.value.data.extensions.length === 1 && extensionsB.value.data.extensions[0].extensionId === seededExtensionA, 'default sessions did not expose the same shared extension registry')
  assert(extensionsA.value.data.extensions[0].actionPopup === 'popup.html', 'legacy extension registry did not hydrate action popup metadata from manifest')
  assert(subagentExtensionDenied.isError === true, 'subagent browser extension mutation was not denied')
  const tabsA = await call(a, 'tabs-a', 'browser_tabs', {})
  const tabsB = await call(b, 'tabs-b', 'browser_tabs', { action: 'list' })
  assert(typeof tabsA.value.viewId === 'string'
    && typeof tabsB.value.viewId === 'string'
    && tabsA.value.data.tabs.length === 1
    && tabsB.value.data.tabs.length === 1,
  `session view ownership is invalid: ${JSON.stringify({ tabsA: tabsA.value, tabsB: tabsB.value })}`)
  const blankTab = await call(a, 'tabs-blank-a', 'browser_tabs', { action: 'new', url: 'about:blank' })
  assert(blankTab.isError === false && blankTab.value.data.tabs.length === tabsA.value.data.tabs.length + 1, 'browser_tabs did not normalize about:blank')
  const tabsCAfterANew = await call(c, 'tabs-after-a-new-c', 'browser_tabs', { action: 'list' })
  assert(tabsCAfterANew.isError === false && tabsCAfterANew.value.data.tabs.length === sharedTabsAfterRestart.value.data.tabs.length, 'shared context exposed session A tabs to session C')
  const whitespaceView = await call(a, 'snapshot-whitespace-view-a', 'browser_snapshot', { viewId: '   ' })
  assert(whitespaceView.isError === false && whitespaceView.value.viewId === blankTab.value.viewId, 'blank viewId was not normalized to the active view')
  const closeBlank = await call(a, 'tabs-close-blank-a', 'browser_tabs', { action: 'close', viewId: '', index: 1 })
  assert(closeBlank.isError === false && closeBlank.value.data.tabs.length === tabsA.value.data.tabs.length, 'browser_tabs index close failed')
  const deniedTab = await call(a, 'tabs-denied-a', 'browser_tabs', { action: 'new', url: 'data:text/html,denied' })
  assert(deniedTab.isError === true && deniedTab.error.info?.code === 'POLICY_DENIED', 'browser_tabs rejected URL did not fail with POLICY_DENIED')
  const tabsAfterDenied = await call(a, 'tabs-after-denied-a', 'browser_tabs', { action: 'list' })
  assert(tabsAfterDenied.value.data.tabs.length === tabsA.value.data.tabs.length, 'browser_tabs rejected URL changed the tab count')
  const failedNavigationTab = await call(a, 'tabs-failed-navigation-a', 'browser_tabs', { action: 'new', url: `${origin}/disconnect` })
  assert(failedNavigationTab.isError === true, 'browser_tabs failed navigation unexpectedly succeeded')
  const tabsAfterFailedNavigation = await call(a, 'tabs-after-failed-navigation-a', 'browser_tabs', { action: 'list' })
  assert(tabsAfterFailedNavigation.value.data.tabs.length === tabsA.value.data.tabs.length, 'browser_tabs failed navigation changed the tab count')
  assert(tabsAfterFailedNavigation.value.viewId === tabsA.value.viewId, 'browser_tabs failed navigation changed the active tab')
  const newTab = await Promise.race([
    call(a, 'tabs-new-a', 'browser_tabs', { action: 'new', url: origin }),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ timeout: true }), 3000)),
  ])
  assert(newTab.timeout !== true, 'browser_tabs new timed out')
  const selectFirst = await call(a, 'tabs-select-first-a', 'browser_tabs', { action: 'select', index: 0 })
  const primaryViewA = tabsA.value.viewId
  assert(selectFirst.isError === false && selectFirst.value.viewId === primaryViewA, 'browser_tabs index select failed')
  const panelInitial = await rpc('snapshot', { sessionId: 'a', view: 'console' })
  const panelNew = await rpc('tabs', { sessionId: 'a', action: 'new' })
  const panelNewId = panelNew.viewId
  assert(panelNew.ok === true && typeof panelNewId === 'string' && panelNewId !== primaryViewA, 'browser panel did not create a new blank tab')
  const panelNavigate = await rpc('tabs', { sessionId: 'a', action: 'navigate', viewId: panelNewId, url: `${origin}/?panel=1` })
  const panelReload = await rpc('tabs', { sessionId: 'a', action: 'reload', viewId: panelNewId })
  const panelBack = await rpc('tabs', { sessionId: 'a', action: 'back', viewId: panelNewId })
  const panelForward = await rpc('tabs', { sessionId: 'a', action: 'forward', viewId: panelNewId })
  assert([panelNavigate, panelReload, panelBack, panelForward].every(item => item.ok === true), 'browser panel navigation lifecycle failed')
  const unregisterAgent = ctx.agents.register(a)
  const injectedBeforeSelect = a.injected.length
  const panelSelectFirst = await rpc('tabs', { sessionId: 'a', action: 'select', viewId: 'v1', notifyAgent: true })
  const injectedAfterSelect = a.injected.length
  const panelSelectRepeated = await rpc('tabs', { sessionId: 'a', action: 'select', viewId: 'v1', notifyAgent: true })
  assert(panelSelectFirst.ok === true && panelSelectFirst.data.changed === true && injectedAfterSelect === injectedBeforeSelect + 1, 'browser panel tab switch did not notify the active agent exactly once')
  assert(panelSelectRepeated.ok === true && panelSelectRepeated.data.changed === false && a.injected.length === injectedAfterSelect, 'repeated browser panel tab selection duplicated the agent notice')
  const panelAfterSelect = await rpc('snapshot', { sessionId: 'a', view: 'console' })
  assert(panelAfterSelect.activeViewId === primaryViewA && panelAfterSelect.tabs.length === panelInitial.tabs.length + 1 && panelAfterSelect.tabs.some(item => item.viewId === panelNewId && item.title === 'Browser Tools Fixture'), 'browser panel snapshot did not expose all tabs after switching')
  assert(typeof unregisterAgent === 'function', 'browser panel agent registration did not return a disposer')
  const popupOpen = await call(a, 'panel-popup-open-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `document.querySelector('#popup').click()` })
  assert(popupOpen.isError === false, 'fixture popup trigger failed')
  let popupSnapshot
  for (let attempt = 0; attempt < 30; attempt += 1) {
    popupSnapshot = await rpc('snapshot', { sessionId: 'a', view: 'console' })
    if (popupSnapshot.tabs.length === panelAfterSelect.tabs.length + 1) break
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  const popupTab = popupSnapshot?.tabs.find(item => item.viewId === popupSnapshot.activeViewId)
  assert(popupTab !== undefined && popupTab.url.includes('popup=1'), `web page popup was not registered as the active browser panel tab: ${JSON.stringify(popupSnapshot?.tabs)}`)
  const tabsCAfterAWindowOpen = await call(c, 'tabs-after-a-window-open-c', 'browser_tabs', { action: 'list' })
  assert(tabsCAfterAWindowOpen.isError === false && tabsCAfterAWindowOpen.value.data.tabs.length === tabsCAfterANew.value.data.tabs.length, 'window.open page owner crossed from session A into session C')
  await rpc('tabs', { sessionId: 'a', action: 'close', viewId: popupTab.viewId })
  await rpc('tabs', { sessionId: 'a', action: 'select', viewId: 'v1' })
  const pageKey = await call(a, 'key-page-a', 'browser_press_key', { key: 'Escape' })
  assert(pageKey.isError === false, 'page-level browser_press_key failed')
  const emptyRefPageKey = await call(a, 'key-empty-ref-a', 'browser_press_key', { key: 'Escape', ref: '' })
  assert(emptyRefPageKey.isError === false, 'empty optional ref was not normalized to page-level keyboard input')
  const pageScroll = await call(a, 'scroll-page-a', 'browser_scroll', { direction: 'down', amount: 20 })
  assert(pageScroll.isError === false, 'page-level browser_scroll failed')
  const waitSeconds = await call(a, 'wait-seconds-a', 'browser_wait_for', { time: 0.01 })
  assert(waitSeconds.isError === false && waitSeconds.value.data.waitedMs === 10, 'browser_wait_for seconds normalization failed')
  const waitPlaceholders = await call(a, 'wait-placeholders-a', 'browser_wait_for', { state: 'domcontentloaded', text: '', textGone: '', time: 0.01, timeMs: 0 })
  assert(waitPlaceholders.isError === false && waitPlaceholders.value.data.waitedMs === 10, 'browser_wait_for did not ignore empty and zero placeholders')

  const debuggerAttach = await call(a, 'debugger-attach-a', 'browser_debugger', { action: 'attach', viewId: 'v1' })
  assert(debuggerAttach.isError === false && debuggerAttach.value.data.attached === true, 'browser_debugger attach failed')
  const scripts = await rpc('debugger', { sessionId: 'a', action: 'scripts', viewId: 'v1' })
  assert(scripts.ok === true && scripts.data.scripts.some(item => item.url === `${origin}/`), 'browser panel debugger scripts were not returned')
  const fixtureScriptId = scripts.data.scripts.find(item => item.url === `${origin}/`)?.scriptId
  assert(typeof fixtureScriptId === 'string', 'fixture script id was not available')
  const scriptSource = await call(a, 'debugger-script-source-a', 'browser_debugger', { action: 'script_source', viewId: 'v1', scriptId: fixtureScriptId })
  assert(scriptSource.isError === false && (String(scriptSource.value.data.source).includes('fixture-ready') || scriptSource.value.data.artifact?.bytes > 0), 'script_source did not return source or artifact')
  const sourceMap = await call(a, 'debugger-source-map-a', 'browser_debugger', { action: 'source_map', viewId: 'v1', scriptId: fixtureScriptId })
  assert(sourceMap.isError === false && sourceMap.value.data.artifact.bytes > 0, `source_map did not produce an artifact: ${JSON.stringify(sourceMap)}`)
  const breakpoint = await rpc('debugger', { sessionId: 'a', action: 'set_breakpoint', viewId: 'v1', url: `${origin}/`, lineNumber: 26, columnNumber: 0 })
  const breakpointId = breakpoint.data.breakpoints.at(-1)?.breakpointId
  assert(typeof breakpointId === 'string' && breakpointId !== '', 'browser panel breakpoint was not created')
  const debuggerPause = await call(a, 'debugger-pause-a', 'browser_debugger', { action: 'pause', viewId: 'v1' })
  assert(debuggerPause.isError === false, 'browser_debugger pause failed')
  let frames
  for (let attempt = 0; attempt < 20; attempt += 1) {
    frames = await call(a, `debugger-frames-a-${attempt}`, 'browser_debugger', { action: 'call_frames', viewId: 'v1' })
    if (frames.isError === false && frames.value.data.paused === true) break
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  assert(frames?.isError === false && frames.value.data.paused === true, 'browser_debugger did not enter paused state')
  const callFrame = frames.value.data.callFrames.find(item => item.scopes.some(scope => scope.objectId !== undefined))
  const scopeNumber = callFrame?.scopes.findIndex(scope => scope.objectId !== undefined)
  assert(callFrame !== undefined && scopeNumber !== undefined && scopeNumber >= 0, 'browser debugger did not expose a readable scope')
  const scope = await rpc('debugger', { sessionId: 'a', action: 'scope_variables', viewId: 'v1', callFrameId: callFrame.callFrameId, scopeNumber })
  assert(scope.ok === true && Array.isArray(scope.data.properties), 'browser panel scope variables were not returned')
  const pausedNavigate = await call(a, 'paused-nav-a', 'browser_navigate', { url: origin, viewId: 'v1' })
  assert(pausedNavigate.isError === false && pausedNavigate.value.ok === false && pausedNavigate.value.data.code === 'DEBUGGER_PAUSED', 'paused page navigation did not return recovery guidance')
  const debuggerResume = await call(a, 'debugger-resume-a', 'browser_debugger', { action: 'resume', viewId: 'v1' })
  assert(debuggerResume.isError === false, 'browser_debugger resume failed')
  const removedBreakpoint = await rpc('debugger', { sessionId: 'a', action: 'remove_breakpoint', viewId: 'v1', breakpointId })
  assert(removedBreakpoint.ok === true && removedBreakpoint.data.breakpoints.every(item => item.breakpointId !== breakpointId), 'browser panel breakpoint was not removed')
  const isolatedEvaluation = await call(a, 'evaluate-isolated-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: '({ answer: 6 * 7, password: "hidden" })' })
  assert(isolatedEvaluation.isError === false && isolatedEvaluation.value.data.value.answer === 42 && isolatedEvaluation.value.data.value.password === '[REDACTED]', `isolated browser_evaluate did not return a bounded redacted value: ${JSON.stringify(isolatedEvaluation)}`)
  const mainEvaluation = await call(a, 'evaluate-main-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: 'document.title' })
  assert(mainEvaluation.isError === false && mainEvaluation.value.data.value === 'Browser Tools Fixture', 'main-world browser_evaluate failed')

  const networkEnabled = await call(a, 'network-enable-a', 'browser_network_control', { action: 'enable', viewId: 'v1', urlPattern: `${origin}/api`, requestStage: 'response' })
  assert(networkEnabled.isError === false && networkEnabled.value.data.enabled === true, 'browser_network_control enable failed')
  const networkFetch = await call(a, 'network-fetch-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: `void fetch(${JSON.stringify(`${origin}/api`)})` })
  assert(networkFetch.isError === false, 'isolated network fixture fetch failed')
  let pausedRequests
  for (let attempt = 0; attempt < 30; attempt += 1) {
    pausedRequests = await call(a, `network-paused-a-${attempt}`, 'browser_network_control', { action: 'list_paused', viewId: 'v1' })
    if (pausedRequests.isError === false && pausedRequests.value.data.pausedRequests.length > 0) break
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  const pausedRequestId = pausedRequests?.value?.data?.pausedRequests?.[0]?.requestId
  assert(typeof pausedRequestId === 'string' && pausedRequestId !== '', 'network interception did not expose a paused response')
  const networkBody = await call(a, 'network-body-a', 'browser_network_control', { action: 'body', viewId: 'v1', requestId: pausedRequestId })
  const networkBodyText = networkBody.isError === false && networkBody.value.data.base64Encoded === true
    ? Buffer.from(networkBody.value.data.body, 'base64').toString('utf8')
    : String(networkBody.value?.data?.body)
  assert(networkBody.isError === false && networkBody.value.data.bytes > 0 && networkBodyText.includes('browser-tools-v2'), `network response body was not returned: ${JSON.stringify(networkBody)}`)
  const subagentNetworkDenied = await call(b, 'network-body-b', 'browser_network_control', { action: 'body', viewId: 'v1', requestId: pausedRequestId })
  assert(subagentNetworkDenied.isError === true, 'subagent network body access was not denied')
  const networkContinue = await call(a, 'network-continue-a', 'browser_network_control', { action: 'continue', viewId: 'v1', requestId: pausedRequestId })
  assert(networkContinue.isError === false && networkContinue.value.data.pausedRequests.length === 0, 'paused network response was not continued')
  const networkDisabled = await call(a, 'network-disable-a', 'browser_network_control', { action: 'disable', viewId: 'v1' })
  assert(networkDisabled.isError === false && networkDisabled.value.data.enabled === false, 'browser_network_control disable failed')
  const timeoutEnabled = await call(a, 'network-timeout-enable-a', 'browser_network_control', { action: 'enable', viewId: 'v1', urlPattern: `${origin}/api`, requestStage: 'request' })
  assert(timeoutEnabled.isError === false, 'network timeout interception enable failed')
  await call(a, 'network-timeout-fetch-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: `void fetch(${JSON.stringify(`${origin}/api?timeout=1`)})` })
  await new Promise(resolveWait => setTimeout(resolveWait, 1200))
  const afterTimeout = await call(a, 'network-timeout-list-a', 'browser_network_control', { action: 'list_paused', viewId: 'v1' })
  assert(afterTimeout.isError === false && afterTimeout.value.data.pausedRequests.length === 0, 'paused request was not automatically continued after timeout')
  await call(a, 'network-timeout-disable-a', 'browser_network_control', { action: 'disable', viewId: 'v1' })

  let initialLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    initialLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (initialLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(initialLive?.liveView?.mode === 'adaptive' && initialLive.frame?.data.length > 0, 'initial adaptive live view did not produce a frame')
  const panelSwitchOldIdentity = { viewId: initialLive.activeViewId, streamGeneration: initialLive.frame.streamGeneration, frameSequence: initialLive.frame.sequence, viewportGeneration: initialLive.frame.viewportGeneration }
  await rpc('takeover', { sessionId: 'a', action: 'request', viewId: 'v1' })
  const panelSwitchToNew = await rpc('tabs', { sessionId: 'a', action: 'select', viewId: panelNewId })
  const panelSwitchStaleInput = await rpc('input', { sessionId: 'a', action: 'key_press', ...panelSwitchOldIdentity, key: 'Escape' })
  const panelSwitchBack = await rpc('tabs', { sessionId: 'a', action: 'select', viewId: 'v1' })
  await rpc('takeover', { sessionId: 'a', action: 'return', viewId: 'v1' })
  let panelSwitchRestoredLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    panelSwitchRestoredLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (panelSwitchRestoredLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(panelSwitchToNew.ok === true && panelSwitchBack.ok === true && panelSwitchStaleInput.ok === false && panelSwitchStaleInput.data.code === 'STALE_LIVE_VIEW', 'browser panel tab switching did not reject the previous live frame identity')
  assert(panelSwitchRestoredLive?.activeViewId === primaryViewA && panelSwitchRestoredLive.frame?.data.length > 0, 'browser panel did not restart live screencast after switching back')
  const initializedLive = await rpc('live_view', { sessionId: 'a', action: 'initialize', mode: 'adaptive', width: 900, height: 600 })
  assert(initializedLive.ok === true && initializedLive.data.mode === 'adaptive' && initializedLive.data.width === 900 && initializedLive.data.height === 600, 'panel adaptive initialization failed')
  let adaptiveLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    adaptiveLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (adaptiveLive.frame?.viewportGeneration === initializedLive.data.viewportGeneration) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(adaptiveLive?.frame?.viewportGeneration === initializedLive.data.viewportGeneration, 'adaptive viewport did not produce a matching generation frame')
  const liveIdentity = { viewId: adaptiveLive.activeViewId, streamGeneration: adaptiveLive.frame.streamGeneration, frameSequence: adaptiveLive.frame.sequence, viewportGeneration: adaptiveLive.frame.viewportGeneration }
  const recorderInitial = await rpc('recorder', { sessionId: 'a', action: 'status' })
  const recorderStarted = await rpc('recorder', { sessionId: 'a', action: 'start', mode: 'rolling' })
  const recorderRollingPanel = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic' })
  assert(recorderInitial.ok === true
    && recorderInitial.data.mode === 'off'
    && recorderInitial.data.status === 'idle'
    && recorderStarted.ok === true
    && recorderStarted.data.mode === 'rolling'
    && recorderRollingPanel.diagnostic?.recorder.mode === 'rolling'
    && recorderRollingPanel.diagnostic.recorder.deepVisible === false,
  `flight recorder did not preserve Off default or start Rolling explicitly: ${JSON.stringify({ recorderInitial, recorderStarted, recorder: recorderRollingPanel.diagnostic?.recorder })}`)
  const wallClockDurationMs = Number(process.env.L3_WALL_CLOCK_DURATION_MS || 0)
  const wallClockSampleMs = Number(process.env.L3_WALL_CLOCK_SAMPLE_MS || 5000)
  const wallClockRecorderMode = String(process.env.L3_WALL_CLOCK_RECORDER_MODE || 'rolling').toLowerCase()
  assert(['off', 'rolling', 'deep'].includes(wallClockRecorderMode), `unsupported wall-clock recorder mode: ${wallClockRecorderMode}`)
  if (Number.isFinite(wallClockDurationMs) && wallClockDurationMs > 0) {
    if (wallClockRecorderMode === 'off') await rpc('recorder', { sessionId: 'a', action: 'stop' })
    if (wallClockRecorderMode === 'deep') await rpc('recorder', { sessionId: 'a', action: 'start', mode: 'deep' })
    const wallClockForceGc = process.env.L3_WALL_CLOCK_FORCE_GC === '1'
    const wallClockSkipSnapshot = process.env.L3_WALL_CLOCK_SKIP_SNAPSHOT === '1'
    // 三种模式复用同一完整Runtime与相同操作负载，独立进程间比较Recorder的增量开销；归因开关只供短程A/B，不改变正式默认负载。
    const wallClockStartedAt = Date.now()
    const wallClockSamples = []
    let wallClockIteration = 0
    let previousLiveFrameSequence = adaptiveLive.frame.sequence
    while (Date.now() - wallClockStartedAt < wallClockDurationMs) {
      const cycleStartedAt = Date.now()
      const mutation = await call(a, `wall-clock-mutation-${wallClockIteration}`, 'browser_evaluate', {
        action: 'main_world',
        viewId: 'v1',
        expression: `(() => { let marker = document.querySelector('#l3-wall-clock-marker'); if (!marker) { marker = document.createElement('output'); marker.id = 'l3-wall-clock-marker'; marker.style.position = 'fixed'; marker.style.right = '4px'; marker.style.bottom = '4px'; marker.style.zIndex = '2147483647'; marker.style.background = '#fff'; marker.style.color = '#000'; marker.style.padding = '2px'; document.body.append(marker); } marker.textContent = ${JSON.stringify('wall-clock-') } + ${wallClockIteration}; return marker.textContent; })()`,
      })
      assert(mutation.isError === false, `wall-clock visible DOM mutation failed: ${JSON.stringify(mutation)}`)
      const snapshot = wallClockSkipSnapshot
        ? { isError: false, value: { data: { skipped: true } } }
        : await call(a, `wall-clock-snapshot-${wallClockIteration}`, 'browser_snapshot', { viewId: 'v1', maxNodes: 80 })
      const diagnoseStatus = await call(a, `wall-clock-diagnose-${wallClockIteration}`, 'browser_diagnose', { action: 'status' })
      const recorderStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
      const diagnosticPanel = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic' })
      let livePanel
      // 正式墙钟负载仍要求每次可见 DOM 变更都推动新的 Screencast 帧；这里只扩大异步帧调度的等待窗口，
      // 不接受旧帧、不跳过帧推进断言，也不改变 5 秒采样目标、完整 GC、Snapshot 或性能阈值。
      // Windows 首次启动时浏览器合成与 CDP Screencast 偶尔超过 2 秒，10 秒上限用于区分瞬时调度抖动与持续停帧。
      for (let attempt = 0; attempt < 200; attempt += 1) {
        livePanel = await rpc('snapshot', { sessionId: 'a', view: 'live' })
        if (livePanel.frame?.sequence > previousLiveFrameSequence) break
        await new Promise(resolveWait => setTimeout(resolveWait, 50))
      }
      assert(snapshot.isError === false, `wall-clock browser snapshot failed: ${JSON.stringify(snapshot)}`)
      assert(diagnoseStatus.isError === false, `wall-clock diagnose status failed: ${JSON.stringify(diagnoseStatus)}`)
      assert(recorderStatus.ok === true
        && recorderStatus.data.mode === wallClockRecorderMode
        && (wallClockRecorderMode === 'off' ? recorderStatus.data.status === 'idle' : recorderStatus.data.status === 'recording'),
      `wall-clock recorder status failed for ${wallClockRecorderMode}: ${JSON.stringify(recorderStatus)}`)
      assert(diagnosticPanel.diagnostic?.recorder.mode === wallClockRecorderMode, `wall-clock diagnostic panel lost the ${wallClockRecorderMode} recorder state`)
      assert(livePanel?.frame?.data.length > 0 && livePanel.frame.sequence > previousLiveFrameSequence, 'wall-clock Live View stopped advancing after a visible DOM mutation')
      if (wallClockForceGc) {
        assert(typeof global.gc === 'function', 'wall-clock retained heap measurement requires --expose-gc')
        // 正式内存斜率应比较完整GC后的存活对象；否则V8延迟回收会把分配速率误当成泄漏速率。
        global.gc()
      }
      wallClockSamples.push({
        atMs: Date.now() - wallClockStartedAt,
        iteration: wallClockIteration,
        cycleMs: Date.now() - cycleStartedAt,
        processHeapUsed: process.memoryUsage().heapUsed,
        processRss: process.memoryUsage().rss,
        recorderMode: recorderStatus.data.mode,
        recorderEventCount: recorderStatus.data.eventCount,
        recorderByteSize: recorderStatus.data.byteSize,
        recorderOldestEventAt: recorderStatus.data.oldestEventAt,
        recorderNewestEventAt: recorderStatus.data.newestEventAt,
        liveFrameSequence: livePanel.frame.sequence,
        liveStreamGeneration: livePanel.frame.streamGeneration,
        liveViewportGeneration: livePanel.frame.viewportGeneration,
      })
      previousLiveFrameSequence = livePanel.frame.sequence
      wallClockIteration += 1
      const remaining = wallClockSampleMs - (Date.now() - cycleStartedAt)
      if (remaining > 0) await new Promise(resolveWait => setTimeout(resolveWait, remaining))
    }
    const finalRecorderStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
    let recorderStopLatencyMs = null
    let recorderStopped = wallClockRecorderMode === 'off'
    if (wallClockRecorderMode === 'deep') {
      const stopStartedAt = Date.now()
      const stopped = await rpc('recorder', { sessionId: 'a', action: 'stop' })
      recorderStopLatencyMs = Date.now() - stopStartedAt
      recorderStopped = stopped.ok === true && stopped.data.mode === 'off' && stopped.data.status === 'idle'
    }
    const firstSample = wallClockSamples[0]
    const lastSample = wallClockSamples.at(-1)
    const wallClockResult = {
      ok: wallClockSamples.length >= Math.max(1, Math.floor(wallClockDurationMs / wallClockSampleMs) - 1)
        && finalRecorderStatus.ok === true
        && finalRecorderStatus.data.mode === wallClockRecorderMode
        && finalRecorderStatus.data.eventCount <= 12000
        && finalRecorderStatus.data.byteSize <= 16 * 1024 * 1024,
      recorderMode: wallClockRecorderMode,
      requestedDurationMs: wallClockDurationMs,
      durationMs: Date.now() - wallClockStartedAt,
      sampleIntervalMs: wallClockSampleMs,
      forceGc: wallClockForceGc,
      snapshotIncluded: !wallClockSkipSnapshot,
      samples: wallClockSamples.length,
      processHeapDeltaBytes: (lastSample?.processHeapUsed || 0) - (firstSample?.processHeapUsed || 0),
      recorder: finalRecorderStatus.data,
      recorderStopLatencyMs,
      recorderStopped,
      liveFrameAdvanced: (lastSample?.liveFrameSequence || 0) > (firstSample?.liveFrameSequence || 0),
    }
    assert(wallClockResult.ok, `wall-clock stability failed: ${JSON.stringify(wallClockResult)}`)
    result.stages.wallClockStability = wallClockResult
    if (typeof process.env.L3_WALL_CLOCK_SAMPLES_PATH === 'string' && process.env.L3_WALL_CLOCK_SAMPLES_PATH !== '') {
      writeFileSync(process.env.L3_WALL_CLOCK_SAMPLES_PATH, `${JSON.stringify(wallClockSamples, null, 2)}\n`, 'utf8')
    }
    // 正式性能进程只执行统一负载与墙钟采样；后续完整功能回归属于独立测试，继续运行会污染测量并让 Off/Deep 模式触发无关 Recorder 断言。
    result.ok = true
    throw new WallClockMeasurementComplete()
  }
  const takeoverInputFixture = await call(a, 'takeover-input-fixture-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `(() => {
    const input = document.querySelector('#text')
    const pasteTarget = document.querySelector('#paste-target')
    input.value = 'replace this text'
    const rect = input.getBoundingClientRect()
    const pasteRect = pasteTarget.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, pasteX: pasteRect.x, pasteY: pasteRect.y, pasteWidth: pasteRect.width, pasteHeight: pasteRect.height }
  })()` })
  assert(takeoverInputFixture.isError === false, 'takeover input fixture setup failed')
  const inputRect = takeoverInputFixture.value.data.value
  const takeover = await rpc('takeover', { sessionId: 'a', action: 'request', viewId: 'v1' })
  assert(takeover.ok === true && takeover.data.owner === 'user', 'panel takeover did not grant user ownership')
  const blockedByTakeover = await call(a, 'takeover-blocked-nav-a', 'browser_navigate', { url: origin, viewId: 'v1' })
  assert(blockedByTakeover.isError === false && blockedByTakeover.value.ok === false && blockedByTakeover.value.data.code === 'USER_TAKEOVER_ACTIVE', 'user takeover did not block model writes')
  const blockedLiveMode = await call(a, 'takeover-blocked-live-view-a', 'browser_live_view', { action: 'standard', viewId: 'v1' })
  assert(blockedLiveMode.isError === false && blockedLiveMode.value.ok === false && blockedLiveMode.value.data.code === 'USER_TAKEOVER_ACTIVE', 'user takeover did not block model live view mutation')
  const wrongViewInput = await rpc('input', { sessionId: 'a', action: 'key_press', ...liveIdentity, viewId: 'missing', key: 'Escape' })
  // 人工接管采用远程桌面语义：同View、同Stream和同Viewport内允许跨越普通Screencast帧，只有坐标系或可见目标变化才拒绝。
  const staleFrameKeyboardInput = await rpc('input', { sessionId: 'a', action: 'key_press', ...liveIdentity, frameSequence: liveIdentity.frameSequence - 1, key: 'Escape' })
  const staleFramePointerInput = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...liveIdentity, frameSequence: liveIdentity.frameSequence - 1, x: 1, y: 1 })
  const staleFramePointerDown = await rpc('input', { sessionId: 'a', action: 'mouse_down', ...liveIdentity, frameSequence: liveIdentity.frameSequence - 1, x: 1, y: 1 })
  const staleFramePointerUp = await rpc('input', { sessionId: 'a', action: 'mouse_up', ...liveIdentity, frameSequence: liveIdentity.frameSequence - 1, x: 1, y: 1 })
  const staleViewportInput = await rpc('input', { sessionId: 'a', action: 'key_press', ...liveIdentity, viewportGeneration: liveIdentity.viewportGeneration - 1, key: 'Escape' })
  let inputRangeLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    inputRangeLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (inputRangeLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const inputRangeIdentity = { viewId: inputRangeLive.activeViewId, streamGeneration: inputRangeLive.frame.streamGeneration, frameSequence: inputRangeLive.frame.sequence, viewportGeneration: inputRangeLive.frame.viewportGeneration }
  const outOfRangeInput = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...inputRangeIdentity, x: 900, y: 600 })
  const orphanPointerMove = await rpc('input', { sessionId: 'a', action: 'mouse_move', ...inputRangeIdentity, x: 1, y: 1 })
  const invalidModifier = await rpcRegistration.handler('input', { sessionId: 'a', action: 'key_press', ...inputRangeIdentity, key: 'a', modifiers: ['Hyper'] }, new AbortController().signal)
  assert(wrongViewInput.ok === false && wrongViewInput.data.code === 'STALE_LIVE_VIEW', 'input for a hidden view was not rejected')
  assert(staleFrameKeyboardInput.ok === true, 'keyboard input was incorrectly rejected only because a newer frame arrived in the same viewport')
  assert(staleFramePointerInput.ok === true, 'same-viewport coordinate input was incorrectly rejected only because a newer frame arrived')
  assert(staleFramePointerDown.ok === true && staleFramePointerUp.ok === true, 'same-viewport pointer gesture was interrupted only because a newer frame arrived')
  assert(staleViewportInput.ok === false && staleViewportInput.data.code === 'STALE_LIVE_VIEW', 'keyboard input from an old viewport was not rejected')
  assert(outOfRangeInput.ok === false && outOfRangeInput.data.code === 'INPUT_OUT_OF_RANGE', 'out of range live input was not rejected')
  assert(orphanPointerMove.ok === false && orphanPointerMove.data.code === 'POINTER_GESTURE_NOT_ACTIVE', 'pointer move without an active press was not rejected')
  assert(invalidModifier.ok === false && invalidModifier.error.message.includes('modifiers'), 'invalid keyboard modifier was not rejected at the RPC boundary')
  const inputX = inputRect.x + inputRect.width / 2
  const inputY = inputRect.y + inputRect.height / 2
  const focusDown = await rpc('input', { sessionId: 'a', action: 'mouse_down', ...inputRangeIdentity, x: inputX, y: inputY })
  const focusUp = await rpc('input', { sessionId: 'a', action: 'mouse_up', ...inputRangeIdentity, x: inputX, y: inputY })
  const selectAll = await rpc('input', { sessionId: 'a', action: 'key_press', ...inputRangeIdentity, key: 'a', modifiers: ['Control'] })
  const clientObservedTraceId = `client-a-${Date.now()}-composition`
  const clientObservedRawAt = Date.now()
  const compositionText = String.fromCodePoint(0x4E2D)
  const insertedText = await rpc('input', {
    sessionId: 'a',
    action: 'composition_commit',
    ...inputRangeIdentity,
    text: compositionText,
    composing: true,
    inputTraceId: clientObservedTraceId,
    clientRawAt: clientObservedRawAt,
    clientNormalizedAt: Date.now(),
  })
  const postCompositionLatin = await rpc('input', { sessionId: 'a', action: 'insert_text', ...inputRangeIdentity, text: String.fromCodePoint(65) })
  const postCompositionDigit = await rpc('input', { sessionId: 'a', action: 'insert_text', ...inputRangeIdentity, text: String.fromCodePoint(55) })
  const postCompositionSpace = await rpc('input', { sessionId: 'a', action: 'insert_text', ...inputRangeIdentity, text: String.fromCodePoint(32) })
  const selectAllBeforePaste = await rpc('input', { sessionId: 'a', action: 'key_press', ...inputRangeIdentity, key: 'a', modifiers: ['Control'] })
  const pastedText = await rpc('input', { sessionId: 'a', action: 'paste', ...inputRangeIdentity, text: 'clipboard-text' })
  const pasteTargetFocus = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...inputRangeIdentity, x: inputRect.pasteX + inputRect.pasteWidth / 2, y: inputRect.pasteY + inputRect.pasteHeight / 2 })
  const pastePayload = {
    action: 'paste',
    ...inputRangeIdentity,
    text: 'private-clipboard-text',
    html: '<b>clipboard-html</b>',
    uriList: 'https://example.com/',
    files: [{ name: 'clipboard.txt', mediaType: 'text/plain', data: Buffer.from('file-body').toString('base64') }],
  }
  const pastedRich = await rpc('input', { sessionId: 'a', ...pastePayload })
  const oversizedPaste = await rpcRegistration.handler('input', { sessionId: 'a', action: 'paste', ...inputRangeIdentity, files: [{ name: 'large.bin', mediaType: 'application/octet-stream', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }] }, new AbortController().signal)
  const restoreTextFocus = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...inputRangeIdentity, x: inputX, y: inputY })
  let dragLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    dragLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (dragLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const dragIdentity = { viewId: dragLive.activeViewId, streamGeneration: dragLive.frame.streamGeneration, frameSequence: dragLive.frame.sequence, viewportGeneration: dragLive.frame.viewportGeneration }
  const dragStartX = inputRect.x + inputRect.width - 8
  const dragEndX = inputRect.x + 8
  const dragDown = await rpc('input', { sessionId: 'a', action: 'mouse_down', ...dragIdentity, x: dragStartX, y: inputY })
  const dragMove = await rpc('input', { sessionId: 'a', action: 'mouse_move', ...dragIdentity, frameSequence: dragIdentity.frameSequence - 1, x: dragEndX, y: inputY })
  const dragUp = await rpc('input', { sessionId: 'a', action: 'mouse_up', ...dragIdentity, frameSequence: dragIdentity.frameSequence - 1, x: dragEndX, y: inputY })
  assert(restoreTextFocus.ok === true
    && [focusDown, focusUp, selectAll, insertedText, postCompositionLatin, postCompositionDigit, postCompositionSpace, dragDown, dragMove, dragUp].every(item => item.ok === true),
  'panel keyboard, Composition, or pointer gesture input failed during takeover')
  const returned = await rpc('takeover', { sessionId: 'a', action: 'return', viewId: 'v1' })
  assert(returned.ok === true && returned.data.owner === 'model', 'panel takeover did not return model ownership')
  const compositionObservation = insertedText.data.observation
  const compositionEventNames = compositionObservation.events.map(event => event.type)
  const compositionStartIndex = compositionEventNames.indexOf('compositionstart')
  const compositionUpdateIndex = compositionEventNames.indexOf('compositionupdate')
  const compositionEndIndex = compositionEventNames.indexOf('compositionend')
  assert(compositionStartIndex >= 0
    && compositionUpdateIndex > compositionStartIndex
    && compositionEndIndex > compositionUpdateIndex
    && compositionObservation.beforeInputObserved === true
    && compositionObservation.events.some(event => event.type === 'input')
    && compositionObservation.compositionStarted === true
    && compositionObservation.compositionUpdated === true
    && compositionObservation.compositionEnded === true
    && compositionObservation.composing === false
    && compositionObservation.targetReplaced === false
    && compositionObservation.focusLost === false
    && compositionObservation.initialLength > compositionObservation.finalLength
    && compositionObservation.finalLength === 1,
  `Chromium Composition lifecycle is invalid: ${JSON.stringify({
    events: compositionObservation.events,
    initialLength: compositionObservation.initialLength,
    finalLength: compositionObservation.finalLength,
    targetReplaced: compositionObservation.targetReplaced,
    focusLost: compositionObservation.focusLost,
  })}`)
  assert(postCompositionLatin.data.observation.initialLength === 1
    && postCompositionLatin.data.observation.finalLength === 2
    && postCompositionDigit.data.observation.initialLength === 2
    && postCompositionDigit.data.observation.finalLength === 3
    && postCompositionSpace.data.observation.initialLength === 3
    && postCompositionSpace.data.observation.finalLength === 4,
  `ordinary input did not recover after Composition: ${JSON.stringify({
    latin: postCompositionLatin.data.observation,
    digit: postCompositionDigit.data.observation,
    whitespace: postCompositionSpace.data.observation,
  })}`)
  const takeoverDiagnosticSnapshot = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic' })
  assert(takeoverDiagnosticSnapshot.diagnostic?.takeover?.active === false
    && takeoverDiagnosticSnapshot.diagnostic.takeover.latestSummary.actionCount >= 1
    && takeoverDiagnosticSnapshot.diagnostic.takeover.latestSummary.documentChanged === false
    && takeoverDiagnosticSnapshot.diagnostic.takeover.latestSummary.navigationChanged === false,
  `phase 2E takeover summary is incomplete: ${JSON.stringify(takeoverDiagnosticSnapshot.diagnostic?.takeover)}`)
  const takeoverInputState = await call(a, 'takeover-input-state-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `(() => { const input = document.querySelector('#text'); return { value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd } })()` })
  const pastedRichState = await call(a, 'pasted-rich-state-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `globalThis.__pasteFixture` })
  assert(selectAll.ok === true && insertedText.ok === true && selectAllBeforePaste.ok === true && pastedText.ok === true && takeoverInputState.value.data.value.value === 'clipboard-text', 'plain clipboard paste did not fall back to the focused input')
  assert(pasteTargetFocus.ok === true
    && pastedRich.ok === true
    && pastedRich.data.handled === true
    && pastedRich.data.files === 1
    && !JSON.stringify(pastedRich).includes('private-clipboard-text')
    && pastedRichState.value.data.value.text === 'private-clipboard-text'
    && pastedRichState.value.data.value.html === '<b>clipboard-html</b>'
    && pastedRichState.value.data.value.uriList === 'https://example.com/'
    && pastedRichState.value.data.value.files[0].name === 'clipboard.txt'
    && pastedRichState.value.data.value.files[0].size === 9,
  'rich clipboard paste did not dispatch a bounded remote PasteEvent')
  assert(oversizedPaste.ok === false && oversizedPaste.error.message.includes('clipboard paste exceeds'), 'oversized clipboard paste was not rejected')
  assert(takeoverInputState.isError === false && takeoverInputState.value.data.value.value === 'clipboard-text', `modified key chord, inserted text, and paste did not update the focused input: ${JSON.stringify(takeoverInputState)}`)
  assert(takeoverInputState.value.data.value.selectionEnd > takeoverInputState.value.data.value.selectionStart, `pointer drag did not create a text selection: ${JSON.stringify(takeoverInputState)}`)
  const injectedInputFailures = [
    { id: 'failure-client-normalization', stage: 'client-normalized', outcome: 'lost', reason: 'normalization-discarded', result: 'dropped-at-client-normalization' },
    { id: 'failure-rpc', stage: 'rpc-received', outcome: 'lost', reason: 'rpc-send-failed', result: 'dropped-at-rpc' },
    { id: 'failure-host-bridge', stage: 'host-dispatched', outcome: 'lost', reason: 'host-dispatch-failed', result: 'dropped-at-host-bridge' },
    { id: 'failure-before-dom', stage: 'dom-observed', outcome: 'lost', reason: 'no-dom-input-event-observed', result: 'dropped-before-dom-event' },
    { id: 'failure-after-beforeinput', stage: 'final-state', outcome: 'lost', reason: 'beforeinput-without-input', result: 'dropped-after-beforeinput' },
  ]
  for (const failure of injectedInputFailures) {
    const timestamp = Date.now()
    const injected = await rpc('input_trace', {
      sessionId: 'a',
      inputTraceId: failure.id,
      viewId: primaryViews.get('a'),
      action: 'insert-text',
      sensitivity: 'potentially-sensitive',
      composing: false,
      stage: failure.stage,
      timestamp,
      outcome: failure.outcome,
      reason: failure.reason,
      characters: { length: 1, asciiLetters: 1, digits: 0, whitespace: 0, punctuation: 0, cjk: 0, other: 0 },
    })
    assert(injected.ok === true && injected.data.recorded === true && injected.data.result === failure.result, `input failure classification failed: ${JSON.stringify(injected)}`)
  }
  const recorderTimeline = await call(a, 'recorder-timeline-a', 'browser_diagnose', { action: 'recorder_timeline', limit: 200 })
  const recorderSerialized = JSON.stringify(recorderTimeline.value?.data)
  const recorderInputTraces = recorderTimeline.value?.data?.inputTraces ?? []
  const observedSixStageTrace = recorderInputTraces.find(trace => trace.inputTraceId === clientObservedTraceId)
  const legacySixStageTrace = recorderInputTraces.find(trace => trace.inputTraceId.startsWith('host-legacy-') && ['insert-text', 'paste'].includes(trace.action) && trace.stages.length === 6)
  const injectedFailureTraces = injectedInputFailures.map(failure => recorderInputTraces.find(trace => trace.inputTraceId === failure.id && trace.result === failure.result))
  const compositionPlaintextAbsent = !JSON.stringify({
    inputResult: insertedText,
    recorder: recorderTimeline.value?.data,
    session: a.events,
  }).includes(compositionText)
  assert(recorderTimeline.isError === false
    && recorderTimeline.value.data.recorder.mode === 'rolling'
    && recorderTimeline.value.data.timeline.some(event => event.source === 'user' && event.inputTraceId !== undefined)
    && observedSixStageTrace !== undefined
    && observedSixStageTrace.action === 'composition'
    && observedSixStageTrace.result === 'delivered'
    && observedSixStageTrace.stages.map(stage => stage.stage).join(',') === 'client-raw,client-normalized,rpc-received,host-dispatched,dom-observed,final-state'
    && observedSixStageTrace.stages[0].outcome === 'observed'
    && observedSixStageTrace.stages[1].outcome === 'observed'
    && observedSixStageTrace.stages.every((stage, index, stages) => index === 0 || stage.timestamp >= stages[index - 1].timestamp)
    && observedSixStageTrace.characters?.length === 1
    && observedSixStageTrace.characters?.cjk === 1
    && legacySixStageTrace !== undefined
    && legacySixStageTrace.stages.map(stage => stage.stage).join(',') === 'client-raw,client-normalized,rpc-received,host-dispatched,dom-observed,final-state'
    && legacySixStageTrace.stages[0].outcome === 'unknown'
    && legacySixStageTrace.stages[1].outcome === 'unknown'
    && injectedFailureTraces.every(Boolean)
    && compositionPlaintextAbsent
    && !['clipboard-text', 'private-clipboard-text', 'clipboard-html', 'https://example.com/', 'file-body'].some(secret => recorderSerialized.includes(secret)),
  `flight recorder input trace or plaintext boundary is invalid: ${JSON.stringify({
    trace: observedSixStageTrace === undefined ? null : {
      action: observedSixStageTrace.action,
      result: observedSixStageTrace.result,
      stages: observedSixStageTrace.stages,
      characters: observedSixStageTrace.characters,
    },
    compositionPlaintextAbsent,
    legacyTracePresent: legacySixStageTrace !== undefined,
    failureTracesPresent: injectedFailureTraces.every(Boolean),
  })}`)
  const recordedIncident = await rpc('recorder', { sessionId: 'a', action: 'mark' })
  const completedRecordedIncident = await rpc('recorder', { sessionId: 'a', action: 'complete', incidentId: recordedIncident.data.incident.incidentId })
  const recorderDeep = await rpc('recorder', { sessionId: 'a', action: 'start', mode: 'deep' })
  await rpc('close', { sessionId: 'a', view: 'live' })
  const recorderDeepPanel = await rpc('snapshot', { sessionId: 'a', view: 'diagnostic' })
  const recorderDeepOnlyStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  let recorderLiveAndDeepPanel
  for (let attempt = 0; attempt < 30; attempt += 1) {
    recorderLiveAndDeepPanel = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (recorderLiveAndDeepPanel.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const deepSensitiveCanary = 'L3-DEEP-PASSWORD-Canary-4a6f'
  const deepTraceId = `client-a-${Date.now()}-deep-sensitive`
  const deepIdentity = {
    viewId: recorderLiveAndDeepPanel.activeViewId,
    streamGeneration: recorderLiveAndDeepPanel.frame.streamGeneration,
    frameSequence: recorderLiveAndDeepPanel.frame.sequence,
    viewportGeneration: recorderLiveAndDeepPanel.frame.viewportGeneration,
  }
  const deepPasswordGeometry = await call(a, 'deep-password-geometry-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: deepIdentity.viewId,
    expression: `(() => { const rect = document.getElementById('privacy-password').getBoundingClientRect(); return [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }] })()`,
  })
  const deepPasswordRect = deepPasswordGeometry.value?.data?.value?.[0]
  assert(deepPasswordGeometry.isError === false
    && deepPasswordRect !== undefined
    && [deepPasswordRect.x, deepPasswordRect.y, deepPasswordRect.width, deepPasswordRect.height].every(Number.isFinite),
  `Deep password geometry is unavailable: ${JSON.stringify(deepPasswordGeometry)}`)
  const deepTakeover = await rpc('takeover', { sessionId: 'a', action: 'request', viewId: deepIdentity.viewId })
  const deepFocus = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...deepIdentity, x: deepPasswordRect.x + deepPasswordRect.width / 2, y: deepPasswordRect.y + deepPasswordRect.height / 2 })
  const deepRawAt = Date.now()
  const deepInput = await rpc('input', {
    sessionId: 'a',
    action: 'insert_text',
    ...deepIdentity,
    text: deepSensitiveCanary,
    inputTraceId: deepTraceId,
    clientRawAt: deepRawAt,
    clientNormalizedAt: Date.now(),
  })
  const deepReturned = await rpc('takeover', { sessionId: 'a', action: 'return', viewId: deepIdentity.viewId })
  const deepTimeline = await call(a, 'recorder-deep-privacy-a', 'browser_diagnose', { action: 'recorder_timeline', limit: 200 })
  const deepIncidentReport = await call(a, 'recorder-deep-incident-a', 'browser_diagnose', { action: 'report' })
  const deepTrace = deepTimeline.value?.data?.inputTraces?.find(trace => trace.inputTraceId === deepTraceId)
  const deepPrivacySerialized = JSON.stringify({ timeline: deepTimeline.value?.data, incident: deepIncidentReport.value?.data, session: a.events })
  const deepPrivacyCleared = await call(a, 'privacy-deep-clear-a', 'browser_evaluate', {
    action: 'main_world',
    viewId: deepIdentity.viewId,
    expression: `(() => { document.getElementById('privacy-password').value = ''; return true })()`,
  })
  assert(deepTakeover.ok === true
    && deepFocus.ok === true
    && deepInput.ok === true
    && deepReturned.ok === true
    && deepTimeline.isError === false
    && deepIncidentReport.isError === false
    && deepTrace?.sensitivity === 'sensitive'
    && deepTrace.characters?.length === [...deepSensitiveCanary].length
    && deepTrace.stages[0].outcome === 'observed'
    && deepTrace.stages[1].outcome === 'observed'
    && !deepPrivacySerialized.includes(deepSensitiveCanary)
    && deepPrivacyCleared.isError === false,
  `Deep privacy trace failed: ${JSON.stringify({ takeover: deepTakeover.ok, focus: deepFocus.ok, input: deepInput.ok, returned: deepReturned.ok, timelineError: deepTimeline.isError, incidentError: deepIncidentReport.isError, sensitivity: deepTrace?.sensitivity, characters: deepTrace?.characters, stages: deepTrace?.stages.map(stage => ({ stage: stage.stage, outcome: stage.outcome })), plaintextAbsent: !deepPrivacySerialized.includes(deepSensitiveCanary), cleared: deepPrivacyCleared.isError === false })}`)
  const recorderLiveAndDeepStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  await rpc('close', { sessionId: 'a', view: 'live' })
  const recorderAfterLiveCloseStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  const recorderPaused = await rpc('recorder', { sessionId: 'a', action: 'pause' })
  const recorderPausedStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  const recorderResumed = await rpc('recorder', { sessionId: 'a', action: 'resume' })
  const recorderResumedStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  const recorderCleared = await rpc('recorder', { sessionId: 'a', action: 'clear' })
  let recorderLiveBeforeStop
  for (let attempt = 0; attempt < 30; attempt += 1) {
    recorderLiveBeforeStop = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (recorderLiveBeforeStop.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const recorderStopped = await rpc('recorder', { sessionId: 'a', action: 'stop' })
  const recorderStoppedWithLiveStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  await rpc('close', { sessionId: 'a', view: 'live' })
  const recorderFullyReleasedStatus = await rpc('recorder', { sessionId: 'a', action: 'status' })
  const otherSessionRecorder = await rpc('recorder', { sessionId: 'b', action: 'status' })
  assert(recordedIncident.ok === true
    && recordedIncident.data.incident.chunkIds.length > 0
    && completedRecordedIncident.data.incident.status === 'complete'
    && recorderDeep.data.mode === 'deep'
    && recorderDeepPanel.diagnostic?.recorder.deepVisible === true
    && recorderDeepOnlyStatus.data.visualCapture.startedViewCount === 1
    && recorderDeepOnlyStatus.data.visualCapture.liveViewConsumerCount === 0
    && recorderDeepOnlyStatus.data.visualCapture.recorderConsumerCount === 1
    && recorderLiveAndDeepPanel.frame?.data.length > 0
    && recorderLiveAndDeepStatus.data.visualCapture.startedViewCount === 1
    && recorderLiveAndDeepStatus.data.visualCapture.liveViewConsumerCount === 1
    && recorderLiveAndDeepStatus.data.visualCapture.recorderConsumerCount === 1
    && recorderAfterLiveCloseStatus.data.visualCapture.startedViewCount === 1
    && recorderAfterLiveCloseStatus.data.visualCapture.liveViewConsumerCount === 0
    && recorderAfterLiveCloseStatus.data.visualCapture.recorderConsumerCount === 1
    && recorderPaused.data.status === 'paused'
    && recorderPausedStatus.data.visualCapture.startedViewCount === 0
    && recorderPausedStatus.data.visualCapture.liveViewConsumerCount === 0
    && recorderPausedStatus.data.visualCapture.recorderConsumerCount === 0
    && recorderResumed.data.status === 'recording'
    && recorderResumedStatus.data.visualCapture.startedViewCount === 1
    && recorderResumedStatus.data.visualCapture.recorderConsumerCount === 1
    && recorderCleared.data.frozenIncidentIds.includes(recordedIncident.data.incident.incidentId)
    && recorderCleared.data.eventCount > 0
    && recorderLiveBeforeStop.frame?.data.length > 0
    && recorderStopped.data.mode === 'off'
    && recorderStopped.data.status === 'idle'
    && recorderStoppedWithLiveStatus.data.visualCapture.startedViewCount === 1
    && recorderStoppedWithLiveStatus.data.visualCapture.liveViewConsumerCount === 1
    && recorderStoppedWithLiveStatus.data.visualCapture.recorderConsumerCount === 0
    && recorderFullyReleasedStatus.data.visualCapture.startedViewCount === 0
    && recorderFullyReleasedStatus.data.visualCapture.liveViewConsumerCount === 0
    && recorderFullyReleasedStatus.data.visualCapture.recorderConsumerCount === 0
    && otherSessionRecorder.data.mode === 'off'
    && otherSessionRecorder.data.eventCount === 0,
  `flight recorder mode, visual ownership, incident freeze, clear, or Session isolation failed: ${JSON.stringify({ recordedIncident, completedRecordedIncident, recorderDeep, deepPanel: recorderDeepPanel.diagnostic?.recorder, recorderDeepOnlyStatus, recorderLiveAndDeepStatus, recorderAfterLiveCloseStatus, recorderPaused, recorderPausedStatus, recorderResumed, recorderResumedStatus, recorderCleared, recorderStopped, recorderStoppedWithLiveStatus, recorderFullyReleasedStatus, otherSessionRecorder })}`)
  const afterTakeover = await call(a, 'takeover-restored-nav-a', 'browser_navigate', { url: origin, viewId: 'v1' })
  assert(afterTakeover.isError === false && afterTakeover.value.ok === true, 'model writes did not recover after takeover return')
  const takeoverAfterNavigation = await rpc('takeover', { sessionId: 'a', action: 'request', viewId: 'v1' })
  const staleAfterNavigation = await rpc('input', { sessionId: 'a', action: 'key_press', ...liveIdentity, key: 'Escape' })
  assert(takeoverAfterNavigation.ok === true && staleAfterNavigation.ok === false && staleAfterNavigation.data.code === 'STALE_LIVE_VIEW', 'navigation did not invalidate the previous live frame identity')
  await rpc('takeover', { sessionId: 'a', action: 'return', viewId: 'v1' })
  const standardLiveMode = await call(a, 'live-view-standard-a', 'browser_live_view', { action: 'standard', viewId: 'v1' })
  assert(standardLiveMode.isError === false && standardLiveMode.value.data.mode === 'standard' && standardLiveMode.value.data.width === 1280 && standardLiveMode.value.data.height === 720, 'model standard live view switch failed')
  const adaptiveLiveMode = await call(a, 'live-view-adaptive-a', 'browser_live_view', { action: 'adaptive', viewId: 'v1' })
  assert(adaptiveLiveMode.isError === false && adaptiveLiveMode.value.data.mode === 'adaptive' && adaptiveLiveMode.value.data.width === 900 && adaptiveLiveMode.value.data.height === 600, 'model adaptive live view switch failed')
  const liveViewStatus = await call(a, 'live-view-status-a', 'browser_live_view', { action: 'status', viewId: 'v1' })
  assert(liveViewStatus.isError === false && liveViewStatus.value.data.mode === 'adaptive', 'browser_live_view status failed')
  const adaptiveOverflowNav = await call(a, 'adaptive-overflow-nav-a', 'browser_navigate', { url: `${origin}/adaptive-overflow`, viewId: 'v1' })
  const adaptiveOverflowMode = await rpc('live_view', { sessionId: 'a', action: 'adaptive', viewId: 'v1', width: 615, height: 778 })
  let adaptiveOverflowLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    adaptiveOverflowLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (adaptiveOverflowLive.frame?.viewportGeneration === adaptiveOverflowMode.data.viewportGeneration) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const adaptiveOverflowState = await call(a, 'adaptive-overflow-state-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `({ innerWidth: window.innerWidth, rootScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, mode: getComputedStyle(document.querySelector('#mode'), '::after').content, zoom: getComputedStyle(document.documentElement).zoom, input: document.querySelector('#adaptive-input').getBoundingClientRect().toJSON(), target: document.querySelector('#adaptive-target').getBoundingClientRect().toJSON() })` })
  assert(
    adaptiveOverflowNav.isError === false
      && adaptiveOverflowMode.ok === true
      && adaptiveOverflowLive?.liveView?.reflowed === true
      && adaptiveOverflowLive.liveView.fittedWidth === 615,
    `adaptive overflow fitting did not activate: ${JSON.stringify({ adaptiveOverflowNav, adaptiveOverflowMode, adaptiveOverflowLive: adaptiveOverflowLive === undefined ? undefined : { liveView: adaptiveOverflowLive.liveView, frame: adaptiveOverflowLive.frame === undefined ? undefined : { width: adaptiveOverflowLive.frame.width, height: adaptiveOverflowLive.frame.height, viewportGeneration: adaptiveOverflowLive.frame.viewportGeneration } } })}`,
  )
  assert(adaptiveOverflowState.isError === false && adaptiveOverflowState.value.data.value.innerWidth === 615 && adaptiveOverflowState.value.data.value.rootScrollWidth === 615 && adaptiveOverflowState.value.data.value.bodyScrollWidth === 615 && adaptiveOverflowState.value.data.value.mode === '"narrow"' && adaptiveOverflowState.value.data.value.zoom === '1' && adaptiveOverflowState.value.data.value.input.height === 45, `adaptive overflow reflow did not preserve natural narrow layout: ${JSON.stringify(adaptiveOverflowState)}`)
  let stableOverflowLive
  let stableOverflowGeneration = -1
  let stableOverflowMatches = 0
  const stableOverflowObservations = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const next = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    const generation = next.frame?.viewportGeneration
    stableOverflowObservations.push({ generation, liveGeneration: next.liveView?.viewportGeneration, hasFrame: next.frame !== undefined })
    if (generation !== undefined && generation === next.liveView?.viewportGeneration) {
      stableOverflowMatches = generation === stableOverflowGeneration ? stableOverflowMatches + 1 : 1
      stableOverflowGeneration = generation
      stableOverflowLive = next
      if (stableOverflowMatches >= 2) break
    } else {
      stableOverflowMatches = 0
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(stableOverflowLive?.frame !== undefined && stableOverflowMatches >= 2, `adaptive overflow live frame did not stabilize after forced reflow: ${JSON.stringify(stableOverflowObservations)}`)
  const overflowIdentity = { viewId: stableOverflowLive.activeViewId, streamGeneration: stableOverflowLive.frame.streamGeneration, frameSequence: stableOverflowLive.frame.sequence, viewportGeneration: stableOverflowLive.frame.viewportGeneration }
  await rpc('takeover', { sessionId: 'a', action: 'request', viewId: 'v1' })
  const overflowTarget = adaptiveOverflowState.value.data.value.target
  const overflowClick = await rpc('input', { sessionId: 'a', action: 'mouse_click', ...overflowIdentity, x: overflowTarget.x + overflowTarget.width / 2, y: overflowTarget.y + overflowTarget.height / 2 })
  await rpc('takeover', { sessionId: 'a', action: 'return', viewId: 'v1' })
  const overflowClicked = await call(a, 'adaptive-overflow-clicked-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: 'window.adaptiveClicked' })
  assert(
    overflowClick.ok === true
      && overflowClicked.isError === false
      && overflowClicked.value.data.value === 1,
    `adaptive fitted live input did not hit the visible target: ${JSON.stringify({ overflowIdentity, overflowTarget, overflowClick, overflowClicked })}`,
  )
  const overflowStandard = await call(a, 'adaptive-overflow-standard-a', 'browser_live_view', { action: 'standard', viewId: 'v1' })
  const overflowResetState = await call(a, 'adaptive-overflow-reset-state-a', 'browser_evaluate', { action: 'main_world', viewId: 'v1', expression: `({ style: document.querySelector('style[data-dsh-browser-tools-adaptive-reflow]') !== null, elements: document.querySelectorAll('[data-dsh-browser-tools-adaptive-reflow]').length, zoom: getComputedStyle(document.documentElement).zoom })` })
  assert(overflowStandard.isError === false && overflowResetState.isError === false && overflowResetState.value.data.value.style === false && overflowResetState.value.data.value.elements === 0 && overflowResetState.value.data.value.zoom === '1', 'standard mode did not remove adaptive forced reflow')
  await call(a, 'adaptive-overflow-restore-a', 'browser_navigate', { url: origin, viewId: 'v1' })
  await rpc('live_view', { sessionId: 'a', action: 'adaptive', viewId: 'v1', width: 900, height: 600 })
  const subagentLiveViewStatus = await call(b, 'live-view-status-b', 'browser_live_view', { action: 'status', viewId: 'v1' })
  const subagentLiveViewDenied = await call(b, 'live-view-standard-b', 'browser_live_view', { action: 'standard', viewId: 'v1' })
  assert(subagentLiveViewStatus.isError === false && subagentLiveViewDenied.isError === true, 'subagent live view boundary failed')

  const providerList = await call(a, 'provider-list-a', 'browser_provider', { action: 'list' })
  assert(providerList.isError === false && providerList.value.data.active === 'managed-persistent' && providerList.value.data.persistentProfile === 'default' && providerList.value.data.providers.length === 3, `browser_provider default persistent state failed: ${JSON.stringify(providerList)}`)
  const subagentProviderDenied = await call(b, 'provider-connect-b', 'browser_provider', { action: 'connect', provider: 'managed-persistent', profileName: 'subagent-denied' })
  assert(subagentProviderDenied.isError === true, 'subagent provider mutation was not denied')
  const viewport = await call(a, 'emulate-viewport-a', 'browser_emulate', { action: 'viewport', viewId: 'v1', width: 1024, height: 640 })
  const fixedAfterEmulate = await rpc('snapshot', { sessionId: 'a', view: 'live' })
  assert(viewport.isError === false && fixedAfterEmulate.liveView.mode === 'standard' && fixedAfterEmulate.liveView.width === 1024 && fixedAfterEmulate.liveView.height === 640, 'explicit viewport emulation was overwritten by live view polling')
  const standardAfterEmulate = await call(a, 'live-view-standard-after-emulate-a', 'browser_live_view', { action: 'standard', viewId: 'v1' })
  assert(standardAfterEmulate.isError === false && standardAfterEmulate.value.data.width === 1280 && standardAfterEmulate.value.data.height === 720, 'standard live view did not restore 1280x720 after explicit emulation')
  const localeResult = await call(a, 'emulate-locale-a', 'browser_emulate', { action: 'locale', viewId: 'v1', locale: 'zh-CN' })
  const timezoneResult = await call(a, 'emulate-timezone-a', 'browser_emulate', { action: 'timezone', viewId: 'v1', timezoneId: 'Asia/Shanghai' })
  const offlineResult = await call(a, 'emulate-offline-a', 'browser_emulate', { action: 'offline', viewId: 'v1', offline: true })
  const resetEmulation = await call(a, 'emulate-reset-a', 'browser_emulate', { action: 'reset', viewId: 'v1' })
  assert([viewport, localeResult, timezoneResult, offlineResult, resetEmulation].every(item => item.isError === false), 'browser_emulate lifecycle failed')
  const subagentEmulateDenied = await call(b, 'emulate-b', 'browser_emulate', { action: 'viewport', viewId: 'v1', width: 800, height: 600 })
  assert(subagentEmulateDenied.isError === true, 'subagent emulation was not denied')

  const traceStart = await call(a, 'trace-start-a', 'browser_profile', { action: 'trace_start', viewId: 'v1' })
  assert(traceStart.isError === false, 'trace_start failed')
  await call(a, 'trace-work-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: 'Array.from({ length: 1000 }, (_, index) => index * index).reduce((sum, value) => sum + value, 0)' })
  const traceStop = await call(a, 'trace-stop-a', 'browser_profile', { action: 'trace_stop', viewId: 'v1' })
  assert(traceStop.isError === false && traceStop.value.data.artifact.bytes > 0, `trace_stop did not produce an artifact: ${JSON.stringify(traceStop)}`)
  const sharedPlaywrightTraceDenied = await call(a, 'playwright-trace-shared-denied-a', 'browser_profile', { action: 'playwright_trace_start', viewId: 'v1' })
  assert(sharedPlaywrightTraceDenied.isError === true && sharedPlaywrightTraceDenied.error.info?.code === 'PROFILE_REQUIRES_ISOLATED_CONTEXT', 'shared provider allowed a context-wide Playwright trace to capture other sessions')
  const cpuStart = await call(a, 'cpu-start-a', 'browser_profile', { action: 'cpu_start', viewId: 'v1' })
  assert(cpuStart.isError === false, 'cpu_start failed')
  await call(a, 'cpu-work-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: 'for (let i = 0; i < 50000; i += 1) Math.sqrt(i)' })
  const cpuStop = await call(a, 'cpu-stop-a', 'browser_profile', { action: 'cpu_stop', viewId: 'v1' })
  assert(cpuStop.isError === false && cpuStop.value.data.artifact.bytes > 0, 'cpu_stop did not produce an artifact')
  const coverageStart = await call(a, 'coverage-start-a', 'browser_profile', { action: 'coverage_start', viewId: 'v1' })
  assert(coverageStart.isError === false, 'coverage_start failed')
  await call(a, 'coverage-work-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: 'document.querySelector("#result").textContent' })
  const coverageStop = await call(a, 'coverage-stop-a', 'browser_profile', { action: 'coverage_stop', viewId: 'v1' })
  assert(coverageStop.isError === false && coverageStop.value.data.artifact.bytes > 0, 'coverage_stop did not produce an artifact')
  const heapSamplingStart = await call(a, 'heap-sampling-start-a', 'browser_profile', { action: 'heap_sampling_start', viewId: 'v1' })
  assert(heapSamplingStart.isError === false, 'heap_sampling_start failed')
  await call(a, 'heap-sampling-work-a', 'browser_evaluate', { action: 'isolated', viewId: 'v1', expression: 'globalThis.__heapFixture = Array.from({ length: 2000 }, (_, index) => ({ index, text: String(index) }))' })
  const heapSamplingStop = await call(a, 'heap-sampling-stop-a', 'browser_profile', { action: 'heap_sampling_stop', viewId: 'v1' })
  assert(heapSamplingStop.isError === false && heapSamplingStop.value.data.artifact.bytes > 0, 'heap_sampling_stop did not produce an artifact')
  const heapSnapshot = await call(a, 'heap-snapshot-a', 'browser_profile', { action: 'heap_snapshot', viewId: 'v1' })
  assert(heapSnapshot.isError === false && heapSnapshot.value.data.artifact.bytes > 0, `heap_snapshot did not produce an artifact: ${JSON.stringify(heapSnapshot)}`)
  const artifacts = await call(a, 'artifacts-a', 'browser_profile', { action: 'artifacts' })
  const profileArtifactKinds = new Set(artifacts.value.data.artifacts.map(item => item.kind))
  assert(artifacts.isError === false
    && ['trace', 'cpu-profile', 'coverage', 'heap-sampling', 'heap-snapshot'].every(kind => profileArtifactKinds.has(kind)),
  'profile artifacts were not listed')
  const readableArtifact = artifacts.value.data.artifacts.find(item => item.bytes <= 12000)
  assert(readableArtifact !== undefined, 'no bounded profile artifact was available for read testing')
  const artifactRead = await call(a, 'artifact-read-a', 'browser_profile', { action: 'artifact_read', artifactId: readableArtifact.artifactId, maxReadBytes: 12000 })
  assert(artifactRead.isError === false && artifactRead.value.data.encoding === 'base64' && artifactRead.value.data.data.length > 0, 'bounded artifact_read failed')
  const crossSessionArtifact = await call(c, 'artifact-read-c', 'browser_profile', { action: 'artifact_read', artifactId: readableArtifact.artifactId, maxReadBytes: 12000 })
  assert(crossSessionArtifact.isError === true, 'artifact_read crossed DSH session boundaries')
  const subagentProfileDenied = await call(b, 'profile-start-b', 'browser_profile', { action: 'cpu_start', viewId: 'v1' })
  assert(subagentProfileDenied.isError === true, 'subagent profile mutation was not denied')
  let beforeDetachLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    beforeDetachLive = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (beforeDetachLive.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const debuggerDetach = await call(a, 'debugger-detach-a', 'browser_debugger', { action: 'detach', viewId: 'v1' })
  assert(debuggerDetach.isError === false && debuggerDetach.value.data.attached === false, 'browser_debugger detach failed')
  let afterDetachLive
  for (let attempt = 0; attempt < 30; attempt += 1) {
    afterDetachLive = await rpc('snapshot', { sessionId: 'a', view: 'live', streamGeneration: beforeDetachLive.frame.streamGeneration, sequence: beforeDetachLive.frame.sequence })
    if (afterDetachLive.frame !== undefined && afterDetachLive.frame.streamGeneration !== beforeDetachLive.frame.streamGeneration) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(afterDetachLive?.frame?.streamGeneration !== beforeDetachLive?.frame?.streamGeneration, 'CDP rebuild did not expose a new screencast stream generation')

  const temporaryManaged = await call(a, 'provider-managed-a', 'browser_provider', { action: 'connect', provider: 'managed' })
  assert(temporaryManaged.isError === false && temporaryManaged.value.data.active === 'managed', 'explicit temporary managed provider failed')
  const staleDiagnoseAfterProviderSwitch = await call(a, 'diagnostic-stale-provider-a', 'browser_diagnose', { action: 'report' })
  assert(staleDiagnoseAfterProviderSwitch.isError === true, 'provider switch preserved a stale browser diagnose session')
  const persistent = await call(a, 'provider-persistent-a', 'browser_provider', { action: 'connect', provider: 'managed-persistent', profileName: 'test-profile' })
  assert(persistent.isError === false && persistent.value.data.active === 'managed-persistent' && persistent.value.data.persistentProfile === 'test-profile', `managed persistent provider failed: ${JSON.stringify(persistent)}`)
  const persistentNav = await call(a, 'provider-persistent-nav-a', 'browser_navigate', { url: origin })
  assert(persistentNav.isError === false && persistentNav.value.data.title === 'Browser Tools Fixture', 'persistent provider navigation failed')
  const diagnosticRestart = await call(a, 'diagnostic-restart-a', 'browser_diagnose', { action: 'start', viewId: persistentNav.value.viewId })
  const diagnosticRestartSnapshot = await call(a, 'diagnostic-restart-snapshot-a', 'browser_snapshot', { viewId: persistentNav.value.viewId, includeDiff: false })
  const diagnosticRestartRef = /^(e\d+).*Trigger diagnostic error/m.exec(diagnosticRestartSnapshot.value.data.snapshot)?.[1]
  assert(typeof diagnosticRestartRef === 'string', 'diagnostic restart trigger ref missing')
  const diagnosticOldBuildTrigger = await call(a, 'diagnostic-old-build-trigger-a', 'browser_click', { ref: diagnosticRestartRef, viewId: persistentNav.value.viewId })
  assert(diagnosticOldBuildTrigger.isError === false, 'diagnostic old build trigger failed')
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
  const diagnosticNavigation = await call(a, 'diagnostic-navigation-a', 'browser_navigate', { url: `${origin}/?phase2-navigation=1`, viewId: persistentNav.value.viewId })
  const diagnosticNavigationReport = await call(a, 'diagnostic-navigation-report-a', 'browser_diagnose', { action: 'report' })
  assert(diagnosticNavigationReport.isError === false, `browser diagnose navigation report failed: ${JSON.stringify(diagnosticNavigationReport)}`)
  const diagnosticNavigationTimeline = diagnosticNavigationReport.value.data.actionTimeline.find(item => item.callId === 'diagnostic-navigation-a')
  assert(diagnosticNavigation.isError === false
    && diagnosticNavigationTimeline !== undefined
    && diagnosticNavigationTimeline.identity.navigationBefore !== diagnosticNavigationTimeline.identity.navigationAfter
    && diagnosticNavigationTimeline.identity.documentBefore !== diagnosticNavigationTimeline.identity.documentAfter
    && diagnosticNavigationTimeline.evidence.confirmed.length === 0
    && diagnosticNavigationTimeline.evidence.strongCandidates.some(event => event.kind === 'network'
      && event.resourceType === 'document'
      && event.url.includes('phase2-navigation=1'))
    && diagnosticNavigationReport.value.data.sourceMaps.length >= 1
    && diagnosticNavigationReport.value.data.sourceMaps.every(mapping => mapping.confidence === 'unavailable'
      && mapping.reason.includes('different document or navigation')),
  `browser diagnose navigation boundary failed: ${JSON.stringify(diagnosticNavigationReport.value)}`)
  const pageCheckpointBefore = await call(a, 'diagnostic-page-checkpoint-before-a', 'browser_diagnose', { action: 'checkpoint', label: 'page-before' })
  const pageCheckpointAfter = await call(a, 'diagnostic-page-checkpoint-after-a', 'browser_diagnose', { action: 'checkpoint', label: 'page-after' })
  const pageCheckpointCompare = await call(a, 'diagnostic-page-compare-a', 'browser_diagnose', {
    action: 'compare',
    beforeCheckpointId: pageCheckpointBefore.value?.data?.checkpoint?.checkpointId,
    afterCheckpointId: pageCheckpointAfter.value?.data?.checkpoint?.checkpointId,
  })
  assert(pageCheckpointBefore.isError === false
    && pageCheckpointAfter.isError === false
    && pageCheckpointCompare.isError === false
    && !Object.hasOwn(pageCheckpointCompare.value.data.element, 'before')
    && !Object.hasOwn(pageCheckpointCompare.value.data.element, 'after')
    && pageCheckpointCompare.value.data.verdicts.element === 'evidence-insufficient'
    && JSON.parse(JSON.stringify(pageCheckpointCompare.value.data)).schemaVersion === 2,
  `browser_diagnose page checkpoint compare is not lossless JSON: ${JSON.stringify({
    beforeError: pageCheckpointBefore.isError,
    afterError: pageCheckpointAfter.isError,
    compareError: pageCheckpointCompare.isError,
    element: pageCheckpointCompare.value?.data?.element,
    verdict: pageCheckpointCompare.value?.data?.verdicts?.element,
  })}`)
  const diagnosticStop = await call(a, 'diagnostic-stop-a', 'browser_diagnose', { action: 'stop' })
  const diagnosticStopRepeated = await call(a, 'diagnostic-stop-repeated-a', 'browser_diagnose', { action: 'stop' })
  const diagnosticRestartAfterStop = await call(a, 'diagnostic-restart-after-stop-a', 'browser_diagnose', { action: 'start', viewId: persistentNav.value.viewId })
  const diagnosticRestartAfterStopStatus = await call(a, 'diagnostic-restart-after-stop-status-a', 'browser_diagnose', { action: 'status' })
  const diagnosticFinalStop = await call(a, 'diagnostic-final-stop-a', 'browser_diagnose', { action: 'stop' })
  assert(diagnosticRestart.isError === false
    && diagnosticStop.isError === false
    && diagnosticStop.value.data.stopped === true
    && diagnosticStop.value.data.cleanup.status === 'clean'
    && diagnosticStop.value.data.cleanup.journal === 'retained-by-browser-session'
    && diagnosticStopRepeated.isError === false
    && diagnosticStopRepeated.value.data.stopped === false
    && diagnosticRestartAfterStop.isError === false
    && diagnosticRestartAfterStopStatus.isError === false
    && diagnosticRestartAfterStopStatus.value.data.contextTopology.frames.some(frame => frame.mainFrame)
    && diagnosticFinalStop.isError === false
    && diagnosticFinalStop.value.data.stopped === true,
  'browser diagnose restart or idempotent stop failed after provider switch')
  const isolatedProviderViewId = persistentNav.value.viewId
  const playwrightTraceStart = await call(a, 'playwright-trace-start-a', 'browser_profile', { action: 'playwright_trace_start' })
  assert(playwrightTraceStart.isError === false, 'isolated playwright_trace_start failed')
  await call(a, 'playwright-trace-work-a', 'browser_navigate', { url: origin })
  const playwrightTraceStop = await call(a, 'playwright-trace-stop-a', 'browser_profile', { action: 'playwright_trace_stop' })
  assert(playwrightTraceStop.isError === false && playwrightTraceStop.value.data.artifact.bytes > 0, 'isolated playwright_trace_stop did not produce a ZIP artifact')
  const artifactsAfterPlaywrightTrace = await call(a, 'artifacts-after-playwright-trace-a', 'browser_profile', { action: 'artifacts' })
  assert(artifactsAfterPlaywrightTrace.isError === false && artifactsAfterPlaywrightTrace.value.data.artifacts.some(item => item.kind === 'playwright-trace'), 'isolated Playwright trace artifact was not listed')
  const providerDisconnect = await call(a, 'provider-disconnect-a', 'browser_provider', { action: 'disconnect' })
  assert(providerDisconnect.isError === false && providerDisconnect.value.data.active === 'managed-persistent' && providerDisconnect.value.data.persistentProfile === 'default', 'provider disconnect did not restore default persistent provider')
  const oldViewAfterProviderSwitch = await tools.execute({ agent: a, callId: llm.ToolCallId('provider-old-view-a'), name: 'browser_snapshot', arguments: { viewId: isolatedProviderViewId }, signal: new AbortController().signal })
  assert(oldViewAfterProviderSwitch.isError === true, 'provider switch did not invalidate the previous provider view')
  const restoredNav = await call(a, 'provider-restored-nav-a', 'browser_navigate', { url: origin })
  assert(restoredNav.isError === false, 'default persistent provider did not recover after provider disconnect')
  const externalExecutable = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(existsSync)
  assert(externalExecutable !== undefined, 'no Chromium executable was available for external CDP integration testing')
  const externalPort = await freePort()
  externalCdpPort = externalPort
  const externalProfile = join(runtime, 'external-cdp-profile')
  mkdirSync(externalProfile, { recursive: true })
  externalBrowser = spawn(externalExecutable, [
    `--remote-debugging-port=${externalPort}`,
    `--user-data-dir=${externalProfile}`,
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-breakpad',
    '--disable-crash-reporter',
    'about:blank',
  ], { stdio: 'ignore' })
  await waitForCdp(externalPort)
  const externalConnect = await call(a, 'provider-external-a', 'browser_provider', { action: 'connect', provider: 'external-cdp', endpoint: `http://127.0.0.1:${externalPort}` })
  assert(externalConnect.isError === false && externalConnect.value.data.active === 'external-cdp', `external CDP connect failed: ${JSON.stringify(externalConnect)}`)
  const externalNav = await call(a, 'provider-external-nav-a', 'browser_navigate', { url: origin })
  assert(externalNav.isError === false && externalNav.value.data.title === 'Browser Tools Fixture', 'external CDP navigation failed')
  const externalDisconnect = await call(a, 'provider-external-disconnect-a', 'browser_provider', { action: 'disconnect' })
  assert(externalDisconnect.isError === false && externalDisconnect.value.data.active === 'managed-persistent', 'external CDP disconnect did not restore default persistent provider')
  assert(externalBrowser.exitCode === null, 'external CDP disconnect closed the user browser process')
  let live
  for (let attempt = 0; attempt < 30; attempt += 1) {
    live = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (live.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(live?.frame?.data.length > 0, 'browser panel screencast did not produce a frame')
  const repeatedFrame = await rpc('snapshot', { sessionId: 'a', view: 'live', streamGeneration: live.frame.streamGeneration, sequence: live.frame.sequence })
  assert(repeatedFrame.frame === undefined, 'browser panel repeated an unchanged screencast frame')
  await rpc('takeover', { sessionId: 'a', action: 'request' })
  await rpc('close', { sessionId: 'a', view: 'live' })
  const controlAfterClose = await rpc('takeover', { sessionId: 'a', action: 'status' })
  assert(controlAfterClose.ok === true && controlAfterClose.data.owner === 'model', 'closing the live panel did not return session control to the model')
  let reopenedFrame
  for (let attempt = 0; attempt < 30; attempt += 1) {
    reopenedFrame = await rpc('snapshot', { sessionId: 'a', view: 'live' })
    if (reopenedFrame.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert(reopenedFrame?.frame?.data.length > 0, 'browser panel screencast did not restart after close')
  await rpc('close', { sessionId: 'a', view: 'live' })

  const controller = new AbortController()
  const pending = call(a, 'cancel-a', 'browser_navigate', { url: `${origin}/slow` }, controller.signal)
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 100)
  const cancelled = await pending
  if (cancelled.isError !== true || cancelled.error.info?.code !== 'ABORTED') throw new Error(`navigation cancellation was not normalized: ${JSON.stringify(cancelled)}`)
  const extensionPopupOpen = await rpcWithin('extension popup open', 20000, 'extensions', { sessionId: 'a', action: 'open_popup', extensionId: seededExtensionA })
  let popupExtensionsSnapshot
  for (let attempt = 0; attempt < 30; attempt += 1) {
    popupExtensionsSnapshot = await rpcWithin('extension popup extensions snapshot', 5000, 'snapshot', { sessionId: 'a', view: 'extensions' })
    if (popupExtensionsSnapshot.extensionPopup?.frame !== undefined) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const popupLiveSnapshot = await rpcWithin('extension popup live snapshot', 5000, 'snapshot', { sessionId: 'a', view: 'live' })
  assert(extensionPopupOpen.ok === true && popupExtensionsSnapshot.extensionPopup?.viewId === extensionPopupOpen.data.popupViewId && popupLiveSnapshot.extensionPopup?.viewId === extensionPopupOpen.data.popupViewId, 'extension popup did not remain available across panel views')
  await rpcWithin('extension popup close', 5000, 'extensions', { sessionId: 'a', action: 'close_popup', extensionId: seededExtensionA })
  const unregisterC = ctx.agents.register(c)
  unregisterC()
  let disposedSessionSnapshot
  for (let attempt = 0; attempt < 40; attempt += 1) {
    disposedSessionSnapshot = await rpc('snapshot', { sessionId: 'c', view: 'console' })
    if (disposedSessionSnapshot.available === false) break
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  const aAfterCDisposeNav = await call(a, 'after-c-dispose-nav-a', 'browser_navigate', { url: origin })
  const aAfterCDisposeState = await call(a, 'after-c-dispose-state-a', 'browser_evaluate', { action: 'main_world', expression: `localStorage.getItem('dshPersistentLocal')` })
  assert(disposedSessionSnapshot?.available === false
    && aAfterCDisposeNav.isError === false
    && aAfterCDisposeState.isError === false
    && aAfterCDisposeState.value.data.value === 'preserved',
  'disposing session C closed the shared context or damaged session A shared website state')
  const tabsBeforeEmpty = await rpc('snapshot', { sessionId: 'a', view: 'console' })
  for (const tab of tabsBeforeEmpty.tabs) await rpc('tabs', { sessionId: 'a', action: 'close', viewId: tab.viewId })
  const emptyPanel = await rpc('snapshot', { sessionId: 'a', view: 'live' })
  const emptyReload = await rpc('tabs', { sessionId: 'a', action: 'reload' })
  const recoveredPanelTab = await rpc('tabs', { sessionId: 'a', action: 'new' })
  const recoveredPanel = await rpc('snapshot', { sessionId: 'a', view: 'console' })
  assert(emptyPanel.available === true && emptyPanel.tabs.length === 0 && emptyPanel.activeViewId === undefined, 'browser panel did not preserve an explicit empty-tab state')
  assert(emptyReload.ok === false && emptyReload.data.code === 'NO_ACTIVE_TAB' && emptyReload.data.recoverable === true, 'browser panel empty-tab operation did not return a recoverable result')
  assert(recoveredPanelTab.ok === true && recoveredPanel.tabs.length === 1 && recoveredPanel.activeViewId === recoveredPanelTab.viewId && recoveredPanel.tabs[0].url === 'about:blank', 'browser panel did not recover from the empty-tab state')
  const l3PrivacyCanaries = [
    ...privacyCanaries,
    deepSensitiveCanary,
    '输入法可用',
    'clipboard-text',
    'private-clipboard-text',
    'clipboard-html',
    'file-body',
  ]
  const l3PrivacyOutputs = JSON.stringify({
    baseline: diagnosticBaseline.value?.data?.checkpoint,
    report: diagnosticReport.value?.data,
    rolling: recorderTimeline.value?.data,
    deep: deepTimeline.value?.data,
    deepIncident: deepIncidentReport.value?.data,
    recorderStopped: recorderStopped.data,
  })
  const l3PrivacyOutputHits = l3PrivacyCanaries.filter(canary => l3PrivacyOutputs.includes(canary))
  const l3PrivacyRuntimeHits = runtimeCanaryHits(runtime, l3PrivacyCanaries)
  assert(l3PrivacyOutputHits.length === 0
    && l3PrivacyRuntimeHits.length === 0
    && privacyPixels.every(pixel => pixel[0] === 91 && pixel[1] === 33 && pixel[2] === 182 && pixel[3] === 255),
  `L3 privacy canary leaked into Recorder-owned output, Incident, Artifact, log, or temporary file: ${JSON.stringify({ l3PrivacyOutputHits, l3PrivacyRuntimeHits, privacyPixels })}`)
  allow()
  result.stages = {
    ...result.stages,
    toolCount: names.length,
    rpcChannel: rpcRegistration.channel,
    fullAccessNavigation: fullAccessNavigation.value,
    panel: {
      draftAdoptedSharedViewId: draftFirstNew.viewId === draftFirstModelTabs.value.viewId,
      draftPreservedAfterPanelClose: draftFirstBeforeAdopt.activeViewId === draftFirstNew.viewId,
      panelFirstSharedViewId: panelFirstNew.viewId === panelFirstModelTabs.value.viewId,
      tabCount: panelAfterSelect.tabs.length,
      popupViewId: popupTab.viewId,
      noticeCount: injectedAfterSelect - injectedBeforeSelect,
      tabSwitchStaleRejected: panelSwitchStaleInput.data.code,
      emptyRecovered: recoveredPanel.tabs.length === 1,
    },
    splitView: {
      toolPresent: names.includes('browser_split_view'),
      dualFrames: splitLive.splitView.panes.every(item => item.frame?.data.length > 0),
      ratio: splitRatio.data.ratio,
      ratioPersisted: splitPreference.ratio === 0.6,
      compactPaneViewport: splitLive.splitView.panes.find(item => item.pane === 'bottom')?.liveView.height,
      restoredAfterContextRestart: splitAfterRestart.splitView.enabled === true && splitAfterRestart.splitView.ratio === 0.6,
      closedToSingle: splitAfterClose.splitView.enabled === false && splitAfterClose.tabs.length === 1,
      subagentMutationDenied: subagentSplitDenied.isError,
    },
    persistent: {
      defaultProvider: providerList.value.data.active,
      cookie: persistentCacheRead.value.data.value.sessionMarker,
      localStorage: persistentCacheRead.value.data.value.local,
      indexedDb: persistentCacheRead.value.data.value.indexed,
      cacheStorage: persistentCacheRead.value.data.value.cached,
      serviceWorkers: persistentCacheRead.value.data.value.serviceWorkers,
    },
    extensions: {
      toolPresent: names.includes('browser_extensions'),
      fullAccessPendingRestart: fullAccessExtensionEnable.value.data.extensions[0].pendingRestart,
      sessionAExtensionId: extensionsA.value.data.extensions[0].extensionId,
      sessionBExtensionId: extensionsB.value.data.extensions[0].extensionId,
      actionPopup: extensionsA.value.data.extensions[0].actionPopup,
      subagentMutationDenied: subagentExtensionDenied.isError,
    },
    extensionConfirmation: {
      nativeConfirmAbsent: !clientSource.includes('window.confirm('),
      panelConfirmationPresent: clientSource.includes('requestExtensionMutation'),
      explicitApplyModesPresent: clientSource.includes('下次启动生效') && clientSource.includes('立即生效'),
      floatingPopupPresent: clientSource.includes('extensionPopupLayer'),
      popupPersistentAcrossViews: popupLiveSnapshot.extensionPopup?.viewId === extensionPopupOpen.data.popupViewId,
      popupMoveResizePresent: clientSource.includes('beginExtensionPopupDrag') && panelCssSource.includes('resize: both'),
    },
    contextBounds: {
      snapshotChars: compactSnapshot.value.data.snapshot.length,
      diffChars: compactSnapshot.value.data.diff?.length ?? 0,
      queryTextChars: compactQuery.value.data.values[0].length,
      compactRender: indexSource.includes('text: JSON.stringify(value)'),
    },
    debugger: {
      streamGenerationChanged: afterDetachLive.frame.streamGeneration !== beforeDetachLive.frame.streamGeneration,
      scriptSourceBytes: scriptSource.value.data.bytes,
      sourceMapBytes: sourceMap.value.data.artifact.bytes,
    },
    diagnose: {
      toolPresent: names.includes('browser_diagnose'),
      baselineCheckpointId: diagnosticBaselineId,
      reproductionCheckpointId: diagnosticReproductionId,
      compareVerdict: diagnosticCompare.value.data.overallVerdict,
      checkpointArtifactCount: diagnosticBaseline.value.data.checkpoint.artifactManifest.length,
      incidentId: diagnosticReport.value.data.incident.incidentId,
      incidentFactCount: diagnosticReport.value.data.incident.facts.length,
      incidentCandidateCount: diagnosticReport.value.data.incident.causalCandidates.length,
      reportBytes: diagnosticReport.value.data.incident.costs.reportBytes,
      consoleErrorCount: diagnosticReport.value.data.evidence.errors.length,
      failedRequestStatuses: diagnosticFailedStatuses,
      correlationCount: diagnosticReport.value.data.correlations.length,
      actionTimelineCount: diagnosticReport.value.data.actionTimeline.length,
      occluderId: occludedInspect.value.data.element.hitTest.topElement.id,
      canvasBackingScale: canvasInspect.value.data.element.canvas.backingScaleX,
      portalRootId: portalInspect.value.data.element.portal.root.id,
      incrementalActionId: diagnosticClickTimeline.actionId,
      incrementalEventCount: diagnosticIncrementalReport.value.data.evidence.eventCount,
      navigationActionId: diagnosticNavigationTimeline.actionId,
      navigationBefore: diagnosticNavigationTimeline.identity.navigationBefore,
      navigationAfter: diagnosticNavigationTimeline.identity.navigationAfter,
      sourceMapCount: diagnosticSourceMapCount,
      sourceMapSummary: diagnosticSourceMapSummary,
      buildId: diagnosticReport.value.data.sourceMaps.find(mapping => mapping.confidence === 'confirmed')?.build?.buildId,
      workspaceCandidate: diagnosticReport.value.data.sourceMaps.find(mapping => mapping.confidence === 'confirmed')?.workspace?.path,
      crossNavigationMappingsUnavailable: diagnosticNavigationReport.value.data.sourceMaps.every(mapping => mapping.confidence === 'unavailable'),
      subagentDenied: subagentDiagnoseDenied.isError,
      staleAfterProviderSwitch: staleDiagnoseAfterProviderSwitch.isError,
      stopped: diagnosticStop.value.data.stopped,
      repeatedStop: diagnosticStopRepeated.value.data.stopped,
      panelSameView: diagnosticPanelBeforeRead.diagnostic.synchronization.status,
      panelUnreadBefore: diagnosticPanelBeforeRead.diagnostic.unread.total,
      panelUnreadAfter: diagnosticPanelAfterRead.diagnostic.unread.total,
      panelOccluderId: diagnosticPanelBeforeRead.diagnostic.latestInspect.occluder.id,
      takeoverActionCount: takeoverDiagnosticSnapshot.diagnostic.takeover.latestSummary.actionCount,
      contextTopologySchemaVersion: l3TopologyInitial.contextTopologySchemaVersion,
      targetCount: l3TopologyInitial.targets.length,
      initialFrameCount: l3TopologyInitial.frames.length,
      executionContextCount: l3TopologyInitial.executionContexts.length,
      sameFrameDocumentGenerationBefore: l3SameGeneration,
      sameFrameDocumentGenerationAfter: l3SameNavigated.documentGeneration,
      crossFrameOopif: l3CrossFrame.oopif,
      frameRequestAttribution: true,
      detachedFrameRemoved: true,
      restartAfterStop: diagnosticRestartAfterStopStatus.value.data.contextTopology.frames.some(frame => frame.mainFrame),
      panelContextTopology: diagnosticPanelBeforeRead.diagnostic.contextTopology.frameCount >= 1,
      sameFrameScriptIdentity: l3SameScript.frameId === l3SameFrame.frameId,
      oopifDegradation: l3TopologyInitial.degradations.some(item => item.code === 'oopif-target-context-limited'),
      crossSessionTopologyIsolated: true,
      privacyCanaryHits: l3PrivacyOutputHits.length + l3PrivacyRuntimeHits.length,
      diagnosticMaskPixels: privacyPixels,
      recorderVisualCaptureReleased: recorderFullyReleasedStatus.data.visualCapture.startedViewCount === 0,
    },
    networkControl: {
      bodyBytes: networkBody.value.data.bytes,
      timeoutAutoContinued: afterTimeout.value.data.pausedRequests.length === 0,
    },
    profile: {
      artifactCount: artifacts.value.data.artifacts.length,
      heapSnapshotBytes: heapSnapshot.value.data.artifact.bytes,
    },
    provider: {
      externalBrowserAlive: externalBrowser.exitCode === null,
    },
    cleanupEvidence: {
      staleRef: stale.value.data.code,
      cancelled: cancelled.error.info?.code,
    },
  }
  result.ok = true
} catch (error) {
  if (!(error instanceof WallClockMeasurementComplete)) {
    result.ok = false
    result.error = { name: error?.name, message: error?.message, stack: error?.stack }
  }
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
  if (externalCdpPort !== undefined && !await closed(externalCdpPort)) {
    try {
      const cleanupBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${externalCdpPort}`)
      const cleanupSession = await cleanupBrowser.newBrowserCDPSession()
      await cleanupSession.send('Browser.close')
    } catch {}
    for (let attempt = 0; attempt < 30 && !await closed(externalCdpPort); attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  if (externalBrowser !== undefined && externalBrowser.exitCode === null && externalBrowser.signalCode === null) {
    externalBrowser.kill()
    await new Promise(resolveExit => externalBrowser.once('exit', resolveExit))
  }
  if (server !== undefined) await new Promise(resolveClose => server.close(resolveClose))
  result.cleanup.portClosed = port === undefined ? true : await closed(port)
  result.cleanup.externalCdpClosed = externalCdpPort === undefined ? true : await closed(externalCdpPort)
  let runtimeCleanupError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(runtime, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
      runtimeCleanupError = undefined
      break
    } catch (error) {
      runtimeCleanupError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
  }
  result.cleanup.runtimeRemoved = !existsSync(runtime)
  if (runtimeCleanupError !== undefined) result.cleanup.runtimeCleanupError = runtimeCleanupError instanceof Error ? runtimeCleanupError.message : String(runtimeCleanupError)
  if (result.cleanup.externalCdpClosed !== true || result.cleanup.runtimeRemoved !== true || result.cleanup.portClosed !== true) {
    result.ok = false
    result.error = { name: 'CleanupError', message: 'integration cleanup did not release all temporary resources' }
  }
  writeFileSync(1, `${JSON.stringify(result, null, 2)}\n`)
}

if (!result.ok) process.exitCode = 1
