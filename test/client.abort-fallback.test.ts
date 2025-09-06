import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../src/client.js'

describe('AbortSignal.any fallback behavior', () => {
  it('respects user abort signal when AbortSignal.any is not available', async () => {
    // Temporarily remove AbortSignal.any to test fallback
    const originalAny = AbortSignal.any
    // @ts-expect-error: Intentionally removing for test
    AbortSignal.any = undefined

    try {
      // Mock fetch to simulate a slow request
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const signal = input instanceof Request ? input.signal : undefined
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }

          const timeout = setTimeout(() => {
            resolve(new Response('success'))
          }, 100) // 100ms delay

          signal?.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      })

      const client = createClient({ timeout: 5000 }) // Long timeout
      const controller = new AbortController()

      const requestPromise = client('https://example.com', {
        signal: controller.signal,
      })

      // Abort after 10ms (before the 100ms mock response)
      setTimeout(() => controller.abort(), 10)

      await expect(requestPromise).rejects.toThrow('Request was aborted')
    } finally {
      // Restore AbortSignal.any
      AbortSignal.any = originalAny
    }
  })

  it('respects timeout when user signal is provided but AbortSignal.any is not available', async () => {
    // Temporarily remove AbortSignal.any to test fallback
    const originalAny = AbortSignal.any
    // @ts-expect-error: Intentionally removing for test
    AbortSignal.any = undefined

    try {
      // Mock fetch to simulate a slow request
      global.fetch = vi.fn().mockImplementation(async (input) => {
        const signal = input instanceof Request ? input.signal : undefined
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }

          // Simulate a request that takes longer than timeout
          const timeout = setTimeout(() => {
            resolve(new Response('success'))
          }, 200) // 200ms delay

          signal?.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      })

      const client = createClient({ timeout: 50 }) // Short timeout
      const controller = new AbortController()

      const requestPromise = client('https://example.com', {
        signal: controller.signal,
      })

      // Don't abort manually - let timeout handle it
      await expect(requestPromise).rejects.toThrow('signal timed out')
    } finally {
      // Restore AbortSignal.any
      AbortSignal.any = originalAny
    }
  })
})
