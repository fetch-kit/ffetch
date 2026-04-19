import type { ClientPlugin } from '../plugins.js'

const CONTEXT_ID_STATE_KEY = '__contextId'

export type ContextIdPluginOptions = {
  generate?: () => string
  inject?: (id: string, request: Request) => void
  order?: number
}

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
  ctx: Parameters<NonNullable<ClientPlugin['preRequest']>>[0],
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

export function contextIdPlugin(
  options: ContextIdPluginOptions = {}
): ClientPlugin {
  const {
    generate = defaultGenerateContextId,
    inject = defaultInjectContextId,
    order = 1,
  } = options

  return {
    name: 'context-id',
    order,
    preRequest: (ctx) => {
      const id = resolveContextId(ctx, generate)
      inject(id, ctx.request)
    },
    wrapDispatch: (next) => async (ctx) => {
      const id = resolveContextId(ctx, generate)
      inject(id, ctx.request)
      return next(ctx)
    },
  }
}
