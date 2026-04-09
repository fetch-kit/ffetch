import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { CircuitOpenError } from '../../src/error.js'
import { dedupePlugin } from '../../src/plugins/dedupe.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'
import { responseShortcutsPlugin } from '../../src/plugins/response-shortcuts.js'
import type { ClientPlugin } from '../../src/plugins.js'

describe('plugin ordering and interactions', () => {
  it('applies plugin order before registration order in preRequest lifecycle', async () => {
    const calls: string[] = []

    const late: ClientPlugin = {
      name: 'late',
      order: 50,
      preRequest: () => {
        calls.push('late')
      },
    }

    const early: ClientPlugin = {
      name: 'early',
      order: -10,
      preRequest: () => {
        calls.push('early')
      },
    }

    const tieA: ClientPlugin = {
      name: 'tie-a',
      order: 10,
      preRequest: () => {
        calls.push('tie-a')
      },
    }

    const tieB: ClientPlugin = {
      name: 'tie-b',
      order: 10,
      preRequest: () => {
        calls.push('tie-b')
      },
    }

    const client = createClient({
      plugins: [late, tieA, early, tieB],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await client('https://example.com/order')
    expect(calls).toEqual(['early', 'tie-a', 'tie-b', 'late'])
  })

  it('dedupe + circuit interaction: one network call can trip circuit based on plugin callbacks', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))

    const plugins = [
      dedupePlugin(),
      circuitPlugin({ threshold: 2, reset: 200 }),
    ] as const

    const client = createClient({
      retries: 0,
      plugins,
    })

    const results = await Promise.allSettled([
      client('https://example.com/shared-failure'),
      client('https://example.com/shared-failure'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(
      (fulfilled[0] as PromiseFulfilledResult<Response>).value.status
    ).toBe(500)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      CircuitOpenError
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)

    expect(client.circuitOpen).toBe(true)
    await expect(
      client('https://example.com/blocked-after-shared')
    ).rejects.toThrow(CircuitOpenError)
  })

  it('custom plugin can override dedupe key before dedupe runs when order is lower', async () => {
    const forceUniquePlugin: ClientPlugin = {
      name: 'force-unique-key',
      order: 0,
      preRequest: (ctx) => {
        ctx.state.unique = crypto.randomUUID()
      },
      wrapDispatch: (next) => async (ctx) => {
        const originalUrl = new URL(ctx.request.url)
        originalUrl.searchParams.set('nonce', String(ctx.state.unique))
        ctx.request = new Request(originalUrl.toString(), ctx.request)
        return next(ctx)
      },
    }

    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }))

    const client = createClient({
      plugins: [forceUniquePlugin, dedupePlugin()],
    })

    await Promise.all([
      client('https://example.com/custom-order'),
      client('https://example.com/custom-order'),
    ])

    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('response-shortcuts + dedupe keeps deduped requests working', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const client = createClient({
      plugins: [responseShortcutsPlugin(), dedupePlugin()],
    })

    const p1 = client('https://example.com/shortcuts-dedupe')
    const p2 = client('https://example.com/shortcuts-dedupe')

    expect(typeof p1.json).toBe('function')
    expect(typeof p2.text).toBe('function')

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('response-shortcuts preserves circuit errors through shortcut chaining', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))

    const client = createClient({
      retries: 0,
      plugins: [
        responseShortcutsPlugin(),
        circuitPlugin({ threshold: 1, reset: 200 }),
      ],
    })

    await expect(
      client('https://example.com/shortcuts-circuit').json()
    ).rejects.toBeInstanceOf(CircuitOpenError)
  })
})
