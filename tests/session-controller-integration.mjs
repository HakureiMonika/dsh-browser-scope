import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const dshRootInput = process.env.DSH_ALPHA1_ROOT
if (dshRootInput === undefined || dshRootInput.trim() === '') {
  throw new Error('DSH_ALPHA1_ROOT is required for the full Agent Scope integration test')
}
const dshRoot = resolve(dshRootInput)
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

const packageName = 'dsh-browser-scope'

try {
  rmSync(runtimeRoot, { recursive: true, force: true })
  // Controller 持久化根直接读取 DSH_HOME；测试必须显式隔离，禁止命中用户真实 ~/.dsh 状态。
  process.env.DSH_HOME = home
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(modules, packageName, 'lib'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-connection'), { recursive: true })
  mkdirSync(join(modules, 'browser-test-third-party'), { recursive: true })

  // 只复制当前构建产物到隔离 Profile，保证测试验证的是 DSH 实际加载路径，而不是源码直调。
  for (const file of ['package.json', 'cordis.patch.yml']) {
    copyFileSync(join(packageSourceRoot, file), join(modules, packageName, file))
  }
  copyFileSync(join(packageSourceRoot, 'lib', 'index.mjs'), join(modules, packageName, 'lib', 'index.mjs'))
  copyFileSync(join(packageSourceRoot, 'lib', 'index.d.mts'), join(modules, packageName, 'lib', 'index.d.mts'))

  link(join(dshRoot, 'vendor', 'cordis'), join(modules, '@deepseek-ai', 'cordis'))
  link(join(dshRoot, 'vendor', 'schemastery'), join(modules, '@deepseek-ai', 'schemastery'))
  link(join(dshRoot, 'packages', 'core', 'system-prompt'), join(modules, '@deepseek-ai', 'dsh-system-prompt'))
  link(join(dshRoot, 'packages', 'core', 'tools'), join(modules, '@deepseek-ai', 'dsh-tools'))
  link(join(dshRoot, 'packages', 'core', 'scope'), join(modules, '@deepseek-ai', 'dsh-scope'))
  link(join(dshRoot, 'packages', 'core', 'agent'), join(modules, '@deepseek-ai', 'dsh-agent'))
  link(join(dshRoot, 'packages', 'core', 'session'), join(modules, '@deepseek-ai', 'dsh-session'))
  link(join(dshRoot, 'packages', 'llm', 'llm'), join(modules, '@deepseek-ai', 'dsh-llm'))
  link(join(dshRoot, 'packages', 'attachment', 'attachment'), join(modules, '@deepseek-ai', 'dsh-attachment'))
  link(join(dshRoot, 'packages', 'attachment', 'attachment-local'), join(modules, '@deepseek-ai', 'dsh-attachment-local'))
  link(join(dshRoot, 'packages', 'util', 'home-paths'), join(modules, '@deepseek-ai', 'dsh-home-paths'))
  link(join(dshRoot, 'node_modules', '.pnpm', 'playwright-core@1.61.1', 'node_modules', 'playwright-core'), join(modules, 'playwright-core'))

  writeFileSync(join(modules, 'browser-test-connection', 'package.json'), JSON.stringify({
    name: 'browser-test-connection',
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2))
  writeFileSync(join(modules, 'browser-test-connection', 'index.mjs'), [
    "export function apply(ctx) {",
    "  ctx.provide('connection', {",
    "    rpc: {",
    "      handle(channel, handler) {",
    "        globalThis.__sessionControllerRpc = { channel, handler }",
    "        return () => { globalThis.__sessionControllerRpc = undefined }",
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
  writeFileSync(join(modules, packageName, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: system-prompt',
    "      name: '@deepseek-ai/dsh-system-prompt'",
    '      config:',
    '        includeHarnessIdentity: false',
    '        includeRuntimeContext: false',
    "        persona: ''",
    '    - id: attachments',
    "      name: '@deepseek-ai/dsh-attachment-local'",
    '      config:',
    `        dshHome: ${JSON.stringify(home)}`,
    '    - id: tools',
    "      name: '@deepseek-ai/dsh-tools'",
    '    - id: sessions',
    "      name: '@deepseek-ai/dsh-session'",
    '    - id: agent',
    "      name: '@deepseek-ai/dsh-agent'",
    '    - id: connection',
    '      name: browser-test-connection',
    '    - id: third-party',
    '      name: browser-test-third-party',
    '    - id: browser-tools',
    `      name: ${packageName}`,
    '      config:',
    '        toolRegistrationMode: session-select',
    '        sessionController:',
    '          defaultMode: other',
    `        artifactRoot: ${JSON.stringify(artifactRoot)}`,
  ].join('\n') + '\n')

  const appBoot = await import(pathToFileURL(join(dshRoot, 'packages', 'boot', 'app-boot', 'lib', 'index.js')).href)
  const llm = await import(pathToFileURL(join(dshRoot, 'packages', 'llm', 'llm', 'lib', 'index.js')).href)
  const sessionApi = await import(pathToFileURL(join(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js')).href)
  const agentApi = await import(pathToFileURL(join(dshRoot, 'packages', 'core', 'agent', 'lib', 'index.js')).href)
  const scopeApi = await import(pathToFileURL(join(dshRoot, 'packages', 'core', 'scope', 'lib', 'index.js')).href)

  const loaded = appBoot.loadProfile('session-controller-integration', 'test', join(dshRoot, 'apps', 'cli', 'package.json'), home)
  ctx = await appBoot.boot('session-controller-integration', join(profile, 'cordis.patch.yml'), loaded.layers.flatMap(layer => layer.patches))
  const tools = ctx.get('tools')
  const rpcRegistration = globalThis.__sessionControllerRpc
  assert(rpcRegistration?.channel === '/browser-tools', 'Controller RPC channel was not registered')

  // 使用 DSH 官方 Scope primitive 和 Agent Registry，确保 Schema 合并、执行分发与生命周期均走真实实现。
  async function createAgent(rawId) {
    const session = ctx.sessions.create(sessionApi.SessionId(rawId))
    const agent = {
      id: session.id,
      options: {},
      session,
      inbox: new agentApi.Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
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
  assert(tools.schemas(first.agent).find(schema => schema.name === 'browser_tabs')?.description === 'third-party:browser_tabs', 'other Session did not retain third-party same-name tool')
  assert(tools.schemas(first.agent).some(schema => schema.name === 'browser_auth'), 'other Session did not retain third-party unique tool')
  const beforeThirdParty = await execute(first.agent, 'before-third-party', 'browser_tabs')
  assert(beforeThirdParty.isError === false && beforeThirdParty.value.owner === 'third-party', 'other Session did not execute third-party same-name tool')
  // browser_navigate historically需要本插件 Approval；other 模式下它属于第三方，必须绕过本插件所有权策略直接执行。
  const thirdPartyNavigate = await execute(first.agent, 'third-party-navigate', 'browser_navigate')
  assert(thirdPartyNavigate.isError === false && thirdPartyNavigate.value.owner === 'third-party', 'plugin approval policy incorrectly intercepted third-party browser_navigate')

  const inactiveSnapshot = await rpcRegistration.handler('snapshot', { sessionId: first.agent.id, view: 'live' }, new AbortController().signal)
  assert(inactiveSnapshot.ok === false && inactiveSnapshot.error.message.includes('尚未启用'), 'other mode did not reject full snapshot RPC before browser resource creation')
  const initial = await rpc('controller_status', first.agent.id)
  assert(initial.registrationMode === 'session-select' && initial.mode === 'other' && initial.status === 'inactive', 'initial Controller status is incorrect')
  const activated = await rpc('controller_activate', first.agent.id)
  assert(activated.status === 'active' && activated.generation === 1, `Controller activation status is incorrect: ${JSON.stringify(activated)}`)
  assert(activated.shadowedTools.includes('browser_tabs'), 'same-name third-party tool was not classified as shadowed')
  assert(activated.restrictedTools.includes('browser_auth'), 'third-party unique tool was not classified as restricted')
  assert(tools.schemas(first.agent).filter(schema => schema.name.startsWith('browser_')).length === 30, 'active Session does not expose exactly 30 owned browser tools')
  assert(tools.schemas(first.agent).find(schema => schema.name === 'browser_tabs')?.description !== 'third-party:browser_tabs', 'owned Agent tool did not shadow third-party same-name tool')
  assert(!tools.schemas(first.agent).some(schema => schema.name === 'browser_auth'), 'third-party unique tool remained visible in active Session')
  const restrictedExecution = await execute(first.agent, 'restricted-third-party', 'browser_auth')
  assert(restrictedExecution.isError === true && restrictedExecution.error.message.includes('unknown tool'), 'restricted third-party tool remained executable')

  // 第二个 Session 必须继续看到并执行第三方工具，证明 restriction 和 shadow 均为 Agent Scope 局部效果。
  assert(tools.schemas(second.agent).find(schema => schema.name === 'browser_tabs')?.description === 'third-party:browser_tabs', 'active Session polluted sibling same-name tool')
  assert(tools.schemas(second.agent).some(schema => schema.name === 'browser_auth'), 'active Session polluted sibling unique tool')
  const siblingThirdParty = await execute(second.agent, 'sibling-third-party', 'browser_auth')
  assert(siblingThirdParty.isError === false && siblingThirdParty.value.owner === 'third-party', 'sibling Session could not execute third-party unique tool')

  const deactivated = await rpc('controller_deactivate', first.agent.id)
  assert(deactivated.status === 'inactive' && deactivated.generation === 2, 'Controller deactivation status is incorrect')
  assert(tools.schemas(first.agent).find(schema => schema.name === 'browser_tabs')?.description === 'third-party:browser_tabs', 'deactivation did not restore third-party same-name tool')
  assert(tools.schemas(first.agent).some(schema => schema.name === 'browser_auth'), 'deactivation did not restore third-party unique tool')
  const restoredThirdParty = await execute(first.agent, 'restored-third-party', 'browser_tabs')
  assert(restoredThirdParty.isError === false && restoredThirdParty.value.owner === 'third-party', 'deactivation did not restore third-party execution dispatch')

  const persistedPath = join(home, 'browser-tools', 'controller', 'sessions', controllerFileName(first.agent.id))
  const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'))
  assert(persisted.mode === 'other' && persisted.generation === 2, 'Controller persisted state is incorrect')

  // 对齐真实 AgentLoop：先等待 Agent Scope 撤销 scoped 注册，再从 Registry 发出 agent/disposed。
  await first.scope.dispose()
  await second.scope.dispose()
  first.unregister()
  second.unregister()
  await Promise.resolve()

  result.ok = true
  result.stages = {
    globalBrowserToolCount: 3,
    activeBrowserToolCount: 30,
    sameNameShadowed: true,
    uniqueThirdPartyRestricted: true,
    thirdPartyApprovalUnaffected: true,
    inactiveSnapshotRejected: true,
    siblingSessionUnaffected: true,
    deactivationRestoredThirdParty: true,
    persistedGeneration: persisted.generation,
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
