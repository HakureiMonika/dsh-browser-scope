import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BrowserControllerStore } from '../src/browser-controller.ts'

interface VisibleToolSchema {
  name: string
  description: string
  parameters: ToolDefinition['parameters']
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function definition(name: string, marker: string): ToolDefinition {
  return {
    name,
    description: marker,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [],
    },
    execute: async () => ({ marker }),
  }
}

class FakeToolSurface {
  readonly globals = new Map<string, ToolDefinition>()
  readonly locals = new Map<Agent, Map<string, ToolDefinition>>()
  readonly restrictions = new Map<Agent, Set<string>>()
  readonly guards = new Map<Agent, Set<(exec: { name: string }) => string | undefined>>()

  schemas(agent?: Agent): VisibleToolSchema[] {
    const visible = new Map(this.globals)
    if (agent !== undefined) {
      const denied = this.restrictions.get(agent) ?? new Set<string>()
      for (const name of denied) visible.delete(name)
      for (const [name, value] of this.locals.get(agent) ?? []) visible.set(name, value)
    }
    return [...visible.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  register(agent: Agent, values: readonly ToolDefinition[]): () => void {
    let local = this.locals.get(agent)
    if (local === undefined) {
      local = new Map()
      this.locals.set(agent, local)
    }
    const inserted: string[] = []
    try {
      for (const value of values) {
        if (local.has(value.name)) throw new Error(`duplicate local tool ${value.name}`)
        local.set(value.name, value)
        inserted.push(value.name)
      }
    } catch (error) {
      for (const name of inserted) local.delete(name)
      throw error
    }
    return () => {
      for (const name of inserted) local?.delete(name)
    }
  }

  restrict(agent: Agent, deny: string[]): () => void {
    const inherited = new Set(this.globals.keys())
    const unknown = deny.filter(name => !inherited.has(name))
    if (unknown.length > 0) throw new Error(`unknown inherited tools: ${unknown.join(',')}`)
    const set = new Set(deny)
    this.restrictions.set(agent, set)
    return () => { this.restrictions.delete(agent) }
  }

  guard(agent: Agent, value: (exec: { name: string }) => string | undefined): () => void {
    let guards = this.guards.get(agent)
    if (guards === undefined) {
      guards = new Set()
      this.guards.set(agent, guards)
    }
    guards.add(value)
    return () => { guards?.delete(value) }
  }
}

function fakeAgent(id: string, surface: FakeToolSurface): Agent & { notices: string[]; readonly preStep?: () => Promise<unknown> } {
  const notices: string[] = []
  let preStep: (() => Promise<unknown>) | undefined
  const agent = {
    id,
    status: 'idle',
    session: {
      id,
      header: { createdAt: 1, origin: 'user' },
      events: [],
    },
    notices,
    ctx: {
      tools: {
        restrict: ({ deny }: { deny?: string[] }) => surface.restrict(agent as unknown as Agent, deny ?? []),
        guard: (guard: (exec: { name: string }) => string | undefined) => surface.guard(agent as unknown as Agent, guard),
      },
      on: (name: string, listener: (_payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        if (name !== 'agent/pre-step') return () => true
        const current = () => listener({}, async () => ({ kind: 'enter', messages: [] }))
        preStep = current
        return () => {
          if (preStep === current) preStep = undefined
          return true
        }
      },
    },
    whenIdle: async () => {},
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    inject: (message: { content?: Array<{ type?: string; text?: string }> }) => {
      const text = message.content?.find(item => item.type === 'text')?.text
      if (text !== undefined) notices.push(text)
    },
  }
  return Object.defineProperty(agent, 'preStep', {
    enumerable: true,
    get: () => preStep,
  }) as unknown as Agent & { notices: string[]; readonly preStep?: () => Promise<unknown> }
}

const runtimeRoot = join(process.cwd(), '.runtime', 'browser-controller-test')
await rm(runtimeRoot, { recursive: true, force: true })
await mkdir(runtimeRoot, { recursive: true })

try {
  const surface = new FakeToolSurface()
  surface.globals.set('browser_snapshot', definition('browser_snapshot', 'third-party-snapshot'))
  surface.globals.set('browser_auth', definition('browser_auth', 'third-party-auth'))
  surface.globals.set('read', definition('read', 'ordinary-read'))
  const owned = [
    definition('browser_snapshot', 'dsh-browser-tools-snapshot'),
    definition('browser_tabs', 'dsh-browser-tools-tabs'),
  ]
  const suspended: string[] = []
  const released: string[] = []
  const ctx = { tools: { schemas: (agent?: Agent) => surface.schemas(agent) } } as unknown as Context
  const store = new BrowserControllerStore({
    ctx,
    storageRoot: runtimeRoot,
    config: {
      defaultMode: 'other',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => surface.register(agent, definitions),
    suspendRuntime: async sessionId => { suspended.push(sessionId) },
    releaseRuntime: async sessionId => { released.push(sessionId) },
    isOwnedTool: name => owned.some(value => value.name === name),
  })

  const first = fakeAgent('session-a', surface)
  const second = fakeAgent('session-b', surface)
  store.attach(first)
  store.attach(second)
  await first.preStep?.()
  await second.preStep?.()

  assert(surface.schemas(first).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', 'other 模式不应遮蔽第三方同名工具')
  assert(surface.schemas(first).some(value => value.name === 'browser_auth'), 'other 模式不应限制第三方独有工具')

  const active = await store.activate('session-a')
  assert(active.status === 'active' && active.mode === 'dsh-browser-tools', '激活后控制器状态不正确')
  assert(active.generation === 1, '首次激活应递增 generation')
  assert(active.shadowedTools.includes('browser_snapshot'), '同名工具没有进入 shadow 集')
  assert(active.restrictedTools.includes('browser_auth'), '第三方独有工具没有进入 restriction 集')
  assert(surface.schemas(first).find(value => value.name === 'browser_snapshot')?.description === 'dsh-browser-tools-snapshot', 'Agent 层同名工具没有遮蔽第三方工具')
  assert(!surface.schemas(first).some(value => value.name === 'browser_auth'), '第三方独有浏览器工具没有被限制')
  assert(surface.schemas(second).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', '另一个 Session 的第三方同名工具受到影响')
  assert(surface.schemas(second).some(value => value.name === 'browser_auth'), '另一个 Session 的第三方独有工具受到影响')
  assert(store.ownsExecution('session-a', 'browser_snapshot'), '激活 Session 的工具所有权未建立')
  assert(!store.ownsExecution('session-b', 'browser_snapshot'), '未激活 Session 被错误判为本插件所有')

  const inactive = await store.deactivate('session-a')
  assert(inactive.status === 'inactive' && inactive.mode === 'other', '退出后状态不正确')
  assert(inactive.generation === 2, '退出应递增 generation')
  assert(suspended.join(',') === 'session-a', '默认退出没有调用安全挂起')
  assert(surface.schemas(first).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', '退出后第三方同名工具没有恢复')
  assert(surface.schemas(first).some(value => value.name === 'browser_auth'), '退出后第三方独有工具没有恢复')

  await store.activate('session-a')
  await store.deactivate('session-a', true)
  assert(released.join(',') === 'session-a', '释放退出没有调用 Session 资源清理')

  const persistedFiles = await import('node:fs/promises').then(fs => fs.readdir(runtimeRoot))
  assert(persistedFiles.length === 1, 'Session 模式持久化文件数量不正确')
  const persisted = JSON.parse(await readFile(join(runtimeRoot, persistedFiles[0] as string), 'utf8')) as { mode?: string; generation?: number }
  assert(persisted.mode === 'other' && persisted.generation === 4, '持久化模式或 generation 不正确')

  // 已退出 Session 的重复退出必须幂等，不能再次递增 generation 或重复释放 Runtime 资源。
  const repeatedInactive = await store.deactivate('session-a', true)
  assert(repeatedInactive.generation === 4, '重复退出错误递增了 generation')
  assert(released.length === 1, '重复退出错误重复释放了 Runtime 资源')

  // 冷恢复只重建 scoped 工具面，必须沿用持久 generation，不能把恢复本身解释为新一次控制器切换。
  const recoveryRoot = join(runtimeRoot, 'recovery')
  const recoverySessionId = 'session-restored'
  const recoveryPath = join(recoveryRoot, `${createHash('sha256').update(recoverySessionId).digest('hex')}.json`)
  await mkdir(recoveryRoot, { recursive: true })
  await writeFile(recoveryPath, `${JSON.stringify({
    schemaVersion: 1,
    mode: 'dsh-browser-tools',
    generation: 7,
    updatedAt: 1,
  }, null, 2)}\n`, 'utf8')
  const recoveryStore = new BrowserControllerStore({
    ctx,
    storageRoot: recoveryRoot,
    config: {
      defaultMode: 'other',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => surface.register(agent, definitions),
    suspendRuntime: async () => {},
    releaseRuntime: async () => {},
    isOwnedTool: name => owned.some(value => value.name === name),
  })
  const recoveryAgent = fakeAgent(recoverySessionId, surface)
  recoveryStore.attach(recoveryAgent)
  await recoveryAgent.preStep?.()
  const restored = recoveryStore.snapshot(recoverySessionId)
  assert(restored.status === 'active' && restored.generation === 7, '冷恢复没有沿用持久 active 状态与 generation')
  assert(recoveryStore.identity(recoverySessionId)?.generation === 7, '冷恢复后的 Controller Identity generation 不正确')
  assert((await recoveryStore.activate(recoverySessionId)).generation === 7, '重复激活错误递增了 generation')
  assert(JSON.parse(await readFile(recoveryPath, 'utf8')).generation === 7, '冷恢复错误改写了持久 generation')
  await recoveryStore.detach(recoveryAgent)
  assert(recoveryAgent.preStep === undefined, 'Agent Dispose 后 pre-step 监听没有解除')
  assert(surface.schemas(recoveryAgent).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', 'Agent Dispose 后第三方同名工具没有恢复')
  assert(surface.schemas(recoveryAgent).some(value => value.name === 'browser_auth'), 'Agent Dispose 后第三方独有工具没有恢复')
  assert(recoveryStore.identity(recoverySessionId) === undefined, 'Agent Dispose 后 Controller Identity 仍然残留')

  // DSH 可能在同一正式 Session 上用新 Agent Scope 替换旧 Scope。旧 Agent 的异步 detach
  // 即使先进入并等待队列，也不得在新 Agent attach 后清除新 Scope 的工具、restriction 和 active 状态。
  const replacementRoot = join(runtimeRoot, 'replacement')
  const replacementSessionId = 'session-replaced-agent'
  let releaseOldSuspend: (() => void) | undefined
  let markOldSuspendEntered: (() => void) | undefined
  const oldSuspend = new Promise<void>(resolve => { releaseOldSuspend = resolve })
  const oldSuspendEntered = new Promise<void>(resolve => { markOldSuspendEntered = resolve })
  const replacementStore = new BrowserControllerStore({
    ctx,
    storageRoot: replacementRoot,
    config: {
      defaultMode: 'other',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => surface.register(agent, definitions),
    suspendRuntime: async () => {
      markOldSuspendEntered?.()
      await oldSuspend
    },
    releaseRuntime: async () => {},
    isOwnedTool: name => owned.some(value => value.name === name),
  })
  const oldAgent = fakeAgent(replacementSessionId, surface)
  replacementStore.attach(oldAgent)
  await oldAgent.preStep?.()
  await replacementStore.activate(replacementSessionId)
  const queuedOldDeactivation = replacementStore.deactivate(replacementSessionId)
  await oldSuspendEntered
  const staleDetach = replacementStore.detach(oldAgent)
  const newAgent = fakeAgent(replacementSessionId, surface)
  replacementStore.attach(newAgent)
  releaseOldSuspend?.()
  await queuedOldDeactivation.then(
    () => { throw new Error('旧 Agent 的排队退出在新 Scope 接管后错误成功') },
    error => { assert(String(error).includes('Agent Scope 已更新'), '旧 Agent 过期退出没有返回明确竞态错误') },
  )
  await staleDetach
  await newAgent.preStep?.()
  const replaced = replacementStore.snapshot(replacementSessionId)
  assert(replaced.status === 'active' && replaced.mode === 'dsh-browser-tools', '旧 Agent detach 清除了新 Agent 的 active Controller 状态')
  assert(surface.schemas(newAgent).find(value => value.name === 'browser_snapshot')?.description === 'dsh-browser-tools-snapshot', '新 Agent 没有重建本插件 scoped 工具面')
  assert(!surface.schemas(newAgent).some(value => value.name === 'browser_auth'), '新 Agent 没有恢复第三方独有工具 restriction')
  await replacementStore.detach(newAgent)

  // 损坏持久文件必须失败关闭到 other；即使 defaultMode 配置为本插件，也不能自动抢占第三方工具面。
  const corruptRoot = join(runtimeRoot, 'corrupt')
  const corruptSessionId = 'session-corrupt'
  const corruptPath = join(corruptRoot, `${createHash('sha256').update(corruptSessionId).digest('hex')}.json`)
  await mkdir(corruptRoot, { recursive: true })
  await writeFile(corruptPath, '{broken', 'utf8')
  const corruptStore = new BrowserControllerStore({
    ctx,
    storageRoot: corruptRoot,
    config: {
      defaultMode: 'dsh-browser-tools',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => surface.register(agent, definitions),
    suspendRuntime: async () => {},
    releaseRuntime: async () => {},
    isOwnedTool: name => owned.some(value => value.name === name),
  })
  const corruptAgent = fakeAgent(corruptSessionId, surface)
  corruptStore.attach(corruptAgent)
  await corruptAgent.preStep?.()
  const corrupt = corruptStore.snapshot(corruptSessionId)
  assert(corrupt.mode === 'other' && corrupt.status === 'inactive', '损坏持久状态没有安全回退到 other')
  assert(corrupt.error?.includes('持久状态损坏或不可读') === true, '损坏持久状态没有暴露可诊断错误')
  assert(surface.schemas(corruptAgent).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', '损坏持久状态错误抢占了第三方同名工具')
  assert(await readFile(corruptPath, 'utf8') === '{broken', '损坏持久文件被自动覆盖')
  await corruptStore.detach(corruptAgent)
  assert(corruptAgent.preStep === undefined, '损坏状态 Session detach 后监听没有解除')

  // 激活失败必须撤销已经注册的本插件工具，并保持第三方工具面原样。
  const failingStore = new BrowserControllerStore({
    ctx,
    storageRoot: join(runtimeRoot, 'failing'),
    config: {
      defaultMode: 'other',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => {
      const dispose = surface.register(agent, definitions)
      dispose()
      throw new Error('registration-failed')
    },
    suspendRuntime: async () => {},
    releaseRuntime: async () => {},
    isOwnedTool: name => owned.some(value => value.name === name),
  })
  const failingAgent = fakeAgent('session-failing', surface)
  failingStore.attach(failingAgent)
  await failingAgent.preStep?.()
  await failingStore.activate('session-failing').then(
    () => { throw new Error('激活失败测试没有抛出错误') },
    () => {},
  )
  assert(failingStore.snapshot('session-failing').mode === 'other', '激活失败后模式没有回滚到 other')
  assert(surface.schemas(failingAgent).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', '激活失败后第三方工具面未恢复')

  // 安全退出失败时必须保持 active 和 scoped 工具，允许用户继续解除阻断。
  const unsafeStore = new BrowserControllerStore({
    ctx,
    storageRoot: join(runtimeRoot, 'unsafe'),
    config: {
      defaultMode: 'other',
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools: (agent, definitions) => surface.register(agent, definitions),
    suspendRuntime: async () => { throw new Error('debugger-resume-failed') },
    releaseRuntime: async () => {},
    isOwnedTool: name => owned.some(value => value.name === name),
  })
  const unsafeAgent = fakeAgent('session-unsafe', surface)
  unsafeStore.attach(unsafeAgent)
  await unsafeAgent.preStep?.()
  await unsafeStore.activate('session-unsafe')
  await unsafeStore.deactivate('session-unsafe').then(
    () => { throw new Error('安全退出失败测试没有抛出错误') },
    () => {},
  )
  const unsafe = unsafeStore.snapshot('session-unsafe')
  assert(unsafe.status === 'active' && unsafe.mode === 'dsh-browser-tools', '安全退出失败后没有保持 active')
  assert(surface.schemas(unsafeAgent).find(value => value.name === 'browser_snapshot')?.description === 'dsh-browser-tools-snapshot', '安全退出失败后本插件工具被错误注销')

  // 插件卸载/HMR 必须无条件撤销 scoped 副作用和监听，即使控制器此前因安全退出失败仍保持 active。
  await unsafeStore.dispose()
  assert(unsafeAgent.preStep === undefined, 'Store Dispose 后 pre-step 监听没有解除')
  assert(surface.schemas(unsafeAgent).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', 'Store Dispose 后第三方同名工具没有恢复')
  assert(surface.schemas(unsafeAgent).some(value => value.name === 'browser_auth'), 'Store Dispose 后第三方独有工具没有恢复')
  assert((surface.guards.get(unsafeAgent)?.size ?? 0) === 0, 'Store Dispose 后 guard 仍然残留')
  assert(unsafeStore.identity('session-unsafe') === undefined, 'Store Dispose 后 Controller Identity 仍然残留')

  await store.dispose()
  await failingStore.dispose()

  process.stdout.write(`${JSON.stringify({
    ok: true,
    shadowed: active.shadowedTools,
    restricted: active.restrictedTools,
    secondSessionUnaffected: true,
    suspendPreservedPages: suspended.length === 1,
    releaseCalled: released.length === 1,
    activationRollback: true,
    deactivationFailureRetainedOwnership: true,
    coldRestorePreservedGeneration: restored.generation === 7,
    corruptStateFailedClosed: corrupt.mode === 'other',
    agentReplacementSafe: replaced.status === 'active',
    agentDisposeClean: recoveryAgent.preStep === undefined,
    hmrDisposeClean: unsafeAgent.preStep === undefined,
    persistedGeneration: persisted.generation,
  }, null, 2)}\n`)
} finally {
  await rm(runtimeRoot, { recursive: true, force: true })
  const runtimeParent = join(process.cwd(), '.runtime')
  // Controller 专项只负责自己的运行目录；父目录确认为空时一并删除，避免公开卫生误判，同时不影响其他并行测试。
  const remaining = await readdir(runtimeParent).catch(() => undefined)
  if (remaining?.length === 0) await rmdir(runtimeParent)
}
