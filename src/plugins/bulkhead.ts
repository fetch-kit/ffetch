import type { ClientPlugin } from '../plugins.js'
import { AbortError, BulkheadFullError } from '../error.js'

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
  request: Request
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

  function makeAbortError(signal: AbortSignal): AbortError {
    return new AbortError('Request was aborted', signal.reason)
  }

  function drainQueue(): void {
    while (activeCount < maxConcurrent && queue.length > 0) {
      const next = queue.shift()!
      next.cleanup()

      if (next.request.signal.aborted) {
        next.reject(makeAbortError(next.request.signal))
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

  async function acquire(request: Request): Promise<void> {
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
        request,
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
        reject(makeAbortError(request.signal))
      }

      entry.cleanup = () => {
        request.signal.removeEventListener('abort', onAbort)
      }

      if (request.signal.aborted) {
        reject(makeAbortError(request.signal))
        return
      }

      request.signal.addEventListener('abort', onAbort, { once: true })
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
        await acquire(ctx.request)
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
