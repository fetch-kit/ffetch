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
})
