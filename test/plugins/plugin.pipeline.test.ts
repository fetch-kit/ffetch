import { describe, it, expect } from 'vitest'

import { createClient } from '../../src/client.js'
import type { ClientPlugin } from '../../src/plugins.js'
import { RetryLimitError } from '../../src/error.js'

describe('plugin pipeline', () => {
  it('runs lifecycle hooks in sorted plugin order on success', async () => {
    const events: string[] = []

    const pluginA: ClientPlugin = {
      name: 'a',
      order: 20,
      preRequest: () => {
        events.push('a.pre')
      },
      wrapDispatch: (next) => async (ctx) => {
        events.push('a.wrap.before')
        const res = await next(ctx)
        events.push('a.wrap.after')
        return res
      },
      onSuccess: () => {
        events.push('a.success')
      },
      onFinally: () => {
        events.push('a.finally')
      },
    }

    const pluginB: ClientPlugin = {
      name: 'b',
      order: 10,
      preRequest: () => {
        events.push('b.pre')
      },
      wrapDispatch: (next) => async (ctx) => {
        events.push('b.wrap.before')
        const res = await next(ctx)
        events.push('b.wrap.after')
        return res
      },
      onSuccess: () => {
        events.push('b.success')
      },
      onFinally: () => {
        events.push('b.finally')
      },
    }

    const client = createClient({
      plugins: [pluginA, pluginB],
      fetchHandler: async () => {
        events.push('fetch')
        return new Response('ok', { status: 200 })
      },
    })

    const response = await client('https://example.com/pipeline-success')
    expect(response.status).toBe(200)

    expect(events).toEqual([
      'b.pre',
      'a.pre',
      'b.wrap.before',
      'a.wrap.before',
      'fetch',
      'a.wrap.after',
      'b.wrap.after',
      'b.success',
      'a.success',
      'b.finally',
      'a.finally',
    ])
  })

  it('runs onError and onFinally in sorted order on failure', async () => {
    const events: string[] = []

    const first: ClientPlugin = {
      name: 'first',
      order: 1,
      onError: (_ctx, error) => {
        events.push(`first.error.${error instanceof RetryLimitError}`)
      },
      onFinally: () => {
        events.push('first.finally')
      },
    }

    const second: ClientPlugin = {
      name: 'second',
      order: 2,
      onError: (_ctx, error) => {
        events.push(`second.error.${error instanceof RetryLimitError}`)
      },
      onFinally: () => {
        events.push('second.finally')
      },
    }

    const client = createClient({
      retries: 0,
      plugins: [second, first],
      fetchHandler: async () => {
        throw new Error('boom')
      },
    })

    await expect(client('https://example.com/pipeline-error')).rejects.toThrow(
      RetryLimitError
    )

    expect(events).toEqual([
      'first.error.true',
      'second.error.true',
      'first.finally',
      'second.finally',
    ])
  })

  it('supports plugin-defined client extensions via setup', async () => {
    const plugin: ClientPlugin<{ pluginName: string; dynamicValue: number }> = {
      name: 'extension-plugin',
      setup: ({ defineExtension }) => {
        defineExtension('pluginName', { value: 'extension-plugin' })
        defineExtension('dynamicValue', {
          get: () => 42,
        })
      },
    }

    const client = createClient({
      plugins: [plugin],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    expect(client.pluginName).toBe('extension-plugin')
    expect(client.dynamicValue).toBe(42)
    await expect(
      client('https://example.com/extensions')
    ).resolves.toBeInstanceOf(Response)
  })

  it('throws when multiple plugins define the same extension key', () => {
    const first: ClientPlugin<{ conflict: number }> = {
      name: 'first',
      setup: ({ defineExtension }) => {
        defineExtension('conflict', { value: 1 })
      },
    }

    const second: ClientPlugin<{ conflict: number }> = {
      name: 'second',
      setup: ({ defineExtension }) => {
        defineExtension('conflict', { value: 2 })
      },
    }

    expect(() => {
      createClient({ plugins: [first, second] })
    }).toThrow('Plugin extension collision for property "conflict"')
  })

  it('keeps registration order when plugin order values are equal', async () => {
    const calls: string[] = []

    const first: ClientPlugin = {
      name: 'first',
      order: 5,
      preRequest: () => {
        calls.push('first')
      },
    }

    const second: ClientPlugin = {
      name: 'second',
      order: 5,
      preRequest: () => {
        calls.push('second')
      },
    }

    const client = createClient({
      plugins: [first, second],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await client('https://example.com/equal-order')
    expect(calls).toEqual(['first', 'second'])
  })

  it('passes mutable plugin state across lifecycle handlers in one request', async () => {
    const lifecycle: string[] = []

    const plugin: ClientPlugin = {
      name: 'state-check',
      preRequest: (ctx) => {
        ctx.state.correlationId = 'abc-123'
        lifecycle.push('pre')
      },
      wrapDispatch: (next) => async (ctx) => {
        lifecycle.push(`wrap:${String(ctx.state.correlationId)}`)
        return next(ctx)
      },
      onSuccess: (ctx) => {
        lifecycle.push(`success:${String(ctx.state.correlationId)}`)
      },
    }

    const client = createClient({
      plugins: [plugin],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await client('https://example.com/state')
    expect(lifecycle).toEqual(['pre', 'wrap:abc-123', 'success:abc-123'])
  })

  it('invokes plugin hooks for each request context independently', async () => {
    const requestIds: string[] = []

    const plugin: ClientPlugin = {
      name: 'request-scope',
      preRequest: (ctx) => {
        ctx.state.requestId = crypto.randomUUID()
      },
      onFinally: (ctx) => {
        requestIds.push(String(ctx.state.requestId))
      },
    }

    const client = createClient({
      plugins: [plugin],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await client('https://example.com/one')
    await client('https://example.com/two')

    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).not.toBe(requestIds[1])
  })

  it('applies decoratePromise hooks in sorted plugin order', async () => {
    const calls: string[] = []

    const pluginA: ClientPlugin<Record<never, never>, { aDecorated: true }> = {
      name: 'a',
      order: 20,
      decoratePromise: (promise) => {
        calls.push('a.decorate')
        Object.defineProperty(promise, 'aDecorated', {
          value: true,
          enumerable: false,
          writable: false,
          configurable: false,
        })
        return promise as Promise<Response> & { aDecorated: true }
      },
    }

    const pluginB: ClientPlugin<Record<never, never>, { bDecorated: true }> = {
      name: 'b',
      order: 10,
      decoratePromise: (promise) => {
        calls.push('b.decorate')
        Object.defineProperty(promise, 'bDecorated', {
          value: true,
          enumerable: false,
          writable: false,
          configurable: false,
        })
        return promise as Promise<Response> & { bDecorated: true }
      },
    }

    const client = createClient({
      plugins: [pluginA, pluginB],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    const pending = client(
      'https://example.com/decorate-order'
    ) as Promise<Response> & {
      aDecorated: true
      bDecorated: true
    }

    expect(calls).toEqual(['b.decorate', 'a.decorate'])
    expect(pending.bDecorated).toBe(true)
    expect(pending.aDecorated).toBe(true)
    await expect(pending).resolves.toBeInstanceOf(Response)
  })

  it('keeps decoratePromise and wrapDispatch behavior composable', async () => {
    const events: string[] = []

    const plugin: ClientPlugin<Record<never, never>, { tagged: true }> = {
      name: 'compose',
      wrapDispatch: (next) => async (ctx) => {
        events.push('wrap.before')
        const res = await next(ctx)
        events.push('wrap.after')
        return res
      },
      decoratePromise: (promise) => {
        events.push('decorate')
        Object.defineProperty(promise, 'tagged', {
          value: true,
          enumerable: false,
          writable: false,
          configurable: false,
        })
        return promise as Promise<Response> & { tagged: true }
      },
    }

    const client = createClient({
      plugins: [plugin],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    const pending = client(
      'https://example.com/compose'
    ) as Promise<Response> & {
      tagged: true
    }

    expect(pending.tagged).toBe(true)
    await pending
    expect(events).toEqual(['decorate', 'wrap.before', 'wrap.after'])
  })
})
