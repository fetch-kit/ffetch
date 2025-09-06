import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createClient from '../src/index.js'

describe('Pending Requests', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tracks request in pendingRequests during execution and removes it after completion', async () => {
    let fetchResolve: (value: Response) => void
    let fetchPromise: Promise<Response>

    // Mock fetch with a controllable promise
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchPromise = new Promise((resolve) => {
        fetchResolve = resolve
      })
      return fetchPromise
    })

    const client = createClient()

    // Initially no pending requests
    expect(client.pendingRequests).toHaveLength(0)

    // Start a request
    const promise = client('https://example.com/api')

    // Give it a moment for the promise to be added
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Should immediately appear in pending requests
    expect(client.pendingRequests).toHaveLength(1)
    expect(client.pendingRequests[0]).toMatchObject({
      request: expect.objectContaining({
        url: 'https://example.com/api',
      }),
      signal: expect.any(AbortSignal),
      promise: expect.any(Promise),
    })

    // Resolve the fetch
    fetchResolve!(new Response('success'))

    // Wait for the request to complete
    const response = await promise
    expect(response).toBeInstanceOf(Response)

    // Should be removed from pending requests after completion
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('tracks multiple concurrent requests', async () => {
    const resolvers: ((value: Response) => void)[] = []

    global.fetch = vi.fn().mockImplementation(async () => {
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const client = createClient()

    // Start multiple requests
    const promise1 = client('https://example.com/fast')
    const promise2 = client('https://example.com/slow')
    const promise3 = client('https://example.com/fast2')

    // Give promises time to be added
    await new Promise((resolve) => setTimeout(resolve, 0))

    // All should be tracked
    expect(client.pendingRequests).toHaveLength(3)

    // Check URLs are correct
    const urls = client.pendingRequests.map((p) => p.request.url)
    expect(urls).toContain('https://example.com/fast')
    expect(urls).toContain('https://example.com/slow')
    expect(urls).toContain('https://example.com/fast2')

    // Resolve all requests
    resolvers.forEach((resolve, i) => {
      resolve(new Response(`response ${i}`))
    })

    // Wait for all to complete
    await Promise.all([promise1, promise2, promise3])

    // All should be removed
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('removes request from pendingRequests even when request fails', async () => {
    let fetchReject: (error: Error) => void

    global.fetch = vi.fn().mockImplementation(async () => {
      return new Promise<Response>((resolve, reject) => {
        fetchReject = reject
      })
    })

    const client = createClient({ retries: 0 })

    // Start a request that will fail
    const promise = client('https://example.com/fail')

    // Give it time to be added
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Should be tracked
    expect(client.pendingRequests).toHaveLength(1)

    // Reject the fetch
    fetchReject!(new Error('Network error'))

    // Wait for it to fail
    await expect(promise).rejects.toThrow()

    // Should be removed even after failure
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('allows aborting pending requests via external abort controller', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return new Promise<Response>((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
        // Don't resolve automatically - let abort handle it
      })
    })

    const client = createClient()
    const controller = new AbortController()

    // Start a request with external abort controller
    const promise = client('https://example.com/long', {
      signal: controller.signal,
    })

    // Give it time to be added
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Should be tracked
    expect(client.pendingRequests).toHaveLength(1)

    // The pending request should have the combined signal
    const pendingRequest = client.pendingRequests[0]
    expect(pendingRequest.signal.aborted).toBe(false)

    // Abort using external controller
    controller.abort()

    // Request should fail with abort error
    await expect(promise).rejects.toThrow()

    // Should be removed after abort
    expect(client.pendingRequests).toHaveLength(0)
  })

  it('maintains separate pending requests arrays for different client instances', async () => {
    const resolvers: ((value: Response) => void)[] = []

    global.fetch = vi.fn().mockImplementation(async () => {
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const client1 = createClient()
    const client2 = createClient()

    // Start requests on different clients
    const promise1 = client1('https://example.com/client1')
    const promise2 = client2('https://example.com/client2')

    // Give time for requests to be added
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Each client should only track its own requests
    expect(client1.pendingRequests).toHaveLength(1)
    expect(client2.pendingRequests).toHaveLength(1)
    expect(client1.pendingRequests[0].request.url).toBe(
      'https://example.com/client1'
    )
    expect(client2.pendingRequests[0].request.url).toBe(
      'https://example.com/client2'
    )

    // Resolve both requests
    resolvers.forEach((resolve) => resolve(new Response('success')))

    // Wait for completion
    await Promise.all([promise1, promise2])

    // Both should be empty
    expect(client1.pendingRequests).toHaveLength(0)
    expect(client2.pendingRequests).toHaveLength(0)
  })

  it('tracks requests through retries', async () => {
    let attemptCount = 0
    let finalResolve: (value: Response) => void

    global.fetch = vi.fn().mockImplementation(async () => {
      attemptCount++

      if (attemptCount < 3) {
        throw new Error('Temporary failure')
      }

      return new Promise<Response>((resolve) => {
        finalResolve = resolve
      })
    })

    const client = createClient({ retries: 3, retryDelay: 10 })

    // Start a request that will retry
    const promise = client('https://example.com/retry')

    // Give time for initial request to be added
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should be tracked throughout the retry process
    expect(client.pendingRequests).toHaveLength(1)
    expect(client.pendingRequests[0].request.url).toBe(
      'https://example.com/retry'
    )

    // Resolve the final successful attempt
    finalResolve!(new Response('success after retries'))

    // Wait for successful completion after retries
    const response = await promise
    expect(response).toBeInstanceOf(Response)
    expect(attemptCount).toBe(3)

    // Should be removed after successful completion
    expect(client.pendingRequests).toHaveLength(0)
  })
})
