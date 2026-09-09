import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BrowserError } from './errors.ts'
import { registerLoopbackRpc } from './dsh-compat.ts'
import { resolveConfig } from './policy.ts'
import { BrowserControllerStore } from './browser-controller.ts'
import type { BrowserControllerSnapshot } from './browser-controller.ts'
import { BrowserRuntime } from './runtime.ts'
import type { Config as BrowserConfig, Identity, ToolOutput } from './types.ts'
import type { BrowserDebuggerAction, BrowserDebuggerInput, BrowserDiagnoseAction, BrowserDiagnoseInput, BrowserEmulateAction, BrowserEmulateInput, BrowserEvaluateAction, BrowserEvaluateInput, BrowserExtensionAction, BrowserExtensionInput, BrowserInputTraceUpdate, BrowserLiveViewAction, BrowserLiveViewInput, BrowserNetworkAction, BrowserNetworkInput, BrowserPanelTabAction, BrowserPanelTabInput, BrowserPanelView, BrowserProfileAction, BrowserProfileInput, BrowserProviderAction, BrowserProviderInput, BrowserRecorderAction, BrowserRecorderInput, BrowserSplitViewAction, BrowserSplitViewInput, BrowserTakeoverAction, BrowserTakeoverInput, BrowserUserInput } from './protocol.ts'

export const name = 'dsh-browser-scope'
export const inject = ['tools', 'attachments', 'agents', 'sessions']

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: HostConnectionHandle
  }
}

export const Config: z<BrowserConfig> = z.object({
  executablePath: z.string(),
  headless: z.boolean().default(true),
  allowedOrigins: z.array(z.string()).default([]),
  allowLoopback: z.boolean().default(true),
  allowPrivateNetwork: z.boolean().default(true),
  uploadRoots: z.array(z.string()).default([]),
  artifactRoot: z.string(),
  maxUploadBytes: z.number().step(1).min(1).default(25 * 1024 * 1024),
  maxDownloadBytes: z.number().step(1).min(1).default(100 * 1024 * 1024),
  maxArtifactBytes: z.number().step(1).min(1).default(256 * 1024 * 1024),
  maxOutputChars: z.number().step(1).min(1000).default(12000),
  interceptionTimeoutMs: z.number().step(1).min(1000).default(15000),
  externalCdpTimeoutMs: z.number().step(1).min(1000).default(15000),
  chromiumDownloadSource: z.union(['auto', 'npmmirror', 'official']).default('auto'),
  chromiumDownloadTimeoutMs: z.number().step(1).min(1000).default(300000),
  subagentInteractive: z.boolean().default(false),
  sharedProfileSeedSessionId: z.string(),
  toolRegistrationMode: z.union(['global', 'session-select']).default('global'),
  sessionController: z.object({
    defaultMode: z.union(['other', 'dsh-browser-tools']).default('other'),
    conflictingToolPatterns: z.array(z.string()).default(['^browser_', '^chrome_', '^pilot_', '^mcp__playwright__', '^mcp__chrome_devtools__']),
    excludeTools: z.array(z.string()).default([]),
    includeTools: z.array(z.string()).default([]),
  }).default({
    defaultMode: 'other',
    conflictingToolPatterns: ['^browser_', '^chrome_', '^pilot_', '^mcp__playwright__', '^mcp__chrome_devtools__'],
    excludeTools: [],
    includeTools: [],
  }),
})

const outputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    action: { type: 'string' as const, required: true as const },
    viewId: { type: 'string' as const },
    data: { type: 'json' as const },
  },
} satisfies ValueSchemaSpec

function identity(exec: ToolRunContext): Identity {
  const session = exec.agent?.session
  if (session === undefined) throw new BrowserError('browser tools require a DSH agent session', 'AGENT_REQUIRED')
  return {
    sessionId: String(session.id),
    sessionCreatedAt: session.header.createdAt,
    callId: String(exec.callId),
    rootCallId: String(exec.rootCallId),
    toolName: exec.name,
  }
}

function render(_args: unknown, value: ToolOutput) {
  // DSH会持久化render文本；ToolOutput本身已经包含动作、成功状态和活动View，避免再拼一行重复摘要。
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

const debuggerActions: BrowserDebuggerAction[] = ['attach', 'detach', 'pause', 'resume', 'step_over', 'step_into', 'step_out', 'call_frames', 'scripts', 'script_source', 'source_map', 'scope_variables', 'set_breakpoint', 'remove_breakpoint']
const diagnoseActions: BrowserDiagnoseAction[] = ['start', 'status', 'inspect', 'checkpoint', 'compare', 'report', 'stop', 'recorder_status', 'recorder_start', 'recorder_pause', 'recorder_resume', 'recorder_clear', 'recorder_stop', 'recorder_mark', 'recorder_complete', 'recorder_timeline']
const recorderActions: BrowserRecorderAction[] = ['status', 'start', 'pause', 'resume', 'clear', 'stop', 'mark', 'complete']
const networkActions: BrowserNetworkAction[] = ['enable', 'disable', 'list_paused', 'continue', 'abort', 'fulfill', 'body', 'replay']
const verificationGuidance = 'If the page shows CAPTCHA, human verification, SMS or email verification codes, Passkey/WebAuthn, device confirmation, or another security challenge, stop automated interaction immediately, do not bypass or submit the challenge, tell the user what is visible, and request human takeover.'
const profileActions: BrowserProfileAction[] = ['trace_start', 'trace_stop', 'playwright_trace_start', 'playwright_trace_stop', 'cpu_start', 'cpu_stop', 'coverage_start', 'coverage_stop', 'heap_snapshot', 'heap_sampling_start', 'heap_sampling_stop', 'artifacts', 'artifact_read']
const emulateActions: BrowserEmulateAction[] = ['viewport', 'device', 'locale', 'timezone', 'network', 'cpu', 'offline', 'permissions', 'reset']
const evaluateActions: BrowserEvaluateAction[] = ['isolated', 'main_world', 'paused_frame']
const providerActions: BrowserProviderAction[] = ['list', 'connect', 'disconnect', 'capabilities']
const extensionActions: BrowserExtensionAction[] = ['list', 'install', 'enable', 'disable', 'uninstall', 'apply', 'open_popup', 'close_popup']
const takeoverActions: BrowserTakeoverAction[] = ['status', 'request', 'return', 'cancel']
const liveViewActions: BrowserLiveViewAction[] = ['status', 'standard', 'adaptive', 'initialize', 'resize']
const splitViewActions: BrowserSplitViewAction[] = ['status', 'open', 'close', 'swap', 'assign', 'focus', 'ratio', 'resize']
const panelTabActions: BrowserPanelTabAction[] = ['new', 'select', 'close', 'back', 'forward', 'reload', 'navigate']
const panelViews: BrowserPanelView[] = ['live', 'diagnostic', 'console', 'network', 'debugger', 'performance', 'provider', 'extensions', 'emulation']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcSuccess(value: unknown) {
  return { ok: true as const, value }
}

function rpcFailure(message: string) {
  return { ok: false as const, error: { code: 'internal' as const, message, details: {} } }
}

const definitionCollectors = new WeakMap<Context, ToolDefinition[]>()

function tool<const P extends ParameterSchemaSpec>(
  ctx: Context,
  options: {
    name: string
    description: string
    parameters: P
    execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<ToolOutput>
  },
): void {
  const definitions = definitionCollectors.get(ctx)
  if (definitions === undefined) throw new Error('browser tool definitions can only be created during plugin apply')
  definitions.push(defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: outputSchema, render },
    execute: options.execute,
  }))
}

function registerToolDefinitions(ctx: Context, definitions: readonly ToolDefinition[]): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register(definition))
  } catch (error) {
    // 工具集必须原子注册；任一名称冲突或 Schema 失败时按逆序撤销，禁止留下半套浏览器工具。
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}

export function apply(ctx: Context, config: BrowserConfig): void {
  const resolved = resolveConfig(config)
  const runtime = new BrowserRuntime(resolved, ctx.attachments)
  const definitions: ToolDefinition[] = []
  // 每个插件实例按自身 Context 收集同一套工具 Definition；global 与 session-select
  // 只决定后续注册位置，不允许在定义阶段产生工具面副作用。
  definitionCollectors.set(ctx, definitions)
  let controller: BrowserControllerStore | undefined
  ctx.inject(['connection'], (connectionCtx) => {
    registerLoopbackRpc(connectionCtx.connection, '/browser-tools', async (endpoint, payload) => {
      try {
        if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.trim() === '') return rpcFailure('browser panel requires a non-empty sessionId')
        const sessionId = payload.sessionId
        if (endpoint === 'controller_status') {
          await controller?.waitUntilReady(sessionId)
          const value: BrowserControllerSnapshot & { registrationMode: 'global' | 'session-select' } = resolved.toolRegistrationMode === 'global'
            ? {
                registrationMode: 'global',
                mode: 'dsh-browser-tools',
                status: 'active',
                generation: 0,
                conflictingTools: [],
                shadowedTools: [],
                restrictedTools: [],
                canSwitchNow: false,
                blockers: ['global-registration-mode'],
              }
            : {
                registrationMode: 'session-select',
                ...(controller?.snapshot(sessionId) ?? {
                  mode: 'other',
                  status: 'inactive',
                  generation: 0,
                  conflictingTools: [],
                  shadowedTools: [],
                  restrictedTools: [],
                  canSwitchNow: false,
                  blockers: ['controller-not-ready'],
                }),
              }
          return rpcSuccess(value)
        }
        if (endpoint === 'controller_activate' || endpoint === 'controller_deactivate' || endpoint === 'controller_release') {
          if (resolved.toolRegistrationMode !== 'session-select' || controller === undefined) return rpcFailure('Session controller selection requires toolRegistrationMode=session-select')
          const agent = ctx.agents.get(SessionId(sessionId))
          if (agent === undefined) return rpcFailure('browser controller requires a live DSH agent session')
          if (agent.session.header.origin === 'subagent') return rpcFailure('delegated sessions cannot switch browser controllers')
          const result = endpoint === 'controller_activate'
            ? await controller.activate(sessionId)
            : await controller.deactivate(sessionId, endpoint === 'controller_release')
          return rpcSuccess({ registrationMode: 'session-select', ...result })
        }
        await controller?.waitUntilReady(sessionId)
        if (resolved.toolRegistrationMode === 'session-select' && controller?.isActive(sessionId) !== true) {
          // 未选择本插件时只保留轻量 Controller RPC；禁止面板 Snapshot、标签、输入和调试接口
          // 隐式创建 BrowserContext，从而保证 other 模式不消耗浏览器资源也不改变第三方状态。
          return rpcFailure('当前 Session 尚未启用 DSH BrowserScope')
        }
        if (endpoint === 'snapshot') {
          const view = payload.view
          if (typeof view !== 'string' || !panelViews.includes(view as BrowserPanelView)) return rpcFailure('unknown browser panel view')
          const streamGeneration = typeof payload.streamGeneration === 'number' ? payload.streamGeneration : undefined
          const sequence = typeof payload.sequence === 'number' ? payload.sequence : undefined
          const splitCursors = isRecord(payload.splitCursors) ? payload.splitCursors as unknown as Parameters<BrowserRuntime['panelSnapshot']>[4] : undefined
          const popupCursor = isRecord(payload.popupCursor) ? payload.popupCursor as unknown as Parameters<BrowserRuntime['panelSnapshot']>[5] : undefined
          const diagnosticReadSequence = typeof payload.diagnosticReadSequence === 'number' ? payload.diagnosticReadSequence : undefined
          return rpcSuccess(await runtime.panelSnapshot(sessionId, view as BrowserPanelView, streamGeneration, sequence, splitCursors, popupCursor, diagnosticReadSequence))
        }
        if (endpoint === 'tabs') {
          if (typeof payload.action !== 'string' || !panelTabActions.includes(payload.action as BrowserPanelTabAction)) return rpcFailure('unknown browser panel tab action')
          const agent = payload.notifyAgent === true && payload.action === 'select' ? ctx.agents.get(SessionId(sessionId)) : undefined
          const session = ctx.sessions.get(SessionId(sessionId))
          const result = await runtime.panelTabs(sessionId, {
            action: payload.action as BrowserPanelTabAction,
            ...(typeof payload.viewId === 'string' ? { viewId: payload.viewId } : {}),
            ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
            ...(payload.notifyAgent === true ? { notifyAgent: true } : {}),
          } satisfies BrowserPanelTabInput, session?.header.createdAt)
          if (agent !== undefined && ctx.agents.get(SessionId(sessionId)) === agent && result.ok && isRecord(result.data) && result.data.changed === true && typeof result.viewId === 'string') {
            const title = typeof result.data.title === 'string' && result.data.title !== '' ? result.data.title : '无标题页'
            const url = typeof result.data.url === 'string' ? result.data.url : 'about:blank'
            try {
              agent.inject(createUserMessage({
                content: [{ type: 'text', text: `用户已在右侧浏览器中切换活动标签。当前活动标签 viewId=${result.viewId}，标题为“${title}”，URL 为 ${url}。后续浏览器观察和操作请以该标签为准，并在需要精确定位元素时重新获取快照。` }],
                source: { kind: 'plugin', plugin: name, form: 'notice', summary: `用户切换浏览器标签：${title}` },
              }))
            } catch {}
          }
          return rpcSuccess(result)
        }
        if (endpoint === 'debugger') {
          if (typeof payload.action !== 'string' || !debuggerActions.includes(payload.action as BrowserDebuggerAction)) return rpcFailure('unknown browser debugger action')
          const result = await runtime.panelDebugger(sessionId, {
            action: payload.action as BrowserDebuggerAction,
            ...(typeof payload.viewId === 'string' ? { viewId: payload.viewId } : {}),
            ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
            ...(typeof payload.lineNumber === 'number' ? { lineNumber: payload.lineNumber } : {}),
            ...(typeof payload.columnNumber === 'number' ? { columnNumber: payload.columnNumber } : {}),
            ...(typeof payload.breakpointId === 'string' ? { breakpointId: payload.breakpointId } : {}),
            ...(typeof payload.callFrameId === 'string' ? { callFrameId: payload.callFrameId } : {}),
            ...(typeof payload.scopeNumber === 'number' ? { scopeNumber: payload.scopeNumber } : {}),
            ...(typeof payload.scriptId === 'string' ? { scriptId: payload.scriptId } : {}),
          })
          return rpcSuccess(result)
        }
        if (endpoint === 'takeover') {
          if (typeof payload.action !== 'string' || !takeoverActions.includes(payload.action as BrowserTakeoverAction)) return rpcFailure('unknown browser takeover action')
          return rpcSuccess(await runtime.panelTakeover(sessionId, {
            action: payload.action as BrowserTakeoverAction,
            ...(typeof payload.viewId === 'string' ? { viewId: payload.viewId } : {}),
          }))
        }
        if (endpoint === 'network') {
          if (typeof payload.action !== 'string' || !networkActions.includes(payload.action as BrowserNetworkAction)) return rpcFailure('unknown browser network action')
          return rpcSuccess(await runtime.panelNetwork(sessionId, payload as unknown as BrowserNetworkInput))
        }
        if (endpoint === 'profile') {
          if (typeof payload.action !== 'string' || !profileActions.includes(payload.action as BrowserProfileAction)) return rpcFailure('unknown browser profile action')
          return rpcSuccess(await runtime.panelProfile(sessionId, payload as unknown as BrowserProfileInput))
        }
        if (endpoint === 'provider') {
          if (typeof payload.action !== 'string' || !providerActions.includes(payload.action as BrowserProviderAction)) return rpcFailure('unknown browser provider action')
          return rpcSuccess(await runtime.panelProvider(sessionId, payload as unknown as BrowserProviderInput))
        }
        if (endpoint === 'emulate') {
          if (typeof payload.action !== 'string' || !emulateActions.includes(payload.action as BrowserEmulateAction)) return rpcFailure('unknown browser emulation action')
          return rpcSuccess(await runtime.panelEmulate(sessionId, payload as unknown as BrowserEmulateInput))
        }
        if (endpoint === 'live_view') {
          if (typeof payload.action !== 'string' || !liveViewActions.includes(payload.action as BrowserLiveViewAction)) return rpcFailure('unknown browser live view action')
          const agent = payload.notifyAgent === true ? ctx.agents.get(SessionId(sessionId)) : undefined
          const result = await runtime.panelLiveView(sessionId, payload as unknown as BrowserLiveViewInput)
          if (agent !== undefined && ctx.agents.get(SessionId(sessionId)) === agent && result.ok && isRecord(result.data) && result.data.changed === true && (payload.action === 'standard' || payload.action === 'adaptive')) {
            const mode = payload.action === 'standard' ? '标准比例' : '自适应比例'
            try {
              agent.inject(createUserMessage({
                content: [{ type: 'text', text: `用户已将右侧浏览器实况切换为${mode}模式。标准模式固定为 1280×720 并优先保证页面元素完整；自适应模式会让真实浏览器 Viewport 跟随右侧区域，以减少黑边并方便人工观察与操作。请基于当前模式继续工作。` }],
                source: { kind: 'plugin', plugin: name, form: 'notice', summary: `用户将浏览器实况切换为${mode}模式` },
              }))
            } catch {}
          }
          return rpcSuccess(result)
        }
        if (endpoint === 'split_view') {
          if (typeof payload.action !== 'string' || !splitViewActions.includes(payload.action as BrowserSplitViewAction)) return rpcFailure('unknown browser split view action')
          const agent = payload.notifyAgent === true ? ctx.agents.get(SessionId(sessionId)) : undefined
          const result = await runtime.panelSplitView(sessionId, payload as unknown as BrowserSplitViewInput)
          if (agent !== undefined && ctx.agents.get(SessionId(sessionId)) === agent && result.ok && isRecord(result.data) && result.data.changed === true) {
            try {
              agent.inject(createUserMessage({
                content: [{ type: 'text', text: `用户已调整右侧浏览器上下双页分屏。当前状态：${result.data.enabled === true ? `已开启，上方占比 ${Math.round(Number(result.data.ratio) * 100)}%` : '已关闭'}；当前焦点标签 viewId=${result.viewId ?? 'none'}。后续未显式提供 viewId 的浏览器工具将操作当前焦点标签。` }],
                source: { kind: 'plugin', plugin: name, form: 'notice', summary: '用户调整浏览器上下分屏' },
              }))
            } catch {}
          }
          return rpcSuccess(result)
        }
        if (endpoint === 'extensions') {
          if (typeof payload.action !== 'string' || !extensionActions.includes(payload.action as BrowserExtensionAction)) return rpcFailure('unknown browser extension action')
          return rpcSuccess(await runtime.panelExtensions(sessionId, payload as unknown as BrowserExtensionInput))
        }
        if (endpoint === 'input') {
          if (typeof payload.viewId !== 'string' || payload.viewId.trim() === '') return rpcFailure('browser input requires viewId from the current live snapshot')
          if (typeof payload.streamGeneration !== 'number' || !Number.isInteger(payload.streamGeneration) || payload.streamGeneration < 1) return rpcFailure('browser input requires a positive streamGeneration')
          if (typeof payload.frameSequence !== 'number' || !Number.isInteger(payload.frameSequence) || payload.frameSequence < 1) return rpcFailure('browser input requires a positive frameSequence')
          if (typeof payload.viewportGeneration !== 'number' || !Number.isInteger(payload.viewportGeneration) || payload.viewportGeneration < 0) return rpcFailure('browser input requires a non-negative viewportGeneration')
          if (payload.inputTraceId !== undefined && (typeof payload.inputTraceId !== 'string' || payload.inputTraceId.trim() === '')) return rpcFailure('browser input inputTraceId must be a non-empty string')
          if (payload.clientRawAt !== undefined && (typeof payload.clientRawAt !== 'number' || !Number.isFinite(payload.clientRawAt))) return rpcFailure('browser input clientRawAt must be finite')
          if (payload.clientNormalizedAt !== undefined && (typeof payload.clientNormalizedAt !== 'number' || !Number.isFinite(payload.clientNormalizedAt))) return rpcFailure('browser input clientNormalizedAt must be finite')
          if (payload.action === 'mouse_click' || payload.action === 'mouse_down' || payload.action === 'mouse_move' || payload.action === 'mouse_up') {
            if (typeof payload.x !== 'number' || !Number.isFinite(payload.x) || typeof payload.y !== 'number' || !Number.isFinite(payload.y)) return rpcFailure(`${payload.action} requires finite x and y`)
          } else if (payload.action === 'mouse_wheel') {
            if (typeof payload.x !== 'number' || !Number.isFinite(payload.x) || typeof payload.y !== 'number' || !Number.isFinite(payload.y) || typeof payload.deltaX !== 'number' || !Number.isFinite(payload.deltaX) || typeof payload.deltaY !== 'number' || !Number.isFinite(payload.deltaY)) return rpcFailure('mouse_wheel requires finite coordinates and deltas')
          } else if (payload.action === 'key_press') {
            if (typeof payload.key !== 'string' || payload.key === '') return rpcFailure('key_press requires key')
            if (payload.modifiers !== undefined && (!Array.isArray(payload.modifiers) || payload.modifiers.some(modifier => !['Control', 'Alt', 'Shift', 'Meta'].includes(String(modifier))))) return rpcFailure('key_press modifiers must contain only Control, Alt, Shift, or Meta')
          } else if (payload.action === 'insert_text' || payload.action === 'composition_commit') {
            if (typeof payload.text !== 'string') return rpcFailure(`${payload.action} requires text`)
            if (payload.action === 'composition_commit' && payload.text === '') return rpcFailure('composition_commit requires non-empty text')
          } else if (payload.action === 'paste') {
            if (payload.text !== undefined && typeof payload.text !== 'string') return rpcFailure('paste text must be a string')
            if (payload.html !== undefined && typeof payload.html !== 'string') return rpcFailure('paste html must be a string')
            if (payload.uriList !== undefined && typeof payload.uriList !== 'string') return rpcFailure('paste uriList must be a string')
            if (payload.files !== undefined && (!Array.isArray(payload.files) || payload.files.length > 8 || payload.files.some(file => !isRecord(file) || typeof file.name !== 'string' || typeof file.mediaType !== 'string' || typeof file.data !== 'string'))) return rpcFailure('paste files must contain at most eight valid encoded files')
          } else return rpcFailure('unknown browser input action')
          return rpcSuccess(await runtime.panelInput(sessionId, payload as unknown as BrowserUserInput))
        }
        if (endpoint === 'input_trace') {
          if (typeof payload.inputTraceId !== 'string' || payload.inputTraceId.trim() === '') return rpcFailure('browser input trace requires inputTraceId')
          if (typeof payload.viewId !== 'string' || payload.viewId.trim() === '') return rpcFailure('browser input trace requires viewId')
          if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp)) return rpcFailure('browser input trace timestamp must be finite')
          if (!['key-press', 'insert-text', 'paste', 'composition', 'pointer', 'wheel'].includes(String(payload.action))) return rpcFailure('browser input trace action is invalid')
          if (!['normal', 'potentially-sensitive', 'sensitive', 'security-challenge'].includes(String(payload.sensitivity))) return rpcFailure('browser input trace sensitivity is invalid')
          if (typeof payload.composing !== 'boolean') return rpcFailure('browser input trace composing must be boolean')
          if (!['client-raw', 'client-normalized', 'rpc-received', 'host-dispatched', 'dom-observed', 'final-state'].includes(String(payload.stage))) return rpcFailure('browser input trace stage is invalid')
          if (!['observed', 'delivered', 'prevented', 'lost', 'unknown'].includes(String(payload.outcome))) return rpcFailure('browser input trace outcome is invalid')
          if (payload.reason !== undefined && typeof payload.reason !== 'string') return rpcFailure('browser input trace reason must be a string')
          if (payload.characters !== undefined) {
            if (!isRecord(payload.characters)) return rpcFailure('browser input trace characters must be an object')
            for (const key of ['length', 'asciiLetters', 'digits', 'whitespace', 'punctuation', 'cjk', 'other']) {
              const value = payload.characters[key]
              if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return rpcFailure(`browser input trace characters.${key} must be a non-negative integer`)
            }
          }
          return rpcSuccess(await runtime.panelInputTrace(sessionId, payload as unknown as BrowserInputTraceUpdate))
        }
        if (endpoint === 'recorder') {
          if (typeof payload.action !== 'string' || !recorderActions.includes(payload.action as BrowserRecorderAction)) return rpcFailure('unknown browser recorder action')
          if (payload.mode !== undefined && payload.mode !== 'rolling' && payload.mode !== 'deep') return rpcFailure('browser recorder mode must be rolling or deep')
          return rpcSuccess(await runtime.panelRecorder(sessionId, {
            action: payload.action as BrowserRecorderAction,
            ...(payload.mode === 'rolling' || payload.mode === 'deep' ? { mode: payload.mode } : {}),
            ...(typeof payload.incidentId === 'string' ? { incidentId: payload.incidentId } : {}),
          } satisfies BrowserRecorderInput))
        }
        if (endpoint === 'close') {
          const view = payload.view
          if (typeof view !== 'string' || !panelViews.includes(view as BrowserPanelView)) return rpcFailure('unknown browser panel view')
          await runtime.panelClose(sessionId, view as BrowserPanelView)
          return rpcSuccess(null)
        }
        return rpcFailure(`unknown browser tools endpoint: ${endpoint}`)
      } catch (error) {
        return rpcFailure(error instanceof Error ? error.message : String(error))
      }
    })
  })
  ctx.effect(() => async () => runtime.dispose(), 'browser.dispose()')
  ctx.on('agent/disposed', ({ agent }) => {
    // 同一正式 Session 的 Agent Scope 可能由 DSH 原地替换。必须先让 Controller Store
    // 精确解除旧 Agent，再检查注册表；若新 Agent 已接管同一 Session，则保留 Runtime Session，
    // 避免旧 disposed 事件误关新 Scope 正在使用的 BrowserContext、页面和调试状态。
    void (async () => {
      await controller?.detach(agent)
      const sessionId = String(agent.session.id)
      const replacement = ctx.agents.get(SessionId(sessionId))
      if (replacement !== undefined && replacement !== agent) return
      await runtime.disposeSession({ sessionId, sessionCreatedAt: agent.session.header.createdAt })
    })().catch(() => {})
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
    const owned = definitions.some(definition => definition.name === exec.name)
      && (resolved.toolRegistrationMode === 'global' || controller?.ownsExecution(sessionId, exec.name) === true)
    // 第三方工具即使使用 browser_* 前缀，也不属于本插件的 Approval 与 Subagent 策略。
    if (!owned) return next()
    const child = exec.agent?.session.header.origin === 'subagent'
    const debuggerMutation = exec.name === 'browser_debugger' && isRecord(exec.arguments) && /^(detach|pause|resume|step_over|step_into|step_out|set_breakpoint|remove_breakpoint)$/.test(String(exec.arguments.action))
    const debuggerSensitiveRead = exec.name === 'browser_debugger' && isRecord(exec.arguments) && /^(script_source|source_map)$/.test(String(exec.arguments.action))
    const diagnoseSensitiveRead = exec.name === 'browser_diagnose' && isRecord(exec.arguments) && exec.arguments.action === 'report'
    const recorderMutation = exec.name === 'browser_diagnose' && isRecord(exec.arguments) && /^recorder_(start|pause|resume|clear|stop|mark|complete)$/.test(String(exec.arguments.action))
    const networkSensitive = exec.name === 'browser_network_control' && isRecord(exec.arguments) && exec.arguments.action !== 'list_paused'
    const profileSensitive = exec.name === 'browser_profile' && isRecord(exec.arguments) && exec.arguments.action !== 'artifacts'
    const providerMutation = exec.name === 'browser_provider' && isRecord(exec.arguments) && /^(connect|disconnect)$/.test(String(exec.arguments.action))
    const extensionMutation = exec.name === 'browser_extensions' && isRecord(exec.arguments) && exec.arguments.action !== 'list'
    const emulateMutation = exec.name === 'browser_emulate'
    const liveViewMutation = exec.name === 'browser_live_view' && isRecord(exec.arguments) && exec.arguments.action !== 'status'
    const splitViewMutation = exec.name === 'browser_split_view' && isRecord(exec.arguments) && exec.arguments.action !== 'status'
    // 隔离世界仍共享页面 DOM 并可发起网络请求，因此任意 JavaScript 求值都不能按只读能力放行。
    const evaluateSensitive = exec.name === 'browser_evaluate'
    const takeoverMutation = exec.name === 'browser_takeover' && isRecord(exec.arguments) && exec.arguments.action !== 'status'
    const v2Sensitive = debuggerSensitiveRead || diagnoseSensitiveRead || recorderMutation || networkSensitive || profileSensitive || providerMutation || extensionMutation || emulateMutation || evaluateSensitive || takeoverMutation
    // 空白页签不访问外部地址，继续免审批；携带非空 URL 的 new 与 browser_navigate 具有相同导航副作用。
    const tabNavigation = exec.name === 'browser_tabs' && isRecord(exec.arguments) && exec.arguments.action === 'new' && typeof exec.arguments.url === 'string' && exec.arguments.url.trim() !== '' && exec.arguments.url.trim() !== 'about:blank'
    // DSH 的公开 SessionEvent 联合暂未声明权限预设事件，但运行时会持久化该事件；这里仅建立局部只读视图，不修改原 Session 数据。
    const sessionEvents = (exec.agent?.session.events ?? []) as unknown as ReadonlyArray<{ type: string; data: Record<string, unknown> }>
    const permissionPreset = [...sessionEvents].reverse().find(event => event.type === 'permission/preset')?.data.preset
    if (child && !resolved.subagentInteractive && (exec.name === 'browser_diagnose' || debuggerMutation || liveViewMutation || splitViewMutation || v2Sensitive || /^(browser_click|browser_type|browser_press_key|browser_select_option|browser_upload_file|browser_download)$/.test(exec.name))) {
      return { kind: 'deny', reason: `delegated browser session cannot use ${exec.name}` }
    }
    if (child) return { kind: 'allow' }
    if (debuggerMutation || v2Sensitive || tabNavigation || /^(browser_navigate|browser_click|browser_type|browser_press_key|browser_select_option|browser_handle_dialog|browser_upload_file|browser_download)$/.test(exec.name)) {
      if (permissionPreset === 'danger-full-access') {
        // DSH Full access 使用 approval/policy=never 关闭审批提示；顶层插件工具必须在进入 Approval 前直接放行，否则 ask 会被无弹窗解释为用户拒绝。
        return { kind: 'allow' }
      }
      if (extensionMutation && isRecord(exec.arguments)) {
        const action = String(exec.arguments.action)
        const target = typeof exec.arguments.extension === 'string'
          ? exec.arguments.extension
          : typeof exec.arguments.extensionId === 'string'
            ? exec.arguments.extensionId
            : 'current Session extensions'
        const applyMode = exec.arguments.applyMode === 'now' ? 'immediately rebuild the browser' : 'apply on the next browser start'
        return { kind: 'ask', reason: `browser_extensions ${action} targets ${target} and will ${applyMode}` }
      }
      return { kind: 'ask', reason: `${exec.name} changes browser or host state` }
    }
    return { kind: 'allow' }
  })

  tool(ctx, {
    name: 'browser_tabs',
    description: 'Manage tabs in the current DSH session. action defaults to list. new without url, with an empty url, or with about:blank creates a blank tab. select and close accept either stable viewId or current list index.',
    parameters: {
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
      viewId: { type: 'string' },
      index: { type: 'integer' },
      url: { type: 'string' },
    },
    execute: (args, exec) => runtime.tabs(identity(exec), exec.signal, args as { action?: string; viewId?: string; index?: number; url?: string }),
  })
  tool(ctx, {
    name: 'browser_navigate',
    description: `Navigate the active managed tab, or viewId when provided, to a complete http/https URL after policy and approval checks. If the debugger paused the page, resume it first. ${verificationGuidance}`,
    parameters: { url: { type: 'string', required: true }, viewId: { type: 'string' }, timeoutMs: { type: 'integer' } },
    execute: (args, exec) => runtime.navigate(identity(exec), exec.signal, args as { url: string; viewId?: string; timeoutMs?: number }),
  })
  tool(ctx, {
    name: 'browser_navigate_back',
    description: 'Navigate the active managed tab, or viewId when provided, back in history.',
    parameters: { viewId: { type: 'string' }, timeoutMs: { type: 'integer' } },
    execute: (args, exec) => runtime.navigateBack(identity(exec), exec.signal, args as { viewId?: string; timeoutMs?: number }),
  })
  tool(ctx, {
    name: 'browser_snapshot',
    description: `Return a compact ARIA snapshot and refreshed short-lived element refs for the active tab, or viewId when provided. The first call after navigation returns full ARIA; later calls automatically return refreshed refs plus a bounded diff when that is smaller. Pass includeDiff=false to force a full snapshot. maxNodes defaults to 80 and is capped at 300. Take a new snapshot whenever a tool returns STALE_REF. ${verificationGuidance}`,
    parameters: { viewId: { type: 'string' }, includeDiff: { type: 'boolean' }, maxNodes: { type: 'integer' } },
    execute: (args, exec) => runtime.snapshot(identity(exec), exec.signal, args as { viewId?: string; includeDiff?: boolean; maxNodes?: number }),
  })

  const element = { ref: { type: 'string', required: true }, viewId: { type: 'string' }, timeoutMs: { type: 'integer' } } as const
  for (const [name, action, description] of [
    ['browser_click', 'click', `Click an element identified by a current browser snapshot or browser_query refs result. The result reports whether URL, document generation, or bounded DOM structure changed; changed=false means the event was dispatched but no immediate page change was observed, so take a new snapshot before retrying. ${verificationGuidance}`],
    ['browser_hover', 'hover', 'Hover an element identified by a current browser snapshot ref.'],
    ['browser_scroll', 'scroll', 'Scroll an element ref into view. For page scrolling omit ref and provide direction, amount, deltaX, or deltaY.'],
  ] as const) {
    const parameters = action === 'scroll'
      ? { ref: { type: 'string' }, viewId: { type: 'string' }, timeoutMs: { type: 'integer' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' }, deltaX: { type: 'integer' }, deltaY: { type: 'integer' } } as const
      : element
    tool(ctx, { name, description, parameters, execute: (args, exec) => runtime.elementAction(identity(exec), exec.signal, { ...(args as { ref?: string; viewId?: string; timeoutMs?: number; direction?: string; amount?: number; deltaX?: number; deltaY?: number }), action }) })
  }
  tool(ctx, {
    name: 'browser_type',
    description: `Type into an editable snapshot ref. clear defaults to true; submit presses Enter afterwards; slowly types with a short per-character delay. Never enter or submit a security verification challenge. ${verificationGuidance}`,
    parameters: { ...element, text: { type: 'string', required: true }, clear: { type: 'boolean' }, submit: { type: 'boolean' }, slowly: { type: 'boolean' } },
    execute: (args, exec) => runtime.elementAction(identity(exec), exec.signal, { ...(args as { ref: string; viewId?: string; timeoutMs?: number; text: string; clear?: boolean; submit?: boolean; slowly?: boolean }), action: 'type' }),
  })
  tool(ctx, {
    name: 'browser_press_key',
    description: `Press a keyboard key on the active page. Omit ref or pass an empty ref to target the current page focus; provide a non-empty ref only for one current snapshot element. ${verificationGuidance}`,
    parameters: { ref: { type: 'string' }, viewId: { type: 'string' }, timeoutMs: { type: 'integer' }, key: { type: 'string', required: true } },
    execute: (args, exec) => runtime.elementAction(identity(exec), exec.signal, { ...(args as { ref?: string; viewId?: string; timeoutMs?: number; key: string }), action: 'press_key' }),
  })
  tool(ctx, {
    name: 'browser_select_option',
    description: 'Select options on a select element identified by a current snapshot ref.',
    parameters: { ...element, values: { type: 'array', items: { type: 'string' }, required: true } },
    execute: (args, exec) => runtime.elementAction(identity(exec), exec.signal, { ...(args as { ref: string; viewId?: string; timeoutMs?: number; values: string[] }), action: 'select_option' }),
  })
  tool(ctx, {
    name: 'browser_wait_for',
    description: `Wait on the active tab for non-empty text, text disappearance, positive seconds, positive milliseconds, or a load state. Empty strings and zero time values are ignored. With no effective condition, waits for domcontentloaded. Do not provide both positive time and positive timeMs. ${verificationGuidance}`,
    parameters: { viewId: { type: 'string' }, text: { type: 'string' }, textGone: { type: 'string' }, state: { type: 'string', enum: ['visible', 'hidden', 'domcontentloaded', 'networkidle'] }, time: { type: 'number' }, timeMs: { type: 'integer' }, timeoutMs: { type: 'integer' } },
    execute: (args, exec) => runtime.waitFor(identity(exec), exec.signal, args as { viewId?: string; text?: string; textGone?: string; state?: string; time?: number; timeMs?: number; timeoutMs?: number }),
  })
  definitions.push(defineTool({
    name: 'browser_take_screenshot',
    description: 'Capture a PNG screenshot and save it through the DSH attachment store.',
    parameters: { viewId: { type: 'string' }, fullPage: { type: 'boolean' } },
    output: { schema: outputSchema, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: value.data as unknown as ImageAttachmentRef }] } },
    async execute(args, exec) { return runtime.screenshot(identity(exec), exec.signal, args) },
  }))
  tool(ctx, {
    name: 'browser_get_attribute',
    description: 'Read one non-sensitive attribute from an element ref.',
    parameters: { ref: { type: 'string', required: true }, name: { type: 'string', required: true }, viewId: { type: 'string' } },
    execute: (args, exec) => runtime.getAttribute(identity(exec), exec.signal, args as { ref: string; name: string; viewId?: string }),
  })
  tool(ctx, {
    name: 'browser_query',
    description: `Run a bounded selector query without executing page JavaScript supplied by the model. field=refs returns short-lived refs for visible named matches and invalidates older refs. frameId may target one attached same-origin Frame from browser_diagnose status; cross-origin and OOPIF element queries fail closed. ${verificationGuidance}`,
    parameters: { selector: { type: 'string', required: true }, field: { type: 'string', enum: ['count', 'text', 'visible', 'attribute', 'refs'], required: true }, attribute: { type: 'string' }, limit: { type: 'integer' }, viewId: { type: 'string' }, frameId: { type: 'string' } },
    execute: (args, exec) => runtime.query(identity(exec), exec.signal, args as { selector: string; field: string; attribute?: string; limit?: number; viewId?: string; frameId?: string }),
  })
  tool(ctx, {
    name: 'browser_console_messages',
    description: 'Read bounded page console messages captured for the selected tab.',
    parameters: { viewId: { type: 'string' }, clear: { type: 'boolean' } },
    execute: (args, exec) => runtime.consoleMessages(identity(exec), exec.signal, args as { viewId?: string; clear?: boolean }),
  })
  tool(ctx, {
    name: 'browser_network_requests',
    description: 'Read bounded, URL-redacted network request metadata for the selected tab.',
    parameters: { viewId: { type: 'string' }, clear: { type: 'boolean' } },
    execute: (args, exec) => runtime.networkRequests(identity(exec), exec.signal, args as { viewId?: string; clear?: boolean }),
  })
  tool(ctx, {
    name: 'browser_handle_dialog',
    description: `Resolve an ordinary open dialog or preconfigure the next alert, confirm, or prompt. Do not accept, answer, or preconfigure a dialog that is part of a security verification challenge. ${verificationGuidance}`,
    parameters: { accept: { type: 'boolean', required: true }, promptText: { type: 'string' }, viewId: { type: 'string' } },
    execute: (args, exec) => runtime.handleDialog(identity(exec), exec.signal, args as { accept: boolean; promptText?: string; viewId?: string }),
  })
  tool(ctx, {
    name: 'browser_upload_file',
    description: 'Upload one file from configured roots without returning its host absolute path.',
    parameters: { ref: { type: 'string', required: true }, filePath: { type: 'string', required: true }, viewId: { type: 'string' } },
    execute: (args, exec) => runtime.upload(identity(exec), exec.signal, args as { ref: string; filePath: string; viewId?: string }),
  })
  tool(ctx, {
    name: 'browser_download',
    description: 'Click a download element and save the result in the plugin-managed artifact directory.',
    parameters: { ref: { type: 'string', required: true }, viewId: { type: 'string' }, timeoutMs: { type: 'integer' } },
    execute: (args, exec) => runtime.download(identity(exec), exec.signal, args as { ref: string; viewId?: string; timeoutMs?: number }),
  })
  tool(ctx, {
    name: 'browser_debugger',
    description: 'Control the managed tab JavaScript debugger. Use attach first; call_frames and scope_variables are read-only. Pause, resume, stepping, breakpoint changes, and detach require approval.',
    parameters: {
      action: { type: 'string', enum: debuggerActions, required: true },
      viewId: { type: 'string' },
      url: { type: 'string' },
      lineNumber: { type: 'integer' },
      columnNumber: { type: 'integer' },
      breakpointId: { type: 'string' },
      callFrameId: { type: 'string' },
      scopeNumber: { type: 'integer' },
      scriptId: { type: 'string' },
    },
    execute: (args, exec) => runtime.debugger(identity(exec), exec.signal, args as unknown as BrowserDebuggerInput),
  })
  tool(ctx, {
    name: 'browser_diagnose',
    description: 'Create a bounded frontend debugging evidence chain for the selected tab. start binds one view and enables L3 context identity collection. recorder_start explicitly enables privacy-preserving Rolling or Deep recording; the default remains Off. recorder_status/timeline are read-only, while pause/resume/clear/stop/mark/complete change recorder state. Rolling keeps up to 180 seconds of redacted interaction metadata without a persistent Live View recording banner; Deep is explicit and visibly marked in the panel. Input text, passwords, verification codes, cookies, authorization, clipboard contents, and file contents are never stored in recorder events. Fixing the primary root cause is not completion: before reporting success, verify cancellation and stale async work, controlled handling of business non-2xx responses, zero remaining page runtime errors, and a successful comparable checkpoint comparison without new critical regressions. Expected AbortError must not remain as a page error, and a failed or unavailable Compare must not be replaced by a manual success claim. inspect, checkpoint, compare, report, and stop retain their existing semantics. It never modifies Workspace files, reads Network bodies, bypasses cross-origin restrictions, or executes model-supplied JavaScript.',
    parameters: {
      action: { type: 'string', enum: diagnoseActions, required: true },
      viewId: { type: 'string' },
      ref: { type: 'string' },
      label: { type: 'string' },
      checkpointId: { type: 'string' },
      beforeCheckpointId: { type: 'string' },
      afterCheckpointId: { type: 'string' },
      screenshot: { type: 'boolean' },
      sinceActionId: { type: 'string' },
      untilActionId: { type: 'string' },
      sinceCheckpointId: { type: 'string' },
      sinceCursor: { type: 'integer' },
      recorderMode: { type: 'string', enum: ['rolling', 'deep'] },
      incidentId: { type: 'string' },
      limit: { type: 'integer' },
    },
    execute: (args, exec) => runtime.diagnose(identity(exec), exec.signal, args as unknown as BrowserDiagnoseInput),
  })
  tool(ctx, {
    name: 'browser_network_control',
    description: 'Control bounded Fetch interception for the selected tab. list_paused is read-only. Other actions require approval. Paused requests automatically continue after the configured timeout. body stores large content as a managed artifact; replay can only repeat the selected paused request.',
    parameters: {
      action: { type: 'string', enum: networkActions, required: true },
      viewId: { type: 'string' },
      requestId: { type: 'string' },
      urlPattern: { type: 'string' },
      resourceType: { type: 'string' },
      requestStage: { type: 'string', enum: ['request', 'response', 'both'] },
      errorReason: { type: 'string' },
      responseCode: { type: 'integer' },
      responsePhrase: { type: 'string' },
      headers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
      },
      body: { type: 'string' },
      bodyBase64: { type: 'boolean' },
    },
    execute: (args, exec) => runtime.networkControl(identity(exec), exec.signal, args as unknown as BrowserNetworkInput),
  })
  tool(ctx, {
    name: 'browser_profile',
    description: 'Capture bounded trace, CPU, coverage, heap snapshot, and heap sampling artifacts for the selected tab. Large results are stored in the plugin-managed artifact store. artifacts only lists metadata; artifact_read is size-limited and requires approval.',
    parameters: {
      action: { type: 'string', enum: profileActions, required: true },
      viewId: { type: 'string' },
      artifactId: { type: 'string' },
      maxReadBytes: { type: 'integer' },
    },
    execute: (args, exec) => runtime.profile(identity(exec), exec.signal, args as unknown as BrowserProfileInput),
  })
  tool(ctx, {
    name: 'browser_emulate',
    description: 'Apply explicit viewport, device, locale, timezone, network, CPU, offline, or permission emulation to the selected tab. reset clears plugin-applied emulation. All actions change browser state and require approval.',
    parameters: {
      action: { type: 'string', enum: emulateActions, required: true },
      viewId: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      deviceScaleFactor: { type: 'number' },
      mobile: { type: 'boolean' },
      device: { type: 'string' },
      locale: { type: 'string' },
      timezoneId: { type: 'string' },
      offline: { type: 'boolean' },
      latencyMs: { type: 'number' },
      downloadKbps: { type: 'number' },
      uploadKbps: { type: 'number' },
      rate: { type: 'number' },
      permissions: { type: 'array', items: { type: 'string' } },
      origin: { type: 'string' },
    },
    execute: (args, exec) => runtime.emulate(identity(exec), exec.signal, args as unknown as BrowserEmulateInput),
  })
  tool(ctx, {
    name: 'browser_live_view',
    description: 'Read or switch the right-side live browser display mode without approval. The human UI keeps these controls inside a collapsed floating panel; agents must call browser_live_view directly and must not search for or click that UI. standard fixes the real browser viewport at 1280x720 and preserves the page desktop layout with complete proportional rendering. adaptive follows the latest stable live-panel size and, when fixed-width layout containers still overflow horizontally, applies a bounded forced reflow to those containers without scaling the whole page. If forced reflow damages a complex page or hides a needed element, you may switch to standard without user approval, but you must tell the user after switching. Model switches affect only the current browser session and do not overwrite the user local preference.',
    parameters: {
      action: { type: 'string', enum: ['status', 'standard', 'adaptive'], required: true },
      viewId: { type: 'string' },
    },
    execute: (args, exec) => runtime.liveView(identity(exec), exec.signal, args as unknown as BrowserLiveViewInput),
  })
  tool(ctx, {
    name: 'browser_split_view',
    description: 'Read or control the current DSH Session browser internal top/bottom split view without approval. The human UI keeps these controls inside a collapsed floating panel; agents must call browser_split_view directly and must not search for or click that UI. open creates a bottom about:blank tab when only one tab exists. close keeps the focused tab. swap exchanges panes, assign places a viewId in one pane, focus changes the default tool target, and ratio clamps the top pane to 40%-60%. Tell the user after changing the layout.',
    parameters: {
      action: { type: 'string', enum: ['status', 'open', 'close', 'swap', 'assign', 'focus', 'ratio'], required: true },
      pane: { type: 'string', enum: ['top', 'bottom'] },
      viewId: { type: 'string' },
      ratio: { type: 'number' },
    },
    execute: async (args, exec) => {
      const result = await runtime.splitView(identity(exec), exec.signal, args as unknown as BrowserSplitViewInput)
      if (result.ok && isRecord(result.data) && result.data.changed === true && exec.agent !== undefined) {
        try {
          exec.agent.inject(createUserMessage({
            content: [{ type: 'text', text: `Agent 已调整右侧浏览器上下双页分屏：${result.data.enabled === true ? `已开启，上方占比 ${Math.round(Number(result.data.ratio) * 100)}%` : '已关闭'}；当前焦点标签 viewId=${result.viewId ?? 'none'}。` }],
            source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Agent 调整浏览器上下分屏' },
          }))
        } catch {}
      }
      return result
    },
  })
  tool(ctx, {
    name: 'browser_evaluate',
    description: 'Evaluate explicit JavaScript in an isolated world, the page main world, or a paused call frame. Results are serialized, bounded, and redact sensitive property names. Every action requires approval because isolated code can still change shared DOM or start network requests.',
    parameters: {
      action: { type: 'string', enum: evaluateActions, required: true },
      viewId: { type: 'string' },
      expression: { type: 'string', required: true },
      callFrameId: { type: 'string' },
      awaitPromise: { type: 'boolean' },
    },
    execute: (args, exec) => runtime.evaluate(identity(exec), exec.signal, args as unknown as BrowserEvaluateInput),
  })
  tool(ctx, {
    name: 'browser_provider',
    description: 'List capabilities or switch the current DSH browser session between managed, plugin-persistent, and explicitly supplied external CDP providers. External endpoints are never scanned and every connect or disconnect requires approval.',
    parameters: {
      action: { type: 'string', enum: providerActions, required: true },
      provider: { type: 'string', enum: ['managed', 'managed-persistent', 'external-cdp'] },
      endpoint: { type: 'string' },
      profileName: { type: 'string' },
    },
    execute: (args, exec) => runtime.provider(identity(exec), exec.signal, args as unknown as BrowserProviderInput),
  })
  tool(ctx, {
    name: 'browser_extensions',
    description: 'Manage Chrome Web Store extensions for the current DSH Session persistent browser profile. Humans can open the clearly labelled 扩展管理 view from the browser menu or live-control panel; agents must call browser_extensions directly and must not search for or click that UI. list is read-only. install accepts a Chrome Web Store URL or extension ID. Changes default to next_start; applyMode now rebuilds the current persistent browser, restores tab URLs, and may lose unsubmitted page state. Mutation actions require approval unless the top-level Session uses Full access.',
    parameters: {
      action: { type: 'string', enum: extensionActions, required: true },
      extension: { type: 'string' },
      extensionId: { type: 'string' },
      applyMode: { type: 'string', enum: ['next_start', 'now'] },
    },
    execute: (args, exec) => runtime.extensions(identity(exec), exec.signal, args as unknown as BrowserExtensionInput),
  })
  tool(ctx, {
    name: 'browser_takeover',
    description: `Read or change exclusive browser control ownership. The human UI keeps takeover inside a collapsed floating panel; agents must call browser_takeover directly and must not search for or click that UI. While the user owns control, model write operations return USER_TAKEOVER_ACTIVE and read-only observation remains available. Request or preserve human control for every security verification challenge. ${verificationGuidance}`,
    parameters: {
      action: { type: 'string', enum: takeoverActions, required: true },
      viewId: { type: 'string' },
    },
    execute: (args, exec) => runtime.takeover(identity(exec), exec.signal, args as unknown as BrowserTakeoverInput),
  })

  definitionCollectors.delete(ctx)
  if (definitions.length !== 30) throw new Error(`browser tool definition count changed unexpectedly: ${definitions.length}`)

  if (resolved.toolRegistrationMode === 'global') {
    // 兼容模式保持历史语义：Profile 中已有任意 browser_* 工具时拒绝启动，
    // 避免两个全局控制器同时进入全部 Session 的模型工具面。
    for (const definition of ctx.tools.schemas()) {
      if (definition.name.startsWith('browser_')) throw new BrowserError(`browser tool ${definition.name} is already registered`, 'DUPLICATE_BROWSER_TOOL')
    }
    registerToolDefinitions(ctx, definitions)
  } else {
    controller = new BrowserControllerStore({
      ctx,
      storageRoot: resolved.controllerStorageRoot,
      config: resolved.sessionController,
      toolDefinitions: definitions,
      registerTools: (agent, values) => registerToolDefinitions(agent.ctx, values),
      suspendRuntime: sessionId => runtime.suspendSessionController(sessionId),
      releaseRuntime: (sessionId, sessionCreatedAt) => runtime.disposeSession({ sessionId, sessionCreatedAt }),
      isOwnedTool: toolName => definitions.some(definition => definition.name === toolName),
    })
    // Runtime 只通过只读 resolver 获取当前 Session 的控制器代际，不反向持有 Store。
    // 未激活 Session 返回 undefined，防止 other 模式生成被误标为本插件所有的 L3 证据。
    runtime.setControllerIdentityResolver(sessionId => controller?.identity(sessionId))
    // 插件可能在部分 Agent 已创建后热加载；先绑定现有 Agent，再监听后续创建，
    // 避免必须重启 DSH 才能使用 session-select。
    for (const agent of ctx.agents.list()) controller.attach(agent)
    ctx.on('agent/created', ({ agent }) => { controller?.attach(agent) })
  }
}

export type { BrowserConfig }
