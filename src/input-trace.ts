export type InputTraceStageName =
  | 'client-raw'
  | 'client-normalized'
  | 'rpc-received'
  | 'host-dispatched'
  | 'dom-observed'
  | 'final-state'

export type InputSensitivity = 'normal' | 'potentially-sensitive' | 'sensitive' | 'security-challenge'

export interface InputCharacterSummary {
  length: number
  asciiLetters: number
  digits: number
  whitespace: number
  punctuation: number
  cjk: number
  other: number
}

export interface InputTraceStage {
  stage: InputTraceStageName
  timestamp: number
  outcome: 'observed' | 'delivered' | 'prevented' | 'lost' | 'unknown'
  reason?: string
}

export interface InputTraceRecord {
  inputTraceId: string
  sessionKey: string
  viewId: string
  action: 'key-press' | 'insert-text' | 'paste' | 'composition' | 'pointer' | 'wheel'
  sensitivity: InputSensitivity
  characters?: InputCharacterSummary
  composing: boolean
  targetReplaced: boolean
  stages: InputTraceStage[]
  result?: 'delivered' | 'composition-not-committed' | 'focus-lost' | 'target-replaced' | 'prevented-by-page' | 'transport-lost' | 'dropped-at-client-normalization' | 'dropped-at-rpc' | 'dropped-at-host-bridge' | 'dropped-before-dom-event' | 'dropped-after-beforeinput' | 'unknown'
}

export function classifyInputFailure(input: {
  stage: InputTraceStageName
  outcome: InputTraceStage['outcome']
  reason?: string
}): InputTraceRecord['result'] | undefined {
  if (input.outcome !== 'lost' && input.outcome !== 'prevented') return undefined
  if (input.stage === 'client-normalized') return 'dropped-at-client-normalization'
  if (input.stage === 'rpc-received') return 'dropped-at-rpc'
  if (input.stage === 'host-dispatched') return 'dropped-at-host-bridge'
  if (input.stage === 'dom-observed') return 'dropped-before-dom-event'
  if (input.stage === 'final-state' && input.reason === 'beforeinput-without-input') return 'dropped-after-beforeinput'
  if (input.stage === 'final-state' && input.outcome === 'prevented') return 'prevented-by-page'
  return undefined
}

const STAGE_ORDER: readonly InputTraceStageName[] = [
  'client-raw',
  'client-normalized',
  'rpc-received',
  'host-dispatched',
  'dom-observed',
  'final-state',
]

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

export function summarizeInputCharacters(value: string): InputCharacterSummary {
  const summary: InputCharacterSummary = {
    length: [...value].length,
    asciiLetters: 0,
    digits: 0,
    whitespace: 0,
    punctuation: 0,
    cjk: 0,
    other: 0,
  }
  for (const character of value) {
    if (/[A-Za-z]/.test(character)) summary.asciiLetters += 1
    else if (/[0-9]/.test(character)) summary.digits += 1
    else if (/\s/u.test(character)) summary.whitespace += 1
    else if (/\p{P}|\p{S}/u.test(character)) summary.punctuation += 1
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) summary.cjk += 1
    else summary.other += 1
  }
  return summary
}

export function inputSensitivity(input: {
  inputType?: string
  autocomplete?: string
  name?: string
  id?: string
  ariaLabel?: string
}): InputSensitivity {
  const joined = `${input.inputType ?? ''} ${input.autocomplete ?? ''} ${input.name ?? ''} ${input.id ?? ''} ${input.ariaLabel ?? ''}`.toLowerCase()
  if (/otp|one-time|verification|captcha|passkey|webauthn|security.?challenge/.test(joined)) return 'security-challenge'
  if (/password|credit.?card|card.?number|cvv|cvc|authorization|cookie|secret|token/.test(joined)) return 'sensitive'
  if (/email|phone|address|name|account|identity/.test(joined)) return 'potentially-sensitive'
  return 'normal'
}

export class InputTraceStore {
  private readonly sessions = new Map<string, Map<string, InputTraceRecord>>()
  private readonly maximumPerSession: number

  constructor(maximumPerSession = 2000) {
    this.maximumPerSession = maximumPerSession
  }

  start(input: Omit<InputTraceRecord, 'stages' | 'result' | 'targetReplaced'> & { timestamp: number }): InputTraceRecord {
    let session = this.sessions.get(input.sessionKey)
    if (session === undefined) {
      session = new Map()
      this.sessions.set(input.sessionKey, session)
    }
    const record: InputTraceRecord = {
      inputTraceId: bounded(input.inputTraceId, 200),
      sessionKey: input.sessionKey,
      viewId: bounded(input.viewId, 200),
      action: input.action,
      sensitivity: input.sensitivity,
      ...(input.characters === undefined ? {} : { characters: input.characters }),
      composing: input.composing,
      targetReplaced: false,
      stages: [{ stage: 'client-raw', timestamp: input.timestamp, outcome: 'observed' }],
    }
    session.set(record.inputTraceId, record)
    while (session.size > this.maximumPerSession) {
      const oldest = session.keys().next().value as string | undefined
      if (oldest === undefined) break
      session.delete(oldest)
    }
    return record
  }

  ensure(input: Omit<InputTraceRecord, 'stages' | 'result' | 'targetReplaced'> & { timestamp: number }): InputTraceRecord {
    const existing = this.sessions.get(input.sessionKey)?.get(input.inputTraceId)
    if (existing === undefined) return this.start(input)
    existing.viewId = bounded(input.viewId, 200)
    existing.action = input.action
    existing.sensitivity = input.sensitivity
    existing.composing = input.composing
    if (input.characters !== undefined) existing.characters = input.characters
    return existing
  }

  stage(sessionKey: string, inputTraceId: string, stage: Omit<InputTraceStage, 'stage'> & { stage: InputTraceStageName }): InputTraceRecord | undefined {
    const record = this.sessions.get(sessionKey)?.get(inputTraceId)
    if (record === undefined) return undefined
    const previousIndex = record.stages.reduce((maximum, item) => Math.max(maximum, STAGE_ORDER.indexOf(item.stage)), -1)
    const nextIndex = STAGE_ORDER.indexOf(stage.stage)
    if (nextIndex < previousIndex) return record
    const existing = record.stages.find(item => item.stage === stage.stage)
    const value: InputTraceStage = {
      stage: stage.stage,
      timestamp: stage.timestamp,
      outcome: stage.outcome,
      ...(stage.reason === undefined || stage.reason === '' ? {} : { reason: bounded(stage.reason, 160) }),
    }
    if (existing === undefined) record.stages.push(value)
    else Object.assign(existing, value)
    return record
  }

  finish(sessionKey: string, inputTraceId: string, input: { timestamp: number; result: NonNullable<InputTraceRecord['result']>; targetReplaced?: boolean; reason?: string }): InputTraceRecord | undefined {
    const record = this.stage(sessionKey, inputTraceId, {
      stage: 'final-state',
      timestamp: input.timestamp,
      outcome: input.result === 'delivered' ? 'delivered' : input.result === 'prevented-by-page' ? 'prevented' : input.result === 'unknown' ? 'unknown' : 'lost',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
    if (record === undefined) return undefined
    record.result = input.result
    record.targetReplaced = input.targetReplaced ?? false
    return record
  }

  get(sessionKey: string, inputTraceId: string): InputTraceRecord | undefined {
    return this.sessions.get(sessionKey)?.get(inputTraceId)
  }

  list(sessionKey: string, limit = 100): InputTraceRecord[] {
    return [...(this.sessions.get(sessionKey)?.values() ?? [])].slice(-Math.min(Math.max(limit, 1), 500))
  }

  migrateSession(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return
    const session = this.sessions.get(previousKey)
    if (session === undefined) return
    if (this.sessions.has(nextKey)) throw new Error('cannot migrate input traces into an existing session')
    for (const record of session.values()) record.sessionKey = nextKey
    this.sessions.set(nextKey, session)
    this.sessions.delete(previousKey)
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  clear(): void {
    this.sessions.clear()
  }
}
