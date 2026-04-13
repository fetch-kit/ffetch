import type { ClientPlugin } from '../plugins.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])

export type HedgePluginOptions = {
  delay: number | ((req: Request) => number)
  maxHedges?: number
  shouldHedge?: (req: Request) => boolean
  onHedge?: (req: Request, attempt: number) => void | Promise<void>
  order?: number
}

export function hedgePlugin(options: HedgePluginOptions): ClientPlugin {
  const {
    delay,
    maxHedges = 1,
    shouldHedge = (req) => SAFE_METHODS.has(req.method),
    onHedge,
    order = 15,
  } = options

  return {
    name: 'hedge',
    order,
    wrapDispatch: (next) => async (ctx) => {
      if (!shouldHedge(ctx.request)) {
        return next(ctx)
      }

      const delayMs = typeof delay === 'function' ? delay(ctx.request) : delay

      const controllers: AbortController[] = []
      const attempts: Promise<Response>[] = []

      function launch(attemptIndex: number): void {
        const controller = new AbortController()
        controllers.push(controller)

        const signal = AbortSignal.any([ctx.request.signal, controller.signal])

        const req = new Request(ctx.request, { signal })
        attempts.push(next({ ...ctx, request: req }))

        if (attemptIndex > 0) {
          onHedge?.(ctx.request, attemptIndex)
        }
      }

      function abortLosers(winnerIndex: number): void {
        controllers.forEach((c, i) => {
          if (i !== winnerIndex) c.abort()
        })
      }

      // Launch initial attempt
      launch(0)

      return new Promise<Response>((resolve, reject) => {
        let settled = false
        let launched = 1
        const timers: ReturnType<typeof setTimeout>[] = []

        function settle(winnerIndex: number, value: Response): void {
          settled = true
          timers.forEach(clearTimeout)
          abortLosers(winnerIndex)
          resolve(value)
        }

        function tryReject(err: unknown): void {
          Promise.allSettled(attempts).then((results) => {
            if (settled) return
            settled = true
            timers.forEach(clearTimeout)
            let lastError = err
            for (const r of results) {
              if (r.status === 'rejected') lastError = r.reason
            }
            reject(lastError)
          })
        }

        function onAttemptSettled(
          index: number,
          result: PromiseSettledResult<Response>
        ): void {
          if (settled) return

          if (result.status === 'fulfilled') {
            const res = result.value
            // Treat 5xx and 429 as non-winners unless it's the last attempt
            const isLastAttempt =
              launched >= maxHedges + 1 && index === attempts.length - 1
            if (
              res.ok ||
              (res.status < 500 && res.status !== 429) ||
              isLastAttempt
            ) {
              settle(index, res)
            }
            // Otherwise wait for other attempts; if all settle without a winner
            // the last settler will resolve with whatever is left
          } else {
            // Check if all currently launched attempts have settled
            Promise.allSettled(attempts).then((results) => {
              if (settled) return
              const pending = results.some(
                (r) => r.status === ('pending' as never)
              )
              if (!pending) {
                tryReject(result.reason)
              }
            })
          }
        }

        function watchAttempt(index: number): void {
          attempts[index].then(
            (res) =>
              onAttemptSettled(index, { status: 'fulfilled', value: res }),
            (err) =>
              onAttemptSettled(index, { status: 'rejected', reason: err })
          )
        }

        watchAttempt(0)

        for (let h = 1; h <= maxHedges; h++) {
          const hedgeIndex = h
          const t = setTimeout(() => {
            launch(hedgeIndex)
            watchAttempt(hedgeIndex)
            launched++
          }, delayMs * hedgeIndex)
          timers.push(t)
        }
      })
    },
  }
}
