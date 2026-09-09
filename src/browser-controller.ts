import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export type BrowserControllerMode = 'other' | 'dsh-browser-tools'
export type BrowserControllerStatus = 'inactive' | 'activating' | 'active' | 'deactivating' | 'error'

export interface BrowserControllerConfig {
  defaultMode: BrowserControllerMode
  conflictingToolPatterns: string[]
  includeTools: string[]
  excludeTools: string[]
}

export interface BrowserControllerSnapshot {
  mode: BrowserControllerMode
  status: BrowserControllerStatus
  generation: number
  conflictingTools: string[]
  shadowedTools: string[]
  restrictedTools: string[]
  canSwitchNow: boolean
  blockers: string[]
  error?: string
}

interface SessionControllerState {
  sessionId: string
  mode: BrowserControllerMode
  status: BrowserControllerStatus
  generation: number
  activatedAt?: number
  conflictingTools: string[]
  shadowedTools: string[]
  restrictedTools: string[]
  error?: string
  agent?: Agent
  bindingGeneration: number
  toolDisposer?: () => void
  restrictionDisposer?: () => void
  guardDisposer?: () => void
  preStepDisposer?: () => void
  queue: Promise<void>
  restore?: Promise<void>
}

interface PersistedControllerState {
  schemaVersion: 1
  mode: BrowserControllerMode
  generation: number
  updatedAt: number
}

export interface BrowserControllerStoreOptions {
  ctx: Context
  storageRoot: string
  config: BrowserControllerConfig
  toolDefinitions: readonly ToolDefinition[]
  registerTools(agent: Agent, definitions: readonly ToolDefinition[]): () => void
  suspendRuntime(sessionId: string): Promise<void>
  releaseRuntime(sessionId: string, sessionCreatedAt: number): Promise<void>
  isOwnedTool(name: string): boolean
}

function controllerFileName(sessionId: string): string {
  // 持久化文件名只使用 Session ID 的摘要，避免在插件数据目录中直接暴露完整会话标识。
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

function controllerNotice(mode: BrowserControllerMode): string {
  if (mode === 'dsh-browser-tools') {
    return '当前 Session 已启用 DSH BrowserScope。其他浏览器控制工具已从本 Session 的模型工具面隐藏。此前由其他插件生成的 ref、标签和页面状态不可继续使用，请从 browser_tabs/browser_snapshot 重新建立状态。'
  }
  return '当前 Session 已退出 DSH BrowserScope。不要继续使用此前的 viewId、ref、Checkpoint、Debug Session 或 Recorder 状态；其他浏览器工具将在后续 Agent Step 中按其插件配置可用。'
}

export class BrowserControllerStore {
  private readonly options: BrowserControllerStoreOptions
  private readonly states = new Map<string, SessionControllerState>()
  private readonly patterns: RegExp[]
  private readonly ownedToolNames: ReadonlySet<string>

  constructor(options: BrowserControllerStoreOptions) {
    this.options = options
    this.patterns = options.config.conflictingToolPatterns.map(pattern => new RegExp(pattern))
    this.ownedToolNames = new Set(options.toolDefinitions.map(definition => definition.name))
  }

  private storagePath(sessionId: string): string {
    return join(this.options.storageRoot, controllerFileName(sessionId))
  }

  private state(sessionId: string): SessionControllerState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        mode: this.options.config.defaultMode,
        status: 'inactive',
        generation: 0,
        conflictingTools: [],
        shadowedTools: [],
        restrictedTools: [],
        bindingGeneration: 0,
        queue: Promise.resolve(),
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  private async readPersisted(sessionId: string): Promise<PersistedControllerState | null | undefined> {
    try {
      const value = JSON.parse(await readFile(this.storagePath(sessionId), 'utf8')) as Partial<PersistedControllerState>
      if (value.schemaVersion !== 1
        || (value.mode !== 'other' && value.mode !== 'dsh-browser-tools')
        || !Number.isSafeInteger(value.generation)
        || Number(value.generation) < 0) return null
      return {
        schemaVersion: 1,
        mode: value.mode,
        generation: Number(value.generation),
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      }
    } catch (error) {
      // 文件尚不存在表示 Session 首次使用，应采用配置的 defaultMode；损坏、权限或其他读取错误
      // 必须以 null 显式失败关闭到 other，不能因 defaultMode 为本插件而意外抢占第三方工具面。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return null
    }
  }

  private async persist(state: SessionControllerState): Promise<void> {
    await mkdir(this.options.storageRoot, { recursive: true })
    const target = this.storagePath(state.sessionId)
    const temporary = `${target}.${randomUUID()}.tmp`
    const value: PersistedControllerState = {
      schemaVersion: 1,
      mode: state.mode,
      generation: state.generation,
      updatedAt: Date.now(),
    }
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  private classifyConflicts(agent: Agent): { conflictingTools: string[]; shadowedTools: string[]; restrictedTools: string[] } {
    const visibleNames = this.options.ctx.tools.schemas(agent).map(schema => schema.name)
    const excluded = new Set(this.options.config.excludeTools)
    const included = new Set(this.options.config.includeTools)
    const conflictingTools = visibleNames.filter(name => {
      if (excluded.has(name)) return false
      return included.has(name) || this.patterns.some(pattern => pattern.test(name))
    })
    const shadowedTools = conflictingTools.filter(name => this.ownedToolNames.has(name))
    const restrictedTools = conflictingTools.filter(name => !this.ownedToolNames.has(name))
    return {
      conflictingTools: [...new Set(conflictingTools)].sort(),
      shadowedTools: [...new Set(shadowedTools)].sort(),
      restrictedTools: [...new Set(restrictedTools)].sort(),
    }
  }

  private queue(state: SessionControllerState, task: () => Promise<void>): Promise<void> {
    const result = state.queue.then(task, task)
    state.queue = result.catch(() => {})
    return result
  }

  private cleanupScopedEffects(state: SessionControllerState, expectedAgent?: Agent): void {
    // 异步 detach 或维护任务可能晚于同 Session 的新 Agent attach 完成；只有 disposer
    // 所属 Agent 仍是当前绑定者时才允许清理，防止旧生命周期误删新 Scope 的工具和 restriction。
    if (expectedAgent !== undefined && state.agent !== expectedAgent) return
    // Agent-scoped 副作用必须按 restriction → tools → guard 的逆依赖顺序释放；
    // 每个 disposer 都独立收敛，避免某个第三方限制解除失败阻止本插件工具注销。
    try { state.restrictionDisposer?.() } catch {}
    state.restrictionDisposer = undefined
    try { state.toolDisposer?.() } catch {}
    state.toolDisposer = undefined
    try { state.guardDisposer?.() } catch {}
    state.guardDisposer = undefined
  }

  private async notify(agent: Agent, mode: BrowserControllerMode): Promise<void> {
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: controllerNotice(mode) }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-browser-scope',
          form: 'notice',
          summary: mode === 'dsh-browser-tools' ? '启用 DSH BrowserScope' : '退出 DSH BrowserScope',
        },
      }))
    } catch {}
  }

  attach(agent: Agent): void {
    const sessionId = String(agent.session.id)
    const state = this.state(sessionId)
    const previousAgent = state.agent
    // 同一 Agent 的重复 created 通知保持幂等，不能重跑持久恢复或重复注册 scoped 工具。
    if (previousAgent === agent) return
    // 同一 Session 的 Agent Scope 可能被 DSH 原地替换。先精确撤销旧 Scope 的副作用，
    // 再递增绑定代际；旧 restore、维护队列或 detach 在 await 后恢复时必须因代际过期停止写状态。
    try { state.preStepDisposer?.() } catch {}
    state.preStepDisposer = undefined
    if (previousAgent !== undefined && previousAgent !== agent) {
      this.cleanupScopedEffects(state, previousAgent)
      state.status = 'inactive'
      state.activatedAt = undefined
      state.conflictingTools = []
      state.shadowedTools = []
      state.restrictedTools = []
    }
    const bindingGeneration = ++state.bindingGeneration
    state.agent = agent
    // 新 Agent 的恢复必须排在旧 Agent 已提交的维护队列之后。这样旧激活即使正在持久化，
    // 新 Scope 也会在其收敛后读取最终模式，不会因提前读到 other 而与磁盘 active 分叉。
    const priorQueue = state.queue
    state.restore = priorQueue.catch(() => {}).then(() => this.readPersisted(sessionId)).then(async persisted => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
      if (persisted === null) {
        state.mode = 'other'
        state.status = 'inactive'
        state.error = '浏览器控制器持久状态损坏或不可读，已安全回退到 other。'
        return
      }
      state.generation = persisted?.generation ?? state.generation
      state.mode = persisted?.mode ?? this.options.config.defaultMode
      if (state.mode === 'dsh-browser-tools') await this.activateInternal(state, agent, false, true, bindingGeneration)
    }).catch(error => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
      state.mode = 'other'
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    })

    // 恢复中的 Session 在首次模型 Step 组装前等待 scoped 工具面完成，保证模型可见 Schema
    // 与持久模式一致；新建且默认 other 的 Session 只等待一次轻量文件读取。
    state.preStepDisposer = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      await state.restore
      return next()
    })
  }

  async detach(agent: Agent): Promise<void> {
    const sessionId = String(agent.session.id)
    const state = this.states.get(sessionId)
    if (state === undefined || state.agent !== agent) return
    const bindingGeneration = state.bindingGeneration
    // Agent 销毁后不应再进入恢复门；先解绑监听，再等待已经开始的恢复与维护任务完成。
    // 每个 await 后都重新核对绑定代际：同 Session 新 Agent 已接管时，旧 detach 必须停止，
    // 不能清除新 Agent 的 scoped 工具、Controller Identity 或状态索引。
    try { state.preStepDisposer?.() } catch {}
    state.preStepDisposer = undefined
    await state.restore?.catch(() => {})
    if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
    await state.queue.catch(() => {})
    if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
    this.cleanupScopedEffects(state, agent)
    state.agent = undefined
    state.restore = undefined
    this.states.delete(sessionId)
  }

  async waitUntilReady(sessionId: string): Promise<void> {
    // RPC 读取只等待已绑定 Agent 的冷恢复，不创建 Controller 状态或 Agent；
    // 用于防止 Client 在 agent/created 与持久模式恢复之间观察到瞬时 inactive。
    await this.states.get(sessionId)?.restore
  }

  isActive(sessionId: string): boolean {
    return this.states.get(sessionId)?.status === 'active'
  }

  identity(sessionId: string): { id: 'dsh-browser-tools'; generation: number; registrationMode: 'session-select' } | undefined {
    const state = this.states.get(sessionId)
    if (state?.status !== 'active') return undefined
    return {
      id: 'dsh-browser-tools',
      generation: state.generation,
      registrationMode: 'session-select',
    }
  }

  ownsExecution(sessionId: string | undefined, toolName: string): boolean {
    return sessionId !== undefined
      && this.isActive(sessionId)
      && this.options.isOwnedTool(toolName)
  }

  snapshot(sessionId: string): BrowserControllerSnapshot {
    const state = this.state(sessionId)
    const blockers = state.agent?.status === 'running' ? ['agent-running'] : []
    if (state.status === 'activating' || state.status === 'deactivating') blockers.push('controller-transition')
    return {
      mode: state.mode,
      status: state.status,
      generation: state.generation,
      conflictingTools: [...state.conflictingTools],
      shadowedTools: [...state.shadowedTools],
      restrictedTools: [...state.restrictedTools],
      canSwitchNow: blockers.length === 0,
      blockers,
      ...(state.error === undefined ? {} : { error: state.error }),
    }
  }

  async activate(sessionId: string): Promise<BrowserControllerSnapshot> {
    const state = this.state(sessionId)
    await state.restore
    const agent = state.agent
    const bindingGeneration = state.bindingGeneration
    if (agent === undefined) throw new Error('当前 Session 没有可用 Agent，无法切换浏览器控制器。')
    await this.queue(state, async () => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
      await agent.whenIdle()
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
      await agent.runMaintenance(async () => {
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
        await this.activateInternal(state, agent, true, false, bindingGeneration)
      })
    })
    return this.snapshot(sessionId)
  }

  private async activateInternal(state: SessionControllerState, agent: Agent, notify: boolean, restoring = false, expectedBinding = state.bindingGeneration): Promise<void> {
    if (state.agent !== agent || state.bindingGeneration !== expectedBinding) throw new Error('当前 Session 的 Agent Scope 已更新，旧 Scope 不得注册浏览器工具。')
    if (state.status === 'active') return
    if (state.status === 'activating' || state.status === 'deactivating') throw new Error('浏览器控制器正在切换，请等待当前操作完成。')
    state.status = 'activating'
    state.error = undefined
    const conflicts = this.classifyConflicts(agent)
    state.conflictingTools = conflicts.conflictingTools
    state.shadowedTools = conflicts.shadowedTools
    state.restrictedTools = conflicts.restrictedTools
    try {
      // 先注册本插件同名工具形成 Agent 层遮蔽，再限制第三方独有工具；任一阶段失败
      // 都会撤销本次全部 scoped 副作用，确保第三方原工具面保持原状。
      state.toolDisposer = this.options.registerTools(agent, this.options.toolDefinitions)
      if (state.restrictedTools.length > 0) {
        state.restrictionDisposer = agent.ctx.tools.restrict({ deny: state.restrictedTools })
      }
      state.guardDisposer = agent.ctx.tools.guard(exec => {
        if (state.status === 'deactivating' && this.options.isOwnedTool(exec.name)) return 'DSH BrowserScope 正在退出，新的浏览器工具调用已拒绝。'
        return undefined
      })
      state.mode = 'dsh-browser-tools'
      state.status = 'active'
      state.activatedAt = Date.now()
      if (!restoring) {
        state.generation += 1
        await this.persist(state)
      }
      if (state.agent !== agent || state.bindingGeneration !== expectedBinding) throw new Error('当前 Session 的 Agent Scope 已更新，旧 Scope 不得完成控制器激活。')
      if (notify) await this.notify(agent, state.mode)
    } catch (error) {
      if (state.agent !== agent || state.bindingGeneration !== expectedBinding) throw error
      this.cleanupScopedEffects(state, agent)
      state.mode = 'other'
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async deactivate(sessionId: string, release = false): Promise<BrowserControllerSnapshot> {
    const state = this.state(sessionId)
    await state.restore
    const agent = state.agent
    const bindingGeneration = state.bindingGeneration
    if (agent === undefined) throw new Error('当前 Session 没有可用 Agent，无法切换浏览器控制器。')
    await this.queue(state, async () => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
      await agent.whenIdle()
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
      await agent.runMaintenance(async () => {
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试控制器切换。')
        if (state.status !== 'active') return
        state.status = 'deactivating'
        state.error = undefined
        try {
          if (release) await this.options.releaseRuntime(sessionId, agent.session.header.createdAt)
          else await this.options.suspendRuntime(sessionId)
          if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，旧 Scope 不得完成控制器退出。')
          this.cleanupScopedEffects(state, agent)
          state.mode = 'other'
          state.status = 'inactive'
          state.activatedAt = undefined
          state.generation += 1
          state.conflictingTools = []
          state.shadowedTools = []
          state.restrictedTools = []
          await this.persist(state)
          await this.notify(agent, state.mode)
        } catch (error) {
          // 安全收敛失败时，只有仍持有当前绑定的 Agent 才能恢复 active；旧 Agent 已被替换时
          // 不得覆盖新 Scope 的恢复结果或所有权。
          if (state.agent === agent && state.bindingGeneration === bindingGeneration) {
            state.status = 'active'
            state.error = error instanceof Error ? error.message : String(error)
          }
          throw error
        }
      })
    })
    return this.snapshot(sessionId)
  }

  async dispose(): Promise<void> {
    for (const state of this.states.values()) {
      // 插件卸载/HMR 时先移除所有 Agent 监听，防止旧 Store 在新实例加载后继续参与 Step。
      try { state.preStepDisposer?.() } catch {}
      state.preStepDisposer = undefined
      await state.restore?.catch(() => {})
      await state.queue.catch(() => {})
      this.cleanupScopedEffects(state)
      state.agent = undefined
    }
    this.states.clear()
  }
}
