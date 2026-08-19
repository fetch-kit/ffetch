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

        const req = new Request(ctx.request.clone(), { signal })
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
        let completed = 0
        let fallbackResponse: Response | undefined
        let lastError: unknown
        const timers: ReturnType<typeof setTimeout>[] = []

        function settle(winnerIndex: number, value: Response): void {
          settled = true
          timers.forEach(clearTimeout)
          abortLosers(winnerIndex)
          resolve(value)
        }

        function finishWithoutWinner(): void {
          if (settled || completed < launched) return

          const allAttemptsLaunched = launched >= maxHedges + 1
          if (fallbackResponse && allAttemptsLaunched) {
            settle(attempts.length - 1, fallbackResponse)
            return
          }

          // Preserve the existing fail-fast behavior for transport errors. A
          // retryable HTTP response, however, waits for all scheduled hedges.
          if (!fallbackResponse && lastError !== undefined) {
            settled = true
            timers.forEach(clearTimeout)
            reject(lastError)
          }
        }

        function onAttemptSettled(
          index: number,
          result: PromiseSettledResult<Response>
        ): void {
          if (settled) return

          completed++

          if (result.status === 'fulfilled') {
            const res = result.value
            // A retryable response is only a fallback. Its attempt index says
            // when it was launched, not whether a better attempt is pending.
            if (res.ok || (res.status < 500 && res.status !== 429)) {
              settle(index, res)
              return
            }
            fallbackResponse = res
          } else {
            lastError = result.reason
          }

          finishWithoutWinner()
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
            launched++
            launch(hedgeIndex)
            watchAttempt(hedgeIndex)
          }, delayMs * hedgeIndex)
          timers.push(t)
        }
      })
    },
  }
}
