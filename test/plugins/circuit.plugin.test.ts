import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { CircuitOpenError } from '../../src/error.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'

describe('circuit plugin parity', () => {
  it('opens after threshold failures and blocks while open', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 2, reset: 1000 })],
    })

    const r1 = await client('https://example.com/circuit-1')
    await expect(client('https://example.com/circuit-2')).rejects.toThrow(
      CircuitOpenError
    )

    expect(r1.status).toBe(500)
    expect(client.circuitOpen).toBe(true)

    await expect(client('https://example.com/circuit-3')).rejects.toThrow(
      CircuitOpenError
    )
  })

  it('resets after timeout and closes on a successful probe', async () => {
    let failMode = true
    global.fetch = vi.fn().mockImplementation(async () => {
      if (failMode) {
        return new Response('fail', { status: 500 })
      }
      return new Response('ok', { status: 200 })
    })

    const onCircuitOpen = vi.fn()
    const onCircuitClose = vi.fn()

    const client = createClient({
      retries: 0,
      plugins: [
        circuitPlugin({
          threshold: 1,
          reset: 50,
          onCircuitOpen,
          onCircuitClose,
        }),
      ],
    })

    await expect(client('https://example.com/open')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
    expect(onCircuitOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: expect.objectContaining({ type: 'threshold-reached' }),
      })
    )

    await expect(client('https://example.com/blocked')).rejects.toThrow(
      CircuitOpenError
    )
    expect(onCircuitOpen).toHaveBeenCalledTimes(2)
    expect(onCircuitOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: { type: 'already-open' },
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 70))

    failMode = false
    const recovered = await client('https://example.com/recover')

    expect(recovered.status).toBe(200)
    expect(client.circuitOpen).toBe(false)
    expect(onCircuitClose).toHaveBeenCalledTimes(1)
    expect(onCircuitClose).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        response: expect.any(Response),
      })
    )
  })

  it('treats HTTP 429 as a circuit failure signal', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 200 })],
    })

    await expect(client('https://example.com/rate-limit')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)

    await expect(client('https://example.com/rate-limit-2')).rejects.toThrow(
      CircuitOpenError
    )
  })

  it('resets failure counter after success before reaching threshold', async () => {
    const statuses = [500, 200, 500, 200]
    global.fetch = vi.fn().mockImplementation(async () => {
      const status = statuses.shift() ?? 200
      return new Response(String(status), { status })
    })

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 2, reset: 500 })],
    })

    await client('https://example.com/mix-1')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-2')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-3')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-4')
    expect(client.circuitOpen).toBe(false)
  })

  it('counts network errors (thrown) toward threshold, not just bad responses', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network fail'))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 3, reset: 500 })],
    })

    // First two throw the underlying error — circuit not open yet
    await expect(client('https://example.com/net-1')).rejects.toThrow(
      'network fail'
    )
    expect(client.circuitOpen).toBe(false)

    await expect(client('https://example.com/net-2')).rejects.toThrow(
      'network fail'
    )
    expect(client.circuitOpen).toBe(false)

    // Third failure reaches threshold — circuit opens, error is rewritten to CircuitOpenError
    await expect(client('https://example.com/net-3')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)
  })

  it('fires onCircuitOpen and onCircuitClose when failure is a network error', async () => {
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) throw new Error('fail')
      return new Response('ok')
    })

    const onCircuitOpen = vi.fn()
    const onCircuitClose = vi.fn()

    const client = createClient({
      retries: 0,
      plugins: [
        circuitPlugin({
          threshold: 2,
          reset: 50,
          onCircuitOpen,
          onCircuitClose,
        }),
      ],
    })

    await expect(client('https://example.com/hooks-net-1')).rejects.toThrow(
      'fail'
    )
    await expect(client('https://example.com/hooks-net-2')).rejects.toThrow(
      CircuitOpenError
    )
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
    expect(onCircuitOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: expect.objectContaining({
          type: 'threshold-reached',
          error: expect.any(Error),
        }),
      })
    )
    expect(client.circuitOpen).toBe(true)

    await new Promise((r) => setTimeout(r, 70))

    const recovered = await client('https://example.com/hooks-net-recover')
    expect(recovered.status).toBe(200)
    expect(onCircuitClose).toHaveBeenCalledTimes(1)
    expect(onCircuitClose).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        response: expect.any(Response),
      })
    )
    expect(client.circuitOpen).toBe(false)
  })
})
