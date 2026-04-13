import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError, BulkheadFullError } from '../../src/error.js'
import { bulkheadPlugin } from '../../src/plugins/bulkhead.js'

type BulkheadClientState = {
  activeCount: number
  queueDepth: number
}

describe('bulkhead plugin', () => {
  it('exposes metadata defaults', () => {
    const plugin = bulkheadPlugin({ maxConcurrent: 2 })
    expect(plugin.name).toBe('bulkhead')
    expect(plugin.order).toBe(5)
  })

  it('queues requests beyond maxConcurrent and drains in FIFO order', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 2 })],
    }) as typeof createClient extends never
      ? never
      : BulkheadClientState & ReturnType<typeof createClient>

    const p1 = client('https://example.com/1')
    const p2 = client('https://example.com/2')
    const p3 = client('https://example.com/3')

    await vi.waitFor(() => {
      expect(fetchHandler).toHaveBeenCalledTimes(1)
      expect(client.activeCount).toBe(1)
      expect(client.queueDepth).toBe(2)
    })

    resolvers[0](new Response('one', { status: 200 }))
    await p1
    await Promise.resolve()

    expect(fetchHandler).toHaveBeenCalledTimes(2)
    expect(client.activeCount).toBe(1)
    expect(client.queueDepth).toBe(1)

    resolvers[1](new Response('two', { status: 200 }))
    await p2
    await Promise.resolve()

    expect(fetchHandler).toHaveBeenCalledTimes(3)
    expect(client.activeCount).toBe(1)
    expect(client.queueDepth).toBe(0)

    resolvers[2](new Response('three', { status: 200 }))
    await p3

    expect(client.activeCount).toBe(0)
    expect(client.queueDepth).toBe(0)
  })

  it('throws BulkheadFullError when queue is full', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 1 })],
    })

    const p1 = client('https://example.com/1')
    const p2 = client('https://example.com/2')

    await expect(client('https://example.com/3')).rejects.toThrow(
      BulkheadFullError
    )

    resolvers[0](new Response('ok', { status: 200 }))
    await p1
    resolvers[1](new Response('ok', { status: 200 }))
    await p2
  })

  it('calls onReject when queue overflows', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )
    const onReject = vi.fn()

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 1, onReject })],
    })

    const p1 = client('https://example.com/1')
    const p2 = client('https://example.com/2')

    await expect(client('https://example.com/3')).rejects.toThrow(
      BulkheadFullError
    )
    expect(onReject).toHaveBeenCalledTimes(1)

    resolvers[0](new Response('ok', { status: 200 }))
    await p1
    resolvers[1](new Response('ok', { status: 200 }))
    await p2
  })

  it('frees slot when active request fails', async () => {
    let calls = 0
    const fetchHandler = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 1 })],
    })

    const p1 = client('https://example.com/1')
    const p2 = client('https://example.com/2')

    await expect(p1).rejects.toThrow('boom')
    const r2 = await p2

    expect(r2.status).toBe(200)
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })

  it('rejects queued requests that abort before acquiring a slot', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 2 })],
    }) as BulkheadClientState & ReturnType<typeof createClient>

    const p1 = client('https://example.com/1')

    const controller = new AbortController()
    const p2 = client('https://example.com/2', { signal: controller.signal })

    await vi.waitFor(() => {
      expect(client.queueDepth).toBe(1)
    })

    controller.abort(new Error('cancel queued'))
    await expect(p2).rejects.toThrow(AbortError)
    expect(client.queueDepth).toBe(0)

    const p3 = client('https://example.com/3')
    await vi.waitFor(() => {
      expect(client.queueDepth).toBe(1)
    })

    resolvers[0](new Response('ok', { status: 200 }))
    await p1
    await Promise.resolve()

    expect(fetchHandler).toHaveBeenCalledTimes(2)
    resolvers[1](new Response('ok', { status: 200 }))
    await p3
  })

  it('rejects immediately when signal is already aborted before enqueue', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )

    const client = createClient({
      fetchHandler,
      plugins: [bulkheadPlugin({ maxConcurrent: 1, maxQueue: 2 })],
    }) as BulkheadClientState & ReturnType<typeof createClient>

    const p1 = client('https://example.com/1')

    const controller = new AbortController()
    controller.abort(new Error('already aborted'))

    await expect(
      client('https://example.com/pre-aborted', { signal: controller.signal })
    ).rejects.toThrow(AbortError)

    expect(client.queueDepth).toBe(0)
    expect(fetchHandler).toHaveBeenCalledTimes(1)

    resolvers[0](new Response('ok', { status: 200 }))
    await p1
  })

  it('supports order override', () => {
    const plugin = bulkheadPlugin({ maxConcurrent: 2, order: 11 })
    expect(plugin.order).toBe(11)
  })
})
