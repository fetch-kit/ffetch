import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError, RetryLimitError } from '../../src/error.js'
import type { Hooks } from '../../src/hooks.js'
import type { ClientPlugin } from '../../src/plugins.js'

describe('lifecycle around request preparation', () => {
  it('runs plugin onError and onFinally and core onComplete when preRequest throws', async () => {
    const events: string[] = []
    const failure = new Error('preRequest boom')
    const onComplete = vi.fn()
    const fetchHandler = vi.fn(async () => new Response('ok'))

    const client = createClient({
      hooks: { onComplete },
      plugins: [
        {
          name: 'a',
          preRequest: () => {
            events.push('a.preRequest')
            throw failure
          },
          onError: () => {
            events.push('a.onError')
          },
          onFinally: () => {
            events.push('a.onFinally')
          },
        },
        {
          name: 'b',
          onError: () => {
            events.push('b.onError')
          },
          onFinally: () => {
            events.push('b.onFinally')
          },
        },
      ],
      fetchHandler,
    })

    await expect(client('https://example.com/prep-escape')).rejects.toBe(
      failure
    )

    // The request never reached the network, but it did reach the pipeline: the
    // failure is reported to every plugin, cleanup included.
    expect(events).toEqual([
      'a.preRequest',
      'a.onError',
      'b.onError',
      'a.onFinally',
      'b.onFinally',
    ])
    expect(onComplete).toHaveBeenCalledWith(
      expect.any(Request),
      undefined,
      failure
    )
    expect(fetchHandler).not.toHaveBeenCalled()
    expect(client.pendingRequests).toHaveLength(0)
  })

  it.each(['transformRequest', 'before'] as const)(
    'runs core onComplete when %s throws during preparation',
    async (hookName) => {
      const failure = new Error(`${hookName} boom`)
      const onComplete = vi.fn()
      const onError = vi.fn()
      const onFinally = vi.fn()
      const plugin: ClientPlugin = { name: 'p', onError, onFinally }
      const fail = () => {
        throw failure
      }
      const hooks: Hooks = { onComplete }
      Object.assign(hooks, { [hookName]: fail })

      const client = createClient({
        plugins: [plugin],
        hooks,
        fetchHandler: async () => new Response('ok'),
      })

      await expect(client('https://example.com/prep-hook')).rejects.toBe(
        failure
      )

      expect(onComplete).toHaveBeenCalledWith(
        expect.any(Request),
        undefined,
        failure
      )
      // The pipeline never started, so no plugin ever saw the request.
      expect(onError).not.toHaveBeenCalled()
      expect(onFinally).not.toHaveBeenCalled()
      expect(client.pendingRequests).toHaveLength(0)
    }
  )

  it('fires no hook when the Request cannot be constructed', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()
    const onFinally = vi.fn()
    const client = createClient({
      plugins: [{ name: 'p', onError, onFinally }],
      hooks: { onComplete },
      fetchHandler: async () => new Response('ok'),
    })

    // Nothing was built yet, so there is no request and no context to hand to a
    // hook: the caller receives the failure directly.
    await expect(
      client('https://example.com/prep-invalid', { method: 'GET', body: 'x' })
    ).rejects.toBeInstanceOf(TypeError)

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onFinally).not.toHaveBeenCalled()
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('tracks a request while it prepares and lets abortAll cancel it', async () => {
    let releasePreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    const fetchHandler = vi.fn(async () => new Response('ok'))
    let client!: ReturnType<typeof createClient>
    client = createClient({
      plugins: [
        {
          name: 'slow',
          preRequest: async () => {
            // Registered while it is still preparing, so it can be cancelled.
            expect(client.pendingRequests).toHaveLength(1)
            await preparation
          },
        },
      ],
      fetchHandler,
    })

    const request = client('https://example.com/slow-prep')
    expect(client.pendingRequests).toHaveLength(1)

    client.abortAll()
    releasePreparation()

    await expect(request).rejects.toBeInstanceOf(AbortError)
    expect(fetchHandler).not.toHaveBeenCalled()
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('tracks the request a transformRequest hook returns', async () => {
    let fetchedUrl: string | undefined
    let trackedDuringDispatch: string | undefined
    let client!: ReturnType<typeof createClient>
    client = createClient({
      hooks: {
        transformRequest: (request) =>
          new Request('https://example.com/transformed', request),
      },
      fetchHandler: async (input) => {
        fetchedUrl = (input as Request).url
        trackedDuringDispatch = client.pendingRequests[0]?.request.url
        return new Response('ok')
      },
    })

    const response = await client('https://example.com/original')

    expect(response.status).toBe(200)
    expect(fetchedUrl).toBe('https://example.com/transformed')
    expect(trackedDuringDispatch).toBe('https://example.com/transformed')
    expect(client.pendingRequests).toHaveLength(0)
  })
})

describe('lifecycle teardown failures', () => {
  it('fails the call when onFinally throws after a successful request, and still runs every cleanup', async () => {
    const events: string[] = []
    const hookFailure = new Error('onFinally boom')
    const onComplete = vi.fn()
    const client = createClient({
      hooks: { onComplete },
      plugins: [
        {
          name: 'a',
          onFinally: () => {
            events.push('a.onFinally')
            throw hookFailure
          },
        },
        {
          name: 'b',
          onFinally: () => {
            events.push('b.onFinally')
          },
        },
      ],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await expect(client('https://example.com/finally-success')).rejects.toBe(
      hookFailure
    )

    // The response was already complete, so `onComplete` saw the success, and
    // the plugin behind `a` still cleaned up.
    expect(onComplete).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Response),
      undefined
    )
    expect(events).toEqual(['a.onFinally', 'b.onFinally'])
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('keeps the request error when onFinally throws after a failure', async () => {
    const events: string[] = []
    const requestFailure = new Error('transport failure')
    const client = createClient({
      retries: 0,
      plugins: [
        {
          name: 'a',
          onFinally: () => {
            events.push('a.onFinally')
            throw new Error('onFinally boom')
          },
        },
        {
          name: 'b',
          onFinally: () => {
            events.push('b.onFinally')
            throw new Error('second onFinally boom')
          },
        },
      ],
      fetchHandler: async () => {
        throw requestFailure
      },
    })

    const error = await client('https://example.com/finally-failure').catch(
      (err: unknown) => err
    )

    // The cleanup hooks failed, but the caller still learns why the request
    // failed instead of why the teardown did.
    expect(error).toBeInstanceOf(RetryLimitError)
    expect((error as RetryLimitError).cause).toBe(requestFailure)
    expect(events).toEqual(['a.onFinally', 'b.onFinally'])
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('runs every onError hook and reports the first hook error', async () => {
    const events: string[] = []
    const hookFailure = new Error('onError boom')
    const client = createClient({
      plugins: [
        {
          name: 'a',
          onError: () => {
            events.push('a.onError')
            throw hookFailure
          },
        },
        {
          name: 'b',
          onError: () => {
            events.push('b.onError')
          },
        },
      ],
      fetchHandler: async () => {
        throw new Error('transport failure')
      },
    })

    // A plugin replaces the failure it saw by throwing from `onError` - that is
    // how `circuitPlugin` reports an open circuit - without hiding it from the
    // plugin behind it.
    await expect(client('https://example.com/onerror-throw')).rejects.toBe(
      hookFailure
    )
    expect(events).toEqual(['a.onError', 'b.onError'])
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('does not accumulate pendingRequests across repeated hook failures', async () => {
    const client = createClient({
      plugins: [
        {
          name: 'a',
          onFinally: () => {
            throw new Error('onFinally boom')
          },
        },
      ],
      fetchHandler: async () => new Response('ok'),
    })

    for (let call = 0; call < 3; call++) {
      await expect(client(`https://example.com/leak/${call}`)).rejects.toThrow(
        'onFinally boom'
      )

      expect(client.pendingRequests).toHaveLength(0)
    }
  })
})
