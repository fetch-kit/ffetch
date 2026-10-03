import { createServer } from 'node:http'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '../../src/client.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

let server: Server
let baseUrl: string
let requestHandler: (req: IncomingMessage, res: ServerResponse) => void

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => requestHandler(req, res))
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
)

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
)

describe('hedge fallback response — Node.js native fetch (undici)', () => {
  it('keeps the returned 5xx body readable when the hedge attempt fails', async () => {
    let requestCount = 0
    requestHandler = (req, res) => {
      requestCount++
      if (requestCount === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream unavailable' }))
        return
      }
      // The hedge attempt dies before sending a response.
      req.socket.destroy()
    }

    const f = createClient({ plugins: [hedgePlugin({ delay: 20 })] })
    const res = await f(`${baseUrl}/flaky`)

    expect(requestCount).toBe(2)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe(
      JSON.stringify({ error: 'upstream unavailable' })
    )
  })
})
