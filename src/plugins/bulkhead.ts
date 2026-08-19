import type { ClientPlugin, PluginRequestContext } from '../plugins.js'
import { AbortError, BulkheadFullError, TimeoutError } from '../error.js'

export type BulkheadPluginExtension = {
  activeCount: number
  queueDepth: number
}

export type BulkheadPluginOptions = {
  maxConcurrent: number
  maxQueue?: number
  onReject?: (req: Request) => void | Promise<void>
  order?: number
}

type QueueEntry = {
  ctx: PluginRequestContext
  signal: AbortSignal
  resolve: () => void
  reject: (err: unknown) => void
  cleanup: () => void
}

export function bulkheadPlugin(
  options: BulkheadPluginOptions
): ClientPlugin<BulkheadPluginExtension> {
  const { maxConcurrent, maxQueue, onReject, order = 5 } = options

  let activeCount = 0
  const queue: QueueEntry[] = []

  function makeCancellationError(ctx: PluginRequestContext): Error {
    const { signals } = ctx.metadata
    if (signals.user?.aborted) {
      return new AbortError('Request was aborted by user', signals.user.reason)
    }
    if (signals.timeout?.aborted) {
      return new TimeoutError('signal timed out', signals.timeout.reason)
    }
    const signal = signals.combined ?? ctx.request.signal
    return new AbortError('Request was aborted', signal.reason)
  }

  function drainQueue(): void {
    while (activeCount < maxConcurrent && queue.length > 0) {
      const next = queue.shift()!
      next.cleanup()

      if (next.signal.aborted) {
        next.reject(makeCancellationError(next.ctx))
        continue
      }

      activeCount++
      next.resolve()
    }
  }

  function release(): void {
    activeCount = Math.max(0, activeCount - 1)
    drainQueue()
  }

  async function acquire(ctx: PluginRequestContext): Promise<void> {
    const { request } = ctx
    const signal = ctx.metadata.signals.combined ?? request.signal
    if (activeCount < maxConcurrent) {
      activeCount++
      return
    }

    if (
      typeof maxQueue === 'number' &&
      maxQueue >= 0 &&
      queue.length >= maxQueue
    ) {
      await onReject?.(request)
      throw new BulkheadFullError('Bulkhead queue is full')
    }

    await new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        ctx,
        signal,
        resolve,
        reject,
        cleanup: () => {},
      }

      const onAbort = () => {
        const idx = queue.indexOf(entry)
        if (idx >= 0) {
          queue.splice(idx, 1)
        }
        entry.cleanup()
        reject(makeCancellationError(ctx))
      }

      entry.cleanup = () => {
        signal.removeEventListener('abort', onAbort)
      }

      if (signal.aborted) {
        reject(makeCancellationError(ctx))
        return
      }

      signal.addEventListener('abort', onAbort, { once: true })
      queue.push(entry)
    })
  }

  return {
    name: 'bulkhead',
    order,
    setup: ({ defineExtension }) => {
      defineExtension('activeCount', {
        get: () => activeCount,
        enumerable: true,
      })
      defineExtension('queueDepth', {
        get: () => queue.length,
        enumerable: true,
      })
    },
    wrapDispatch: (next) => async (ctx) => {
      let acquired = false
      try {
        await acquire(ctx)
        acquired = true
        return await next(ctx)
      } finally {
        if (acquired) {
          release()
        }
      }
    },
  }
}
