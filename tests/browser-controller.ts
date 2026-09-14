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
    this.restrictions.set(agent, new Set(deny))
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

function createStore(
  root: string,
  surface: FakeToolSurface,
  owned: readonly ToolDefinition[],
  released: string[] = [],
  registerTools: (agent: Agent, definitions: readonly ToolDefinition[]) => () => void =
    (agent, definitions) => surface.register(agent, definitions),
): BrowserControllerStore {
  const ctx = { tools: { schemas: (agent?: Agent) => surface.schemas(agent) } } as unknown as Context
  return new BrowserControllerStore({
    ctx,
    storageRoot: root,
    config: {
      conflictingToolPatterns: ['^browser_'],
      includeTools: [],
      excludeTools: [],
    },
    toolDefinitions: owned,
    registerTools,
    releaseRuntime: async sessionId => { released.push(sessionId) },
    isOwnedTool: name => owned.some(value => value.name === name),
  })
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

  // 新 Session 尚未选择时，当前 Agent Scope 暂时看不到浏览器工具；普通工具继续可用。
  const released: string[] = []
  const store = createStore(runtimeRoot, surface, owned, released)
  const browserScopeAgent = fakeAgent('session-browser-scope', surface)
  const otherAgent = fakeAgent('session-other', surface)
  const siblingAgent = fakeAgent('session-sibling', surface)
  store.attach(browserScopeAgent)
  store.attach(otherAgent)
  store.attach(siblingAgent)
  await browserScopeAgent.preStep?.()
  await otherAgent.preStep?.()
  await siblingAgent.preStep?.()

  const initial = store.snapshot('session-browser-scope')
  assert(initial.mode === 'unselected' && initial.selectionLocked === false, '新 Session 应处于尚未选择状态')
  assert(!surface.schemas(browserScopeAgent).some(value => value.name.startsWith('browser_')), '尚未选择时不应暴露浏览器工具')
  assert(surface.schemas(browserScopeAgent).some(value => value.name === 'read'), '尚未选择时不应影响普通工具')

  // 选择 BrowserScope 后永久锁定：本插件工具可用，第三方浏览器工具只在当前 Session 隐藏。
  const active = await store.activate('session-browser-scope')
  assert(active.status === 'active' && active.mode === 'dsh-browser-tools', '选择 BrowserScope 后状态不正确')
  assert(active.selectionLocked === true && active.generation === 1, 'BrowserScope 选择没有永久锁定')
  assert(surface.schemas(browserScopeAgent).find(value => value.name === 'browser_snapshot')?.description === 'dsh-browser-tools-snapshot', '本插件同名工具没有接管当前 Session')
  assert(!surface.schemas(browserScopeAgent).some(value => value.name === 'browser_auth'), '第三方独有浏览器工具没有在当前 Session 隐藏')
  assert(surface.schemas(siblingAgent).find(value => value.name === 'browser_snapshot')?.description === undefined, '尚未选择的兄弟 Session 不应提前暴露第三方浏览器工具')

  await store.selectOther('session-browser-scope').then(
    () => { throw new Error('已选择 BrowserScope 的 Session 错误允许改选其他工具') },
    error => { assert(String(error).includes('新建 Session'), '改选拒绝没有给出新建 Session 指引') },
  )

  // 释放资源只关闭 BrowserScope 自己的浏览器状态，不解除工具锁定，也不恢复第三方工具。
  const releasedSnapshot = await store.release('session-browser-scope')
  assert(releasedSnapshot.status === 'active' && releasedSnapshot.mode === 'dsh-browser-tools', '释放资源后错误解除 BrowserScope 锁定')
  assert(releasedSnapshot.generation === 1, '释放资源不应改变浏览器选择代际')
  assert(released.join(',') === 'session-browser-scope', '释放资源没有调用 Runtime 清理')
  assert(surface.schemas(browserScopeAgent).find(value => value.name === 'browser_snapshot')?.description === 'dsh-browser-tools-snapshot', '释放资源后本插件工具没有保留')
  assert(!surface.schemas(browserScopeAgent).some(value => value.name === 'browser_auth'), '释放资源后错误恢复第三方浏览器工具')

  // 选择其他浏览器工具后永久锁定：撤销选择门，第三方工具恢复，BrowserScope 永久保持退出。
  const selectedOther = await store.selectOther('session-other')
  assert(selectedOther.mode === 'other' && selectedOther.selectionLocked === true, '选择其他浏览器工具后没有永久锁定')
  assert(selectedOther.generation === 1, '选择其他浏览器工具没有递增代际')
  assert(surface.schemas(otherAgent).find(value => value.name === 'browser_snapshot')?.description === 'third-party-snapshot', '选择其他工具后第三方同名工具没有恢复')
  assert(surface.schemas(otherAgent).some(value => value.name === 'browser_auth'), '选择其他工具后第三方独有工具没有恢复')
  await store.activate('session-other').then(
    () => { throw new Error('已选择其他工具的 Session 错误允许启用 BrowserScope') },
    error => { assert(String(error).includes('新建 Session'), 'BrowserScope 改选拒绝没有给出新建 Session 指引') },
  )

  const persistedFiles = await readdir(runtimeRoot)
  assert(persistedFiles.filter(name => name.endsWith('.json')).length === 2, '两个已选择 Session 应各有一份持久记录')
  const browserScopePath = join(runtimeRoot, `${createHash('sha256').update('session-browser-scope').digest('hex')}.json`)
  const otherPath = join(runtimeRoot, `${createHash('sha256').update('session-other').digest('hex')}.json`)
  const persistedBrowserScope = JSON.parse(await readFile(browserScopePath, 'utf8')) as { schemaVersion?: number; mode?: string; generation?: number }
  const persistedOther = JSON.parse(await readFile(otherPath, 'utf8')) as { schemaVersion?: number; mode?: string; generation?: number }
  assert(persistedBrowserScope.schemaVersion === 2 && persistedBrowserScope.mode === 'dsh-browser-tools' && persistedBrowserScope.generation === 1, 'BrowserScope 锁定记录不正确')
  assert(persistedOther.schemaVersion === 2 && persistedOther.mode === 'other' && persistedOther.generation === 1, '其他浏览器工具锁定记录不正确')

  // DSH 重启或 Agent Scope 替换后继续恢复原选择，不允许重新选择。
  await store.detach(browserScopeAgent)
  const restoredBrowserScopeAgent = fakeAgent('session-browser-scope', surface)
  store.attach(restoredBrowserScopeAgent)
  await restoredBrowserScopeAgent.preStep?.()
  const restoredBrowserScope = store.snapshot('session-browser-scope')
  assert(restoredBrowserScope.mode === 'dsh-browser-tools' && restoredBrowserScope.status === 'active', '重启后没有恢复 BrowserScope 锁定')
  assert(restoredBrowserScope.generation === 1, '重启恢复不应改变选择代际')

  await store.detach(otherAgent)
  const restoredOtherAgent = fakeAgent('session-other', surface)
  store.attach(restoredOtherAgent)
  await restoredOtherAgent.preStep?.()
  const restoredOther = store.snapshot('session-other')
  assert(restoredOther.mode === 'other' && restoredOther.selectionLocked === true, '重启后没有恢复其他工具锁定')
  assert(surface.schemas(restoredOtherAgent).some(value => value.name === 'browser_auth'), '重启后第三方浏览器工具没有恢复')

  // 旧版 other 只代表当时未启用 BrowserScope，迁移时必须回到尚未选择，避免误锁死。
  const legacyOtherRoot = join(runtimeRoot, 'legacy-other')
  const legacyOtherSession = 'legacy-other-session'
  const legacyOtherPath = join(legacyOtherRoot, `${createHash('sha256').update(legacyOtherSession).digest('hex')}.json`)
  await mkdir(legacyOtherRoot, { recursive: true })
  await writeFile(legacyOtherPath, `${JSON.stringify({ schemaVersion: 1, mode: 'other', generation: 7, updatedAt: 1 }, null, 2)}\n`, 'utf8')
  const legacyOtherStore = createStore(legacyOtherRoot, surface, owned)
  const legacyOtherAgent = fakeAgent(legacyOtherSession, surface)
  legacyOtherStore.attach(legacyOtherAgent)
  await legacyOtherAgent.preStep?.()
  const migratedOther = legacyOtherStore.snapshot(legacyOtherSession)
  assert(migratedOther.mode === 'unselected' && migratedOther.selectionLocked === false, '旧 other 状态没有迁移为尚未选择')
  assert(!surface.schemas(legacyOtherAgent).some(value => value.name.startsWith('browser_')), '旧 other 迁移后没有应用选择门')
  const migratedOtherRecord = JSON.parse(await readFile(legacyOtherPath, 'utf8')) as { schemaVersion?: number; mode?: string; generation?: number }
  assert(migratedOtherRecord.schemaVersion === 2 && migratedOtherRecord.mode === 'unselected' && migratedOtherRecord.generation === 7, '旧 other 迁移结果没有写回 schema v2')

  // 旧版 BrowserScope 激活状态继续恢复为 BrowserScope 锁定。
  const legacyBrowserScopeRoot = join(runtimeRoot, 'legacy-browser-scope')
  const legacyBrowserScopeSession = 'legacy-browser-scope-session'
  const legacyBrowserScopePath = join(legacyBrowserScopeRoot, `${createHash('sha256').update(legacyBrowserScopeSession).digest('hex')}.json`)
  await mkdir(legacyBrowserScopeRoot, { recursive: true })
  await writeFile(legacyBrowserScopePath, `${JSON.stringify({ schemaVersion: 1, mode: 'dsh-browser-tools', generation: 9, updatedAt: 1 }, null, 2)}\n`, 'utf8')
  const legacyBrowserScopeStore = createStore(legacyBrowserScopeRoot, surface, owned)
  const legacyBrowserScopeAgent = fakeAgent(legacyBrowserScopeSession, surface)
  legacyBrowserScopeStore.attach(legacyBrowserScopeAgent)
  await legacyBrowserScopeAgent.preStep?.()
  const migratedBrowserScope = legacyBrowserScopeStore.snapshot(legacyBrowserScopeSession)
  assert(migratedBrowserScope.mode === 'dsh-browser-tools' && migratedBrowserScope.status === 'active', '旧 BrowserScope 状态没有继续锁定')
  assert(migratedBrowserScope.generation === 9, '旧 BrowserScope 状态迁移错误改变代际')
  const migratedBrowserScopeRecord = JSON.parse(await readFile(legacyBrowserScopePath, 'utf8')) as { schemaVersion?: number; mode?: string; generation?: number }
  assert(migratedBrowserScopeRecord.schemaVersion === 2 && migratedBrowserScopeRecord.mode === 'dsh-browser-tools' && migratedBrowserScopeRecord.generation === 9, '旧 BrowserScope 迁移结果没有写回 schema v2')

  // 首次选择的持久化失败必须完整回滚，不能消耗 generation 或暴露浏览器工具。
  const failedSelectionRoot = join(runtimeRoot, 'selection-persist-blocked')
  await writeFile(failedSelectionRoot, 'not-a-directory', 'utf8')
  const failedSelectionStore = createStore(failedSelectionRoot, surface, owned)
  const failedSelectionSession = 'selection-persist-failed-session'
  const failedSelectionAgent = fakeAgent(failedSelectionSession, surface)
  failedSelectionStore.attach(failedSelectionAgent)
  await failedSelectionAgent.preStep?.()
  await failedSelectionStore.activate(failedSelectionSession).then(
    () => { throw new Error('持久化失败时错误完成了 BrowserScope 选择') },
    () => undefined,
  )
  const failedSelection = failedSelectionStore.snapshot(failedSelectionSession)
  assert(failedSelection.mode === 'unselected' && failedSelection.status === 'error', '持久化失败后没有回到尚未选择')
  assert(failedSelection.generation === 0 && failedSelection.selectionLocked === false, '持久化失败错误消耗了选择代际')
  assert(!surface.schemas(failedSelectionAgent).some(value => value.name.startsWith('browser_')), '持久化失败后浏览器工具被错误暴露')

  const failedOtherRoot = join(runtimeRoot, 'other-persist-blocked')
  await writeFile(failedOtherRoot, 'not-a-directory', 'utf8')
  const failedOtherStore = createStore(failedOtherRoot, surface, owned)
  const failedOtherSession = 'other-persist-failed-session'
  const failedOtherAgent = fakeAgent(failedOtherSession, surface)
  failedOtherStore.attach(failedOtherAgent)
  await failedOtherAgent.preStep?.()
  await failedOtherStore.selectOther(failedOtherSession).then(
    () => { throw new Error('持久化失败时错误完成了其他浏览器工具选择') },
    () => undefined,
  )
  const failedOther = failedOtherStore.snapshot(failedOtherSession)
  assert(failedOther.mode === 'unselected' && failedOther.status === 'error', '其他工具持久化失败后没有回到尚未选择')
  assert(failedOther.generation === 0 && failedOther.selectionLocked === false, '其他工具持久化失败错误消耗了选择代际')
  assert(!surface.schemas(failedOtherAgent).some(value => value.name.startsWith('browser_')), '其他工具持久化失败后浏览器工具被错误暴露')

  // 已持久锁定 BrowserScope 的 Session 即使恢复工具面失败，也不能降级成可改选状态。
  const failedRestoreRoot = join(runtimeRoot, 'restore-failed')
  const failedRestoreSession = 'restore-failed-session'
  const failedRestorePath = join(failedRestoreRoot, `${createHash('sha256').update(failedRestoreSession).digest('hex')}.json`)
  await mkdir(failedRestoreRoot, { recursive: true })
  await writeFile(failedRestorePath, `${JSON.stringify({ schemaVersion: 2, mode: 'dsh-browser-tools', generation: 11, updatedAt: 1 }, null, 2)}\n`, 'utf8')
  const failedRestoreStore = createStore(
    failedRestoreRoot,
    surface,
    owned,
    [],
    () => { throw new Error('owned-tool-registration-failed') },
  )
  const failedRestoreAgent = fakeAgent(failedRestoreSession, surface)
  failedRestoreStore.attach(failedRestoreAgent)
  await failedRestoreAgent.preStep?.()
  const failedRestore = failedRestoreStore.snapshot(failedRestoreSession)
  assert(failedRestore.mode === 'dsh-browser-tools' && failedRestore.status === 'error', 'BrowserScope 恢复失败后错误解除持久锁定')
  assert(failedRestore.selectionLocked === true && failedRestore.generation === 11, 'BrowserScope 恢复失败后锁定身份不正确')
  assert(!surface.schemas(failedRestoreAgent).some(value => value.name.startsWith('browser_')), 'BrowserScope 恢复失败后暴露了第三方浏览器工具')
  surface.globals.set('browser_late_provider', definition('browser_late_provider', 'late-third-party'))
  await failedRestoreAgent.preStep?.()
  assert(!surface.schemas(failedRestoreAgent).some(value => value.name === 'browser_late_provider'), '恢复失败状态没有阻止后加载的第三方浏览器工具')

  // 损坏记录保持尚未选择，不能自动启用任何浏览器工具。
  const corruptRoot = join(runtimeRoot, 'corrupt')
  const corruptSession = 'corrupt-session'
  const corruptPath = join(corruptRoot, `${createHash('sha256').update(corruptSession).digest('hex')}.json`)
  await mkdir(corruptRoot, { recursive: true })
  await writeFile(corruptPath, '{broken', 'utf8')
  const corruptStore = createStore(corruptRoot, surface, owned)
  const corruptAgent = fakeAgent(corruptSession, surface)
  corruptStore.attach(corruptAgent)
  await corruptAgent.preStep?.()
  const corrupt = corruptStore.snapshot(corruptSession)
  assert(corrupt.mode === 'unselected' && corrupt.selectionLocked === false, '损坏记录没有保持尚未选择')
  assert(corrupt.error?.includes('需要重新选择') === true, '损坏记录没有给出重新选择提示')

  await store.dispose()
  await legacyOtherStore.dispose()
  await legacyBrowserScopeStore.dispose()
  await failedSelectionStore.dispose()
  await failedOtherStore.dispose()
  await failedRestoreStore.dispose()
  await corruptStore.dispose()

  process.stdout.write(`${JSON.stringify({
    ok: true,
    unselectedToolsHidden: true,
    browserScopeLocked: true,
    otherToolsLocked: true,
    releasePreservedSelection: true,
    restartPreservedSelection: true,
    legacyOtherMigratedToUnselected: true,
    legacyBrowserScopePreserved: true,
    migrationPersistedAsSchemaV2: true,
    failedSelectionRolledBack: true,
    failedOtherSelectionRolledBack: true,
    failedRestorePreservedLock: true,
    corruptStateRequiresSelection: true,
  }, null, 2)}\n`)
} finally {
  await rm(runtimeRoot, { recursive: true, force: true })
  const runtimeParent = join(process.cwd(), '.runtime')
  const remaining = await readdir(runtimeParent).catch(() => undefined)
  if (remaining?.length === 0) await rmdir(runtimeParent)
}
