import type { ClientPlugin, PluginRequestContext } from '../plugins.js'
import {
  dedupeRequestHash,
  type DedupeHashParams,
} from '../dedupeRequestHash.js'

type DedupeEntry = {
  promise: Promise<Response>
  resolve: (value: Response | PromiseLike<Response>) => void
  reject: (reason?: unknown) => void
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
        return existing.promise
      }

      let settled = false
      let resolveFn: (value: Response | PromiseLike<Response>) => void
      let rejectFn: (reason?: unknown) => void

      const placeholder = new Promise<Response>((resolve, reject) => {
        resolveFn = (value) => {
          if (!settled) {
            settled = true
            resolve(value)
          }
        }
        rejectFn = (reason) => {
          if (!settled) {
            settled = true
            reject(reason)
          }
        }
      })
      // Internal placeholder can reject before a consumer attaches handlers.
      // Mark it observed to avoid unhandled-rejection noise.
      placeholder.catch(() => undefined)

      inFlight.set(key, {
        promise: placeholder,
        resolve: resolveFn!,
        reject: rejectFn!,
        createdAt: Date.now(),
      })
      startSweeper()

      const actualPromise = next(ctx)
      const entry = inFlight.get(key)
      if (entry) {
        actualPromise.then(
          (result) => entry.resolve(result),
          (error) => entry.reject(error)
        )
        inFlight.set(key, {
          ...entry,
          promise: actualPromise,
        })
      }

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
