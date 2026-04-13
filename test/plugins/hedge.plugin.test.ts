import { describe, it, expect, vi, afterEach } from 'vitest'
import { hedgePlugin } from '../../src/plugins/hedge.js'
import type { PluginDispatch, PluginRequestContext } from '../../src/plugins.js'

function makeCtx(
  url = 'https://example.com/',
  method = 'GET'
): PluginRequestContext {
  const request = new Request(url, { method })
  return {
    request,
    init: { method },
    state: {},
    metadata: {
      startedAt: Date.now(),
      timeoutMs: 5000,
      signals: {},
      retry: {
        configuredRetries: 0,
        configuredDelay: 0,
        attempt: 0,
      },
    },
  }
}

function defer<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('hedgePlugin metadata', () => {
  it('has name "hedge"', () => {
    const plugin = hedgePlugin({ delay: 100 })
    expect(plugin.name).toBe('hedge')
  })

  it('defaults order to 15', () => {
    const plugin = hedgePlugin({ delay: 100 })
    expect(plugin.order).toBe(15)
  })

  it('accepts custom order', () => {
    const plugin = hedgePlugin({ delay: 100, order: 5 })
    expect(plugin.order).toBe(5)
  })
})

describe('hedgePlugin shouldHedge (default)', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])(
    'hedges %s by default',
    async (method) => {
      vi.useFakeTimers()
      const d1 = defer<Response>()
      const d2 = defer<Response>()
      let calls = 0

      const next: PluginDispatch = async () => {
        calls++
        return calls === 1 ? d1.promise : d2.promise
      }

      const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
      const resultP = dispatch(makeCtx('https://example.com/', method))

      await vi.advanceTimersByTimeAsync(60)
      expect(calls).toBe(2) // hedge fired

      d1.resolve(new Response('ok'))
      await resultP
    }
  )

  it('does NOT hedge POST by default', async () => {
    vi.useFakeTimers()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return new Response('ok')
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx('https://example.com/', 'POST'))

    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(1) // no hedge

    await resultP
  })

  it('does NOT hedge PATCH by default', async () => {
    vi.useFakeTimers()
    let calls = 0
    const next: PluginDispatch = async () => {
      calls++
      return new Response('ok')
    }
    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx('https://example.com/', 'PATCH'))
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(1)
    await resultP
  })

  it('respects custom shouldHedge returning false', async () => {
    vi.useFakeTimers()
    let calls = 0
    const next: PluginDispatch = async () => {
      calls++
      return new Response('ok')
    }
    const dispatch = hedgePlugin({
      delay: 50,
      shouldHedge: () => false,
    }).wrapDispatch!(next)

    const resultP = dispatch(makeCtx())
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(1)
    await resultP
  })

  it('respects custom shouldHedge returning true for POST', async () => {
    vi.useFakeTimers()
    let calls = 0
    const d = defer<Response>()
    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return d.promise
      return new Response('hedge-ok')
    }
    const dispatch = hedgePlugin({
      delay: 50,
      shouldHedge: () => true,
    }).wrapDispatch!(next)

    const resultP = dispatch(makeCtx('https://example.com/', 'POST'))
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    d.resolve(new Response('slow'))
    await resultP
  })
})

describe('hedgePlugin winner policy', () => {
  it('returns the first ok response', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    // Hedge (attempt 1) resolves first
    d2.resolve(new Response('fast'))
    const result = await resultP
    expect(await result.text()).toBe('fast')
  })

  it('returns original when it resolves before hedge fires', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return d1.promise
    }

    const dispatch = hedgePlugin({ delay: 100 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    // Original resolves before the 100ms hedge delay
    d1.resolve(new Response('original'))
    const result = await resultP

    await vi.advanceTimersByTimeAsync(150) // timers now fire but settled is true
    expect(calls).toBe(1)
    expect(await result.text()).toBe('original')
  })

  it('treats 5xx as non-winner and waits for hedge', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    d1.resolve(new Response('fail', { status: 500 })) // not a winner
    d2.resolve(new Response('ok'))

    const result = await resultP
    expect(result.status).toBe(200)
  })

  it('treats 429 as non-winner and waits for hedge', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)

    d1.resolve(new Response('rate-limited', { status: 429 })) // not a winner
    d2.resolve(new Response('ok'))

    const result = await resultP
    expect(result.status).toBe(200)
  })

  it('resolves with 5xx when it is the last attempt and no better response', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50, maxHedges: 1 }).wrapDispatch!(
      next
    )
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    d1.resolve(new Response('error', { status: 500 }))
    d2.resolve(new Response('also-error', { status: 503 }))

    const result = await resultP
    expect(result.status).toBeGreaterThanOrEqual(500)
  })

  it('resolves with 4xx (non-429) immediately — 4xx is a valid winner', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)

    d1.resolve(new Response('not found', { status: 404 }))
    const result = await resultP
    expect(result.status).toBe(404)
  })
})

describe('hedgePlugin error handling', () => {
  it('rejects with last error when all attempts fail', async () => {
    vi.useFakeTimers()

    const err1 = new Error('first')
    const err2 = new Error('last')
    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())
    const assertion = expect(resultP).rejects.toThrow('last')

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2) // both attempts launched

    d1.reject(err1)
    d2.reject(err2)

    await assertion
  })

  it('rejects when single attempt fails and no hedge has fired yet', async () => {
    vi.useFakeTimers()

    const err = new Error('network down')
    const next: PluginDispatch = async () => {
      throw err
    }

    const dispatch = hedgePlugin({ delay: 1000 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())
    const assertion = expect(resultP).rejects.toThrow('network down')

    await vi.advanceTimersByTimeAsync(0)
    await assertion
  })

  it('resolves if one attempt succeeds even when others fail', async () => {
    vi.useFakeTimers()

    const d1 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return d1.promise
      return new Response('ok')
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)

    d1.reject(new Error('first failed'))
    const result = await resultP
    expect(result.status).toBe(200)
  })

  it('ignores stale allSettled callback when sibling already settled the race', async () => {
    // Covers the `if (settled) return` true-branch inside the rejection-handler's allSettled.
    // Attempt 0 rejects while attempt 1 is still pending → allSettled waits.
    // Attempt 1 resolves → watchAttempt(1) fires first (registered before allSettled) →
    // settle() called → settled=true. Then allSettled.then fires and early-exits.
    vi.useFakeTimers()

    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    // Reject first; second is still pending → rejection handler calls allSettled (waits for d2)
    d1.reject(new Error('first failed'))
    // Resolve second → watchAttempt(1) fires before allSettled.then → settle() → settled=true
    d2.resolve(new Response('ok'))

    const result = await resultP
    expect(result.status).toBe(200)
  })
})

describe('hedgePlugin loser cancellation', () => {
  it('aborts losers when winner is found', async () => {
    vi.useFakeTimers()

    const signals: AbortSignal[] = []
    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async (ctx) => {
      calls++
      signals.push(ctx.request.signal)
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    // Hedge wins
    d2.resolve(new Response('hedge-wins'))
    await resultP

    // Loser (attempt 0) signal should be aborted
    expect(signals[0].aborted).toBe(true)
    // Winner (attempt 1) signal should NOT be aborted
    expect(signals[1].aborted).toBe(false)
  })

  it('does not abort the winner signal', async () => {
    vi.useFakeTimers()

    const signals: AbortSignal[] = []
    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async (ctx) => {
      calls++
      signals.push(ctx.request.signal)
      return calls === 1 ? d1.promise : d2.promise
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(60)

    // First attempt wins
    d1.resolve(new Response('original-wins'))
    await resultP

    expect(signals[0].aborted).toBe(false)
    expect(signals[1].aborted).toBe(true)
  })
})

describe('hedgePlugin delay', () => {
  it('accepts numeric delay', async () => {
    vi.useFakeTimers()
    let calls = 0
    const d = defer<Response>()

    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return d.promise
      return new Response('hedge')
    }

    const dispatch = hedgePlugin({ delay: 75 }).wrapDispatch!(next)
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(74)
    expect(calls).toBe(1) // not yet

    await vi.advanceTimersByTimeAsync(2)
    expect(calls).toBe(2) // hedge fired

    d.resolve(new Response('slow'))
    await resultP
  })

  it('accepts function delay', async () => {
    vi.useFakeTimers()
    let calls = 0
    const seenReq: Request[] = []
    const d = defer<Response>()

    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return d.promise
      return new Response('hedge')
    }

    const delayFn = vi.fn((req: Request) => {
      seenReq.push(req)
      return 80
    })

    const dispatch = hedgePlugin({ delay: delayFn }).wrapDispatch!(next)
    const ctx = makeCtx()
    const resultP = dispatch(ctx)

    await vi.advanceTimersByTimeAsync(90)
    expect(calls).toBe(2)
    expect(delayFn).toHaveBeenCalledOnce()
    expect(seenReq[0]).toBe(ctx.request)

    d.resolve(new Response('slow'))
    await resultP
  })
})

describe('hedgePlugin maxHedges', () => {
  it('fires exactly maxHedges additional attempts', async () => {
    vi.useFakeTimers()
    let calls = 0
    const resolvers: Array<() => void> = []

    const next: PluginDispatch = () => {
      calls++
      return new Promise<Response>((resolve) => {
        resolvers.push(() => resolve(new Response('ok')))
      })
    }

    const dispatch = hedgePlugin({ delay: 50, maxHedges: 2 }).wrapDispatch!(
      next
    )
    const resultP = dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toBe(2) // original + 1st hedge

    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toBe(3) // + 2nd hedge

    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toBe(3) // no more

    resolvers[0]()
    await resultP
  })

  it('does not fire more hedges after winner settles', async () => {
    vi.useFakeTimers()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return new Response('fast')
      return new Response('slow')
    }

    const dispatch = hedgePlugin({ delay: 50, maxHedges: 3 }).wrapDispatch!(
      next
    )
    await dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(1) // settled before any hedge fired
  })
})

describe('hedgePlugin onHedge', () => {
  it('calls onHedge for each hedge attempt (not for the original)', async () => {
    vi.useFakeTimers()

    const onHedge = vi.fn()
    const d = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async () => {
      calls++
      if (calls === 1) return d.promise
      return new Response('hedge')
    }

    const ctx = makeCtx()
    const dispatch = hedgePlugin({ delay: 50, maxHedges: 1, onHedge })
      .wrapDispatch!(next)
    const resultP = dispatch(ctx)

    await vi.advanceTimersByTimeAsync(60)
    expect(onHedge).toHaveBeenCalledOnce()
    expect(onHedge).toHaveBeenCalledWith(ctx.request, 1)

    d.resolve(new Response('slow'))
    await resultP
  })

  it('does NOT call onHedge for attempt 0', async () => {
    vi.useFakeTimers()
    const onHedge = vi.fn()

    const next: PluginDispatch = async () => new Response('ok')

    const dispatch = hedgePlugin({ delay: 1000, onHedge }).wrapDispatch!(next)
    await dispatch(makeCtx())

    await vi.advanceTimersByTimeAsync(0)
    expect(onHedge).not.toHaveBeenCalled()
  })
})

describe('hedgePlugin signal propagation', () => {
  it('propagates external abort to all inflight attempts', async () => {
    vi.useFakeTimers()

    const signals: AbortSignal[] = []
    const d1 = defer<Response>()
    const d2 = defer<Response>()
    let calls = 0

    const next: PluginDispatch = async (ctx) => {
      calls++
      signals.push(ctx.request.signal)
      return calls === 1 ? d1.promise : d2.promise
    }

    const controller = new AbortController()
    const baseCtx = makeCtx()
    const ctxWithSignal: PluginRequestContext = {
      ...baseCtx,
      request: new Request(baseCtx.request, { signal: controller.signal }),
    }

    const dispatch = hedgePlugin({ delay: 50 }).wrapDispatch!(next)
    const resultP = dispatch(ctxWithSignal)

    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(2)

    controller.abort()

    // Both attempt signals should eventually be aborted via AbortSignal.any
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(true)

    // Clean up — settle the promises so no unhandled rejections
    d1.reject(new Error('aborted'))
    d2.reject(new Error('aborted'))
    await resultP.catch(() => {})
  })
})
