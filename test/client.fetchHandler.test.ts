import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../src/client'

// A mock fetch implementation for testing
function mockFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let url: string
  let method: string
  if (input instanceof Request) {
    url = input.url
    method = input.method
  } else {
    url = typeof input === 'string' ? input : input.toString()
    method = init?.method || 'GET'
  }
  const body = JSON.stringify({
    url,
    method,
    signalAborted: init?.signal?.aborted || false,
  })
  const response = new Response(body, { status: 200 })
  return Promise.resolve(response)
}

describe('ffetch fetchHandler option', () => {
  it('uses the provided fetchHandler instead of global fetch', async () => {
    const fetchSpy = vi.fn(mockFetch)
    const client = createClient({ fetchHandler: fetchSpy })
    const res = await client('https://example.com', { method: 'POST' })
    const json = await res.json()
    expect(fetchSpy).toHaveBeenCalled()
    expect(json.url).toBe('https://example.com/')
    expect(json.method).toBe('POST')
  })

  it('passes the signal to fetchHandler', async () => {
    const fetchSpy = vi.fn(mockFetch)
    const client = createClient({ fetchHandler: fetchSpy })
    const controller = new AbortController()
    const res = await client('https://signal.com', {
      signal: controller.signal,
    })
    const json = await res.json()
    expect(json.signalAborted).toBe(false)
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
  })

  it('aborts the request using the signal', async () => {
    // Simulate fetch that rejects if signal is aborted
    const fetchHandler = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return Promise.resolve(new Response('ok', { status: 200 }))
    }
    const client = createClient({ fetchHandler })
    const controller = new AbortController()
    controller.abort()
    await expect(
      client('https://abort.com', { signal: controller.signal })
    ).rejects.toThrow('Request was aborted')
  })

  it('falls back to global fetch if fetchHandler is not provided', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(() => Promise.resolve(new Response('ok')))
    const client = createClient()
    const res = await client('https://example.com')
    expect(res).toBeInstanceOf(Response)
    expect(global.fetch).toHaveBeenCalled()
    global.fetch = originalFetch
  })

  it('allows per-request fetchHandler override', async () => {
    const clientFetchSpy = vi.fn(mockFetch)
    const requestFetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ from: 'request' }), { status: 200 })
      )
    )

    const client = createClient({ fetchHandler: clientFetchSpy })
    const res = await client('https://example.com', {
      fetchHandler: requestFetchSpy,
    })
    const json = await res.json()

    expect(clientFetchSpy).not.toHaveBeenCalled()
    expect(requestFetchSpy).toHaveBeenCalled()
    expect(json.from).toBe('request')
  })

  it('uses client fetchHandler when no per-request override is provided', async () => {
    const clientFetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ from: 'client' }), { status: 200 })
      )
    )

    const client = createClient({ fetchHandler: clientFetchSpy })
    const res = await client('https://example.com')
    const json = await res.json()

    expect(clientFetchSpy).toHaveBeenCalled()
    expect(json.from).toBe('client')
  })

  it('supports per-request fetchHandler without client-level handler', async () => {
    const requestFetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ from: 'request-only' }), { status: 200 })
      )
    )

    const client = createClient({ retries: 0 })
    const res = await client('https://example.com', {
      fetchHandler: requestFetchSpy,
    })
    const json = await res.json()

    expect(requestFetchSpy).toHaveBeenCalled()
    expect(json.from).toBe('request-only')
  })

  it('allows different fetchHandlers for different requests on same client', async () => {
    const fetch1 = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 }))
    )
    const fetch2 = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ id: 2 }), { status: 200 }))
    )

    const client = createClient({ retries: 0 })

    const res1 = await client('https://test1.com', { fetchHandler: fetch1 })
    const json1 = await res1.json()

    const res2 = await client('https://test2.com', { fetchHandler: fetch2 })
    const json2 = await res2.json()

    expect(fetch1).toHaveBeenCalledTimes(1)
    expect(fetch2).toHaveBeenCalledTimes(1)
    expect(json1.id).toBe(1)
    expect(json2.id).toBe(2)
  })
})
