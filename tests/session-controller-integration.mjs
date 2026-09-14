import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 默认验证工作树构建；冻结包验收可显式切换到 npm 隔离安装后的包根，确保真实加载字节来自 tarball。
const packageSourceRoot = resolve(
  process.env.DSH_BROWSER_SCOPE_PACKAGE_ROOT
    ?? root,
)
const runtimeRoot = join(root, '.runtime', 'session-controller-integration')
const home = join(runtimeRoot, 'home')
const profile = join(home, 'profiles', 'test')
const modules = join(profile, 'node_modules')
const artifactRoot = join(runtimeRoot, 'artifacts')
const require = createRequire(import.meta.url)
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installedPackageRoot = name => dirname(require.resolve(`${name}/package.json`))
const installedPackageEntry = name => require.resolve(name)
const installedPackages = new Set([
  ...Object.keys(packageManifest.dependencies ?? {}),
  ...Object.keys(packageManifest.devDependencies ?? {}),
].filter(name => name.startsWith('@deepseek-ai/') || name === 'playwright-core'))
const appBootAnchor = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
const previousDshHome = process.env.DSH_HOME
const result = { ok: false, cleanup: { runtimeRemoved: false } }
let ctx

function assert(value, message) {
  if (!value) throw new Error(message)
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'junction')
}

function controllerFileName(sessionId) {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

function createInbox() {
  const nextTurn = []
  const nextStep = []
  const bucket = target => target === 'next-step' ? nextStep : nextTurn
  const messageId = message => message?.id ?? message?.messageId
  const locate = id => {
    for (const messages of [nextStep, nextTurn]) {
      const index = messages.findIndex(message => messageId(message) === id)
      if (index >= 0) return { messages, index }
    }
  }

  // RC.1 只公开 Inbox 接口，不再导出内部存储构造器。测试使用内存实现保留标准队列语义，
  // 但不持久化任何消息；本用例只验证 Agent Scope 与工具仲裁，不把 Inbox 实现细节纳入断言。
  return {
    get nextTurn() { return nextTurn },
    get nextStep() { return nextStep },
    clear() {
      nextStep.splice(0)
      nextTurn.splice(0)
    },
    append(target, message) { bucket(target).push(message) },
    prepend(target, message) { bucket(target).unshift(message) },
    replace(id, message) {
      const found = locate(id)
      if (found === undefined) return false
      found.messages[found.index] = message
      return true
    },
    remove(id) {
      const found = locate(id)
      if (found === undefined) return false
      found.messages.splice(found.index, 1)
      return true
    },
    splice(target, start, deleteCount, inserted) {
      return bucket(target).splice(start, deleteCount, ...inserted)
    },
  }
}

const packageName = 'dsh-browser-scope'

try {
  rmSync(runtimeRoot, { recursive: true, force: true })
  // Controller 持久化根直接读取 DSH_HOME；测试必须显式隔离，禁止命中用户真实 ~/.dsh 状态。
  process.env.DSH_HOME = home
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(modules, packageName, 'lib'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-connection'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-permission-presets'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-third-party'), { recursive: true })

  // 只复制当前构建产物到隔离 Profile，保证测试验证的是 DSH 实际加载路径，而不是源码直调。
  for (const file of ['package.json', 'cordis.patch.yml']) {
    copyFileSync(join(packageSourceRoot, file), join(modules, packageName, file))
  }
  copyFileSync(join(packageSourceRoot, 'lib', 'index.mjs'), join(modules, packageName, 'lib', 'index.mjs'))
  copyFileSync(join(packageSourceRoot, 'lib', 'index.d.mts'), join(modules, packageName, 'lib', 'index.d.mts'))

  // 隔离 Profile 只链接当前项目已经锁定的 npm 包；所有包从消费者入口解析，避免依赖 DSH 单仓目录结构或 pnpm 虚拟目录名。
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
    "  ctx.provide('permissionPresets', { current: () => undefined })",
    "}",
  ].join('\n'))

  writeFileSync(join(modules, 'browser-test-connection', 'package.json'), JSON.stringify({
    name: 'browser-test-connection',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2))
  writeFileSync(join(modules, 'browser-test-connection', 'index.mjs'), [
    "export function apply(ctx) {",
    "  ctx.provide('connection', {",
    "    fetch: {",
    "      register(route) {",
    "        globalThis.__sessionControllerRpc = {",
    "          path: route.path,",
    "          handler: async (endpoint, payload, signal) => {",
    "            const rpcId = `session-controller-${endpoint}`",
    "            const response = await route.fetch(new Request('http://dsh.internal/api/browser-tools', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'browser-tools', payload: { endpoint, payload } }), signal }))",
    "            return (await response.json()).result",
    "          },",
    "        }",
    "        return async () => { globalThis.__sessionControllerRpc = undefined }",
    "      },",
    "    },",
    "  })",
    "}",
  ].join('\n'))

  writeFileSync(join(modules, 'browser-test-third-party', 'package.json'), JSON.stringify({
    name: 'browser-test-third-party',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2))
  writeFileSync(join(modules, 'browser-test-third-party', 'index.mjs'), [
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    "const output = { schema: { type: 'object', additionalProperties: false, properties: { owner: { type: 'string', required: true }, name: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }",
    "function tool(name, owner) {",
    "  return defineTool({ name, description: `${owner}:${name}`, parameters: {}, output, execute: async () => ({ owner, name }) })",
    "}",
    "export function apply(ctx) {",
    "  ctx.tools.register(tool('browser_tabs', 'third-party'))",
    "  ctx.tools.register(tool('browser_navigate', 'third-party'))",
    "  ctx.tools.register(tool('browser_auth', 'third-party'))",
    "}",
    "export const inject = ['tools']",
  ].join('\n'))

  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'session-controller-test-profile',
    private: true,
    dsh: { profile: { bundles: [packageName] } },
  }, null, 2))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  const isolatedPackageEntry = join(modules, packageName, 'lib', 'index.mjs')
  const connectionEntry = join(modules, 'browser-test-connection', 'index.mjs')
  const permissionPresetsEntry = join(modules, 'browser-test-permission-presets', 'index.mjs')
  const thirdPartyEntry = join(modules, 'browser-test-third-party', 'index.mjs')
  writeFileSync(join(modules, packageName, 'cordis.patch.yml'), [
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
    '    - id: connection',
    `      name: ${JSON.stringify(connectionEntry)}`,
    '    - id: permission-presets',
    `      name: ${JSON.stringify(permissionPresetsEntry)}`,
    '    - id: third-party',
    `      name: ${JSON.stringify(thirdPartyEntry)}`,
    '    - id: browser-tools',
    `      name: ${JSON.stringify(isolatedPackageEntry)}`,
    '      config:',
    '        toolRegistrationMode: session-select',
    `        artifactRoot: ${JSON.stringify(artifactRoot)}`,
  ].join('\n') + '\n')

  const appBoot = await import('@deepseek-ai/dsh-app-boot')
  const llm = await import('@deepseek-ai/dsh-llm')
  const sessionApi = await import('@deepseek-ai/dsh-session')
  const scopeApi = await import('@deepseek-ai/dsh-scope')

  const loaded = appBoot.loadProfile('session-controller-integration', 'test', appBootAnchor, home)
  ctx = await appBoot.boot(
    'session-controller-integration',
    join(profile, 'cordis.patch.yml'),
    loaded.layers.flatMap(layer => layer.patches),
  )
  const tools = ctx.get('tools')
  const rpcRegistration = globalThis.__sessionControllerRpc
  assert(rpcRegistration?.path === '/api/browser-tools', 'Controller authenticated Fetch RPC route was not registered')

  // 使用 DSH 官方 Scope primitive 和 Agent Registry，确保 Schema 合并、执行分发与生命周期均走真实实现。
  async function createAgent(rawId) {
    const session = ctx.sessions.create(sessionApi.SessionId(rawId))
    const agent = {
      id: session.id,
      options: {},
      session,
      inbox: createInbox(),
      status: 'idle',
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    let scope
    await ctx.plugin(Object.assign(inner => {
      scope = scopeApi.createScope(inner, agent)
      agent.ctx = scope.ctx
    }, { inject: ['tools', 'systemPrompt'] }))
    const unregister = ctx.agents.register(agent)
    await Promise.resolve()
    return { agent, scope, unregister }
  }

  const first = await createAgent('session-controller-a')
  const second = await createAgent('session-controller-b')
  const execute = (agent, callId, name) => tools.execute({
    agent,
    callId: llm.ToolCallId(callId),
    name,
    arguments: {},
    signal: new AbortController().signal,
  })
  const rpc = async (endpoint, sessionId) => {
    const response = await rpcRegistration.handler(endpoint, { sessionId }, new AbortController().signal)
    assert(response.ok === true, `${endpoint} failed: ${JSON.stringify(response)}`)
    return response.value
  }

  assert(tools.schemas().filter(schema => schema.name.startsWith('browser_')).length === 3, 'session-select incorrectly registered owned browser tools globally')
  // controller_status 会等待对应 Agent Scope 的持久状态恢复；工具面断言必须在就绪门之后执行，避免把异步 attach 时序误判为选择门失败。
  const initial = await rpc('controller_status', first.agent.id)
  const siblingInitial = await rpc('controller_status', second.agent.id)
  assert(initial.registrationMode === 'session-select' && initial.mode === 'unselected' && initial.selectionLocked === false, 'initial browser selection status is incorrect')
  assert(siblingInitial.registrationMode === 'session-select' && siblingInitial.mode === 'unselected' && siblingInitial.selectionLocked === false, 'sibling initial browser selection status is incorrect')
  // 新 Session 在用户选择前不暴露任何浏览器工具，避免 Agent 抢先使用某个插件并形成混合状态。
  assert(tools.schemas(first.agent).filter(schema => schema.name.startsWith('browser_')).length === 0, 'unselected Session exposed browser tools before user selection')
  assert(tools.schemas(second.agent).filter(schema => schema.name.startsWith('browser_')).length === 0, 'sibling unselected Session exposed browser tools before user selection')

  const inactiveSnapshot = await rpcRegistration.handler('snapshot', { sessionId: first.agent.id, view: 'live' }, new AbortController().signal)
  assert(inactiveSnapshot.ok === false && inactiveSnapshot.error.message.includes('尚未启用'), 'unselected mode did not reject full snapshot RPC before browser resource creation')

  // Session A 首次选择 BrowserScope 后永久锁定，只暴露本插件 30 个工具。
  const activated = await rpc('controller_activate', first.agent.id)
  assert(activated.status === 'active' && activated.generation === 1 && activated.selectionLocked === true, `BrowserScope selection status is incorrect: ${JSON.stringify(activated)}`)
  assert(activated.shadowedTools.includes('browser_tabs'), 'same-name third-party tool was not classified as shadowed')
  assert(activated.restrictedTools.includes('browser_auth'), 'third-party unique tool was not classified as restricted')
  assert(tools.schemas(first.agent).filter(schema => schema.name.startsWith('browser_')).length === 30, 'BrowserScope Session does not expose exactly 30 owned browser tools')
  assert(tools.schemas(first.agent).find(schema => schema.name === 'browser_tabs')?.description !== 'third-party:browser_tabs', 'owned Agent tool did not shadow third-party same-name tool')
  assert(!tools.schemas(first.agent).some(schema => schema.name === 'browser_auth'), 'third-party unique tool remained visible in BrowserScope Session')

  const blockedChange = await rpcRegistration.handler('controller_select_other', { sessionId: first.agent.id }, new AbortController().signal)
  assert(blockedChange.ok === false && blockedChange.error.message.includes('新建 Session'), 'locked BrowserScope Session incorrectly allowed changing browser plugin')

  // 释放 BrowserScope 页面和运行资源后，工具选择仍保持 BrowserScope。
  const released = await rpc('controller_release', first.agent.id)
  assert(released.mode === 'dsh-browser-tools' && released.status === 'active' && released.generation === 1, 'resource release incorrectly changed BrowserScope selection')
  assert(tools.schemas(first.agent).filter(schema => schema.name.startsWith('browser_')).length === 30, 'resource release removed BrowserScope tools')
  assert(!tools.schemas(first.agent).some(schema => schema.name === 'browser_auth'), 'resource release restored third-party browser tools')

  // Session B 独立选择其他浏览器工具，第三方工具恢复并永久锁定。
  const selectedOther = await rpc('controller_select_other', second.agent.id)
  assert(selectedOther.mode === 'other' && selectedOther.status === 'inactive' && selectedOther.selectionLocked === true, 'other browser selection status is incorrect')
  assert(tools.schemas(second.agent).find(schema => schema.name === 'browser_tabs')?.description === 'third-party:browser_tabs', 'other browser selection did not restore third-party same-name tool')
  assert(tools.schemas(second.agent).some(schema => schema.name === 'browser_auth'), 'other browser selection did not restore third-party unique tool')
  const siblingThirdParty = await execute(second.agent, 'sibling-third-party', 'browser_auth')
  assert(siblingThirdParty.isError === false && siblingThirdParty.value.owner === 'third-party', 'other browser Session could not execute third-party tool')

  const blockedBrowserScope = await rpcRegistration.handler('controller_activate', { sessionId: second.agent.id }, new AbortController().signal)
  assert(blockedBrowserScope.ok === false && blockedBrowserScope.error.message.includes('新建 Session'), 'locked other-browser Session incorrectly allowed BrowserScope selection')

  const persistedFirstPath = join(home, 'browser-tools', 'controller', 'sessions', controllerFileName(first.agent.id))
  const persistedSecondPath = join(home, 'browser-tools', 'controller', 'sessions', controllerFileName(second.agent.id))
  const persistedFirst = JSON.parse(readFileSync(persistedFirstPath, 'utf8'))
  const persistedSecond = JSON.parse(readFileSync(persistedSecondPath, 'utf8'))
  assert(persistedFirst.schemaVersion === 2 && persistedFirst.mode === 'dsh-browser-tools' && persistedFirst.generation === 1, 'BrowserScope persisted selection is incorrect')
  assert(persistedSecond.schemaVersion === 2 && persistedSecond.mode === 'other' && persistedSecond.generation === 1, 'other browser persisted selection is incorrect')

  // 对齐真实 AgentLoop：先等待 Agent Scope 撤销 scoped 注册，再从 Registry 发出 agent/disposed。
  await first.scope.dispose()
  await second.scope.dispose()
  first.unregister()
  second.unregister()
  await Promise.resolve()

  result.ok = true
  result.stages = {
    globalBrowserToolCount: 3,
    unselectedBrowserToolCount: 0,
    activeBrowserToolCount: 30,
    browserScopeSelectionLocked: true,
    otherBrowserSelectionLocked: true,
    releasePreservedSelection: true,
    sameNameShadowed: true,
    uniqueThirdPartyRestricted: true,
    inactiveSnapshotRejected: true,
    browserScopePersistedGeneration: persistedFirst.generation,
    otherBrowserPersistedGeneration: persistedSecond.generation,
  }
} catch (error) {
  result.error = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
  result.cleanup.runtimeRemoved = !existsSync(runtimeRoot)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (!result.ok || !result.cleanup.runtimeRemoved) process.exitCode = 1
