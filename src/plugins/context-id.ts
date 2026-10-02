import type { ClientPlugin, PluginRequestContext } from '../plugins.js'

const CONTEXT_ID_STATE_KEY = '__contextId'
const TRACEPARENT_STATE_KEY = '__traceparent'

export type TraceparentOptions = boolean | { enabled?: boolean; flags?: string }

export type ContextIdPluginOptions = {
  generate?: () => string
  inject?: (id: string, request: Request) => void
  order?: number
  traceparent?: TraceparentOptions
}

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

function defaultGenerateContextId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function defaultInjectContextId(id: string, request: Request): void {
  request.headers.set('x-context-id', id)
}

function resolveContextId(
  ctx: PluginRequestContext,
  generate: () => string
): string {
  const existing = ctx.request.headers.get('x-context-id')
  if (existing) {
    ctx.state[CONTEXT_ID_STATE_KEY] = existing
    return existing
  }

  const fromState = ctx.state[CONTEXT_ID_STATE_KEY]
  if (typeof fromState === 'string' && fromState.length > 0) {
    return fromState
  }

  const generated = generate()
  ctx.state[CONTEXT_ID_STATE_KEY] = generated
  return generated
}

function randomHex(bytes: number): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    const array = new Uint8Array(bytes)
    crypto.getRandomValues(array)
    let hex = ''
    for (const byte of array) {
      hex += byte.toString(16).padStart(2, '0')
    }
    return hex
  }

  let hex = ''
  for (let i = 0; i < bytes; i++) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  }
  return hex
}

function generateTraceId(): string {
  return randomHex(16)
}

function generateSpanId(): string {
  return randomHex(8)
}

function parseTraceparent(
  header: string | null
): { traceId: string; flags: string } | null {
  if (!header) return null
  const match = TRACEPARENT_RE.exec(header.trim())
  if (!match) return null
  return {
    traceId: match[2].toLowerCase(),
    flags: match[4].toLowerCase(),
  }
}

export function contextIdPlugin(
  options: ContextIdPluginOptions = {}
): ClientPlugin {
  const {
    generate = defaultGenerateContextId,
    inject = defaultInjectContextId,
    order = 1,
    traceparent = true,
  } = options

  const traceparentEnabled =
    typeof traceparent === 'object' && traceparent !== null
      ? traceparent.enabled !== false
      : traceparent !== false

  const traceFlags =
    typeof traceparent === 'object' &&
    traceparent !== null &&
    typeof traceparent.flags === 'string' &&
    traceparent.flags.length > 0
      ? traceparent.flags
      : '01'

  function resolveTrace(ctx: PluginRequestContext): {
    traceId: string
    flags: string
  } {
    const existing = ctx.state[TRACEPARENT_STATE_KEY]
    if (
      existing &&
      typeof existing === 'object' &&
      'traceId' in existing &&
      'flags' in existing
    ) {
      return existing as { traceId: string; flags: string }
    }

    const parsed = parseTraceparent(ctx.request.headers.get('traceparent'))
    const trace = parsed ?? { traceId: generateTraceId(), flags: traceFlags }
    ctx.state[TRACEPARENT_STATE_KEY] = trace
    return trace
  }

  return {
    name: 'context-id',
    order,
    preRequest: (ctx) => {
      const id = resolveContextId(ctx, generate)
      inject(id, ctx.request)
      if (traceparentEnabled) {
        resolveTrace(ctx)
      }
    },
    beforeAttempt: (ctx) => {
      if (!traceparentEnabled) return
      const trace = resolveTrace(ctx)
      const spanId = generateSpanId()
      ctx.request.headers.set(
        'traceparent',
        `00-${trace.traceId}-${spanId}-${trace.flags}`
      )
    },
    wrapDispatch: (next) => async (ctx) => {
      const id = resolveContextId(ctx, generate)
      inject(id, ctx.request)
      return next(ctx)
    },
  }
}
