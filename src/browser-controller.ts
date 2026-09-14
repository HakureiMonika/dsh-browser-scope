import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export type BrowserControllerMode = 'unselected' | 'other' | 'dsh-browser-tools'
export type BrowserControllerStatus = 'inactive' | 'activating' | 'active' | 'releasing' | 'error'

export interface BrowserControllerConfig {
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
  selectionLocked: boolean
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
  schemaVersion: 2
  mode: BrowserControllerMode
  generation: number
  updatedAt: number
  // 仅供读取阶段标记旧记录；写回磁盘时始终生成纯 schema v2 数据。
  needsMigration?: boolean
}

interface PersistedControllerStateInput {
  // JSON 文件属于外部输入，先使用宽类型读取，再由 readPersisted() 逐项验证并收窄。
  schemaVersion?: unknown
  mode?: unknown
  generation?: unknown
  updatedAt?: unknown
}

export interface BrowserControllerStoreOptions {
  ctx: Context
  storageRoot: string
  config: BrowserControllerConfig
  toolDefinitions: readonly ToolDefinition[]
  registerTools(agent: Agent, definitions: readonly ToolDefinition[]): () => void
  releaseRuntime(sessionId: string, sessionCreatedAt: number): Promise<void>
  isOwnedTool(name: string): boolean
}

function controllerFileName(sessionId: string): string {
  // 持久化文件名只使用 Session ID 的摘要，避免在插件数据目录中直接暴露完整会话标识。
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

function controllerNotice(mode: BrowserControllerMode): string {
  if (mode === 'dsh-browser-tools') {
    return '当前 Session 已选择 DSH BrowserScope，并且不能在本 Session 中改用其他浏览器插件。其他浏览器工具已从本 Session 的模型工具面隐藏。需要使用其他浏览器插件时，请新建 Session。'
  }
  if (mode === 'other') {
    return '当前 Session 已选择其他浏览器工具，并且不能在本 Session 中改用 DSH BrowserScope。需要使用 BrowserScope 时，请新建 Session。'
  }
  return '当前 Session 尚未选择浏览器工具。请先在浏览器菜单中选择 DSH BrowserScope 或其他浏览器工具。'
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
        mode: 'unselected',
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
      const value = JSON.parse(await readFile(this.storagePath(sessionId), 'utf8')) as PersistedControllerStateInput
      if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0) return null
      const generation = Number(value.generation)
      const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
      if (value.schemaVersion === 2 && (value.mode === 'unselected' || value.mode === 'other' || value.mode === 'dsh-browser-tools')) {
        return { schemaVersion: 2, mode: value.mode, generation, updatedAt }
      }
      if (value.schemaVersion === 1 && (value.mode === 'other' || value.mode === 'dsh-browser-tools')) {
        // 旧 other 只表示当时没有启用 BrowserScope，不能证明用户已经永久选择其他插件；
        // 因此迁移为尚未选择。旧 BrowserScope 激活状态则继续锁定 BrowserScope。
        return {
          schemaVersion: 2,
          mode: value.mode === 'dsh-browser-tools' ? 'dsh-browser-tools' : 'unselected',
          generation,
          updatedAt,
          needsMigration: true,
        }
      }
      return null
    } catch (error) {
      // 文件不存在表示这是第一次选择；损坏或不可读时保持尚未选择，禁止自动启用任何浏览器工具。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return null
    }
  }

  private async persist(state: SessionControllerState): Promise<void> {
    await mkdir(this.options.storageRoot, { recursive: true })
    const target = this.storagePath(state.sessionId)
    const temporary = `${target}.${randomUUID()}.tmp`
    const value: PersistedControllerState = {
      schemaVersion: 2,
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

  private applySelectionGate(state: SessionControllerState, agent: Agent): void {
    // 尚未选择浏览器插件时，当前 Agent Scope 暂时隐藏所有识别到的浏览器工具。
    // 用户完成首次选择后会立即撤销这层限制，再建立所选工具面；第三方插件本身不被修改。
    this.cleanupScopedEffects(state, agent)
    const conflicts = this.classifyConflicts(agent)
    state.conflictingTools = conflicts.conflictingTools
    state.shadowedTools = []
    state.restrictedTools = conflicts.conflictingTools
    if (state.restrictedTools.length > 0) {
      state.restrictionDisposer = agent.ctx.tools.restrict({ deny: state.restrictedTools })
    }
  }

  private refreshBrowserScopeRestrictions(state: SessionControllerState, agent: Agent): void {
    // 第三方浏览器插件可能在当前 Session 已锁定 BrowserScope 后热加载。
    // 这里只重建当前 Agent Scope 的限制，不注销 BrowserScope 工具，也不修改第三方插件本身。
    try { state.restrictionDisposer?.() } catch {}
    state.restrictionDisposer = undefined
    const conflicts = this.classifyConflicts(agent)
    state.conflictingTools = conflicts.conflictingTools
    state.shadowedTools = conflicts.shadowedTools
    state.restrictedTools = conflicts.restrictedTools
    if (state.restrictedTools.length > 0) {
      state.restrictionDisposer = agent.ctx.tools.restrict({ deny: state.restrictedTools })
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
          summary: mode === 'dsh-browser-tools' ? '已选择 DSH BrowserScope' : mode === 'other' ? '已选择其他浏览器工具' : '尚未选择浏览器工具',
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
        state.mode = 'unselected'
        state.status = 'inactive'
        state.error = '浏览器选择记录损坏或不可读。当前 Session 需要重新选择浏览器工具。'
        this.applySelectionGate(state, agent)
        return
      }
      state.generation = persisted?.generation ?? state.generation
      state.mode = persisted?.mode ?? 'unselected'
      // 只有损坏记录或本次恢复失败才保留错误；有效记录和首次创建应清除旧 Agent Scope 遗留的错误投影。
      state.error = undefined
      if (persisted?.needsMigration === true) {
        // 迁移结果先写成 schema v2，再建立对应工具面；下次启动不应重复解释旧语义。
        await this.persist(state)
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
      }
      if (state.mode === 'dsh-browser-tools') {
        await this.activateInternal(state, agent, false, true, bindingGeneration)
      } else if (state.mode === 'unselected') {
        this.applySelectionGate(state, agent)
      } else {
        // 已永久选择其他浏览器工具时不施加任何限制，BrowserScope 保持退出。
        this.cleanupScopedEffects(state, agent)
        state.status = 'inactive'
      }
    }).catch(error => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) return
      const browserScopeLocked = state.mode === 'dsh-browser-tools'
      this.cleanupScopedEffects(state, agent)
      // 恢复异常不能暴露任意浏览器工具；已有 BrowserScope 选择继续锁定，其他情况回到尚未选择。
      state.mode = browserScopeLocked ? 'dsh-browser-tools' : 'unselected'
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      this.applySelectionGate(state, agent)
    })

    // 每个模型 Step 前都确认当前 Session 的选择已经恢复，并吸收后加载的浏览器工具。
    // 尚未选择时继续阻止任何浏览器工具抢先执行；已选 BrowserScope 时继续隐藏第三方浏览器工具。
    state.preStepDisposer = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      await state.restore
      if (state.agent === agent && state.bindingGeneration === bindingGeneration) {
        if (state.mode === 'unselected') this.applySelectionGate(state, agent)
        else if (state.mode === 'dsh-browser-tools' && state.status === 'active') this.refreshBrowserScopeRestrictions(state, agent)
        else if (state.mode === 'dsh-browser-tools' && state.status === 'error') {
          // 已锁定 BrowserScope 但恢复失败时仍要吸收后加载的第三方浏览器工具，禁止错误状态形成绕过窗口。
          this.applySelectionGate(state, agent)
        }
      }
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
    if (state.status === 'activating' || state.status === 'releasing') blockers.push('controller-transition')
    return {
      mode: state.mode,
      status: state.status,
      generation: state.generation,
      conflictingTools: [...state.conflictingTools],
      shadowedTools: [...state.shadowedTools],
      restrictedTools: [...state.restrictedTools],
      selectionLocked: state.mode !== 'unselected',
      canSwitchNow: state.mode === 'unselected' && blockers.length === 0,
      blockers,
      ...(state.error === undefined ? {} : { error: state.error }),
    }
  }

  async activate(sessionId: string): Promise<BrowserControllerSnapshot> {
    const state = this.state(sessionId)
    await state.restore
    const agent = state.agent
    const bindingGeneration = state.bindingGeneration
    if (agent === undefined) throw new Error('当前 Session 没有可用 Agent，无法选择浏览器工具。')
    await this.queue(state, async () => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
      if (state.mode !== 'unselected') throw new Error('当前 Session 已经选择浏览器工具。需要改用其他浏览器插件时，请新建 Session。')
      await agent.whenIdle()
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
      await agent.runMaintenance(async () => {
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
        await this.activateInternal(state, agent, true, false, bindingGeneration)
      })
    })
    return this.snapshot(sessionId)
  }

  private async activateInternal(state: SessionControllerState, agent: Agent, notify: boolean, restoring = false, expectedBinding = state.bindingGeneration): Promise<void> {
    if (state.agent !== agent || state.bindingGeneration !== expectedBinding) throw new Error('当前 Session 的 Agent Scope 已更新，旧 Scope 不得注册浏览器工具。')
    if (state.status === 'active') return
    if (!restoring && state.mode !== 'unselected') throw new Error('当前 Session 已经选择浏览器工具。需要改用其他浏览器插件时，请新建 Session。')
    if (state.status === 'activating' || state.status === 'releasing') throw new Error('浏览器选择正在处理，请等待当前操作完成。')
    state.status = 'activating'
    state.error = undefined
    const previousGeneration = state.generation
    // 撤销“尚未选择”阶段的临时限制，再基于完整第三方工具面计算接管范围。
    this.cleanupScopedEffects(state, agent)
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
        if (state.status === 'releasing' && this.options.isOwnedTool(exec.name)) return 'DSH BrowserScope 正在释放浏览器资源，新的浏览器工具调用已拒绝。'
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
      state.generation = previousGeneration
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      if (restoring) {
        // 磁盘记录已经锁定 BrowserScope；恢复失败不能把 Session 降级成可改选状态。
        // 保留锁定模式并隐藏第三方浏览器工具，等待插件重新加载或环境修复后再次恢复。
        state.mode = 'dsh-browser-tools'
        this.applySelectionGate(state, agent)
      } else {
        // 首次选择尚未成功提交，允许用户修复问题后重新选择。
        state.mode = 'unselected'
        this.applySelectionGate(state, agent)
      }
      throw error
    }
  }

  async selectOther(sessionId: string): Promise<BrowserControllerSnapshot> {
    const state = this.state(sessionId)
    await state.restore
    const agent = state.agent
    const bindingGeneration = state.bindingGeneration
    if (agent === undefined) throw new Error('当前 Session 没有可用 Agent，无法选择浏览器工具。')
    await this.queue(state, async () => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
      if (state.mode !== 'unselected') throw new Error('当前 Session 已经选择浏览器工具。需要改用其他浏览器插件时，请新建 Session。')
      await agent.whenIdle()
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
      await agent.runMaintenance(async () => {
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试浏览器选择。')
        this.cleanupScopedEffects(state, agent)
        const conflicts = this.classifyConflicts(agent)
        if (conflicts.conflictingTools.length === 0) {
          // “其他浏览器工具”必须对应当前 Profile 中真实存在的第三方工具；没有可选工具时恢复选择门并拒绝锁定。
          this.applySelectionGate(state, agent)
          throw new Error('当前 Profile 没有检测到其他浏览器工具，不能选择此项。')
        }
        const previousGeneration = state.generation
        state.mode = 'other'
        state.status = 'inactive'
        state.error = undefined
        state.generation += 1
        state.conflictingTools = conflicts.conflictingTools
        state.shadowedTools = []
        state.restrictedTools = []
        try {
          await this.persist(state)
          await this.notify(agent, state.mode)
        } catch (error) {
          state.generation = previousGeneration
          state.mode = 'unselected'
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
          this.applySelectionGate(state, agent)
          throw error
        }
      })
    })
    return this.snapshot(sessionId)
  }

  async release(sessionId: string): Promise<BrowserControllerSnapshot> {
    const state = this.state(sessionId)
    await state.restore
    const agent = state.agent
    const bindingGeneration = state.bindingGeneration
    if (agent === undefined) throw new Error('当前 Session 没有可用 Agent，无法释放浏览器资源。')
    await this.queue(state, async () => {
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试资源释放。')
      if (state.mode !== 'dsh-browser-tools' || state.status !== 'active') throw new Error('当前 Session 没有正在使用的 BrowserScope 资源。')
      await agent.whenIdle()
      if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试资源释放。')
      await agent.runMaintenance(async () => {
        if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，请在新 Scope 上重试资源释放。')
        state.status = 'releasing'
        state.error = undefined
        try {
          await this.options.releaseRuntime(sessionId, agent.session.header.createdAt)
          if (state.agent !== agent || state.bindingGeneration !== bindingGeneration) throw new Error('当前 Session 的 Agent Scope 已更新，旧 Scope 不得完成资源释放。')
          // 只释放 BrowserScope 自己的页面和浏览器资源。工具选择、同名遮蔽和第三方限制继续保留，
          // 这样同一个 Session 之后仍只能使用 BrowserScope，不会混入另一套浏览器状态。
          state.status = 'active'
          state.activatedAt = undefined
          try {
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: '当前 Session 的 BrowserScope 浏览器资源已释放。浏览器工具选择仍保持锁定；后续再次调用 BrowserScope 工具时会创建新的 BrowserScope 页面。需要使用其他浏览器插件时，请新建 Session。' }],
              source: { kind: 'plugin', plugin: 'dsh-browser-scope', form: 'notice', summary: '已释放 BrowserScope 浏览器资源' },
            }))
          } catch {}
        } catch (error) {
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
