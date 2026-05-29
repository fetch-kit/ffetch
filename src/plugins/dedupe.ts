import type { ClientPlugin, PluginRequestContext } from '../plugins.js'
import {
  dedupeRequestHash,
  type DedupeHashParams,
} from '../dedupeRequestHash.js'

type Waiter = {
  resolve: (value: Response) => void
  reject: (reason?: unknown) => void
}

type DedupeEntry = {
  promise: Promise<Response>
  waiters: Waiter[]
  createdAt: number
}

export type DedupePluginOptions = {
  hashFn?: (params: DedupeHashParams) => string | undefined
  ttl?: number
  sweepInterval?: number
  order?: number
}

function contextToHashParams(ctx: PluginRequestContext): DedupeHashParams {
  return {
    method: ctx.request.method,
    url: ctx.request.url,
    body: (ctx.init.body ?? null) as DedupeHashParams['body'],
    headers: ctx.request.headers,
    signal:
      ctx.init.signal === undefined || ctx.init.signal === null
        ? undefined
        : ctx.init.signal,
    requestInit: ctx.init,
    request: ctx.request,
  }
}

export function dedupePlugin(options: DedupePluginOptions = {}): ClientPlugin {
  const {
    hashFn = dedupeRequestHash,
    ttl,
    sweepInterval = 5000,
    order = 10,
  } = options

  const inFlight = new Map<string, DedupeEntry>()
  let sweeper: ReturnType<typeof setInterval> | undefined

  function startSweeper() {
    if (sweeper || typeof ttl !== 'number' || ttl <= 0) return
    sweeper = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of inFlight.entries()) {
        if (now - entry.createdAt > ttl) {
          inFlight.delete(key)
        }
      }
      if (inFlight.size === 0 && sweeper) {
        clearInterval(sweeper)
        sweeper = undefined
      }
    }, sweepInterval)
  }

  function stopSweeperIfIdle() {
    if (inFlight.size === 0 && sweeper) {
      clearInterval(sweeper)
      sweeper = undefined
    }
  }

  return {
    name: 'dedupe',
    order,
    wrapDispatch: (next) => async (ctx) => {
      const key = hashFn(contextToHashParams(ctx))
      ctx.state.dedupeKey = key

      if (!key) {
        return next(ctx)
      }

      const existing = inFlight.get(key)
      if (existing) {
        return new Promise<Response>((resolve, reject) => {
          existing.waiters.push({ resolve, reject })
        })
      }

      const waiters: Waiter[] = []
      const actualPromise = next(ctx)

      inFlight.set(key, {
        promise: actualPromise,
        waiters,
        createdAt: Date.now(),
      })
      startSweeper()

      actualPromise.then(
        (result) => {
          for (const waiter of waiters) {
            waiter.resolve(result.clone())
          }
        },
        (error) => {
          for (const waiter of waiters) {
            waiter.reject(error)
          }
        }
      )

      return actualPromise.finally(() => {
        const current = inFlight.get(key)
        if (current?.promise === actualPromise) {
          inFlight.delete(key)
          stopSweeperIfIdle()
        }
      })
    },
  }
}

export { dedupeRequestHash }
export type { DedupeHashParams }
