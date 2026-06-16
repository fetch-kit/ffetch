// @vitest-environment node
// This test MUST run in the Node.js environment (not happy-dom) because only
// Node.js/undici enforces the Fetch API spec rule that constructing a new Request
// from an already-consumed Request throws:
//   "Cannot construct a Request with a Request object that has already been used."
// happy-dom silently copies the body, masking the regression.

import { createServer } from 'node:http'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '../../src/client.js'

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

describe('retry POST with body — Node.js native fetch (undici)', () => {
  it('succeeds on retry after 500 without throwing body-already-used error', async () => {
    let callCount = 0
    requestHandler = (_req, res) => {
      callCount++
      if (callCount === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream error' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    }

    const f = createClient({ retries: 1 })
    const res = await f(`${baseUrl}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    })

    expect(res.status).toBe(200)
    expect(callCount).toBe(2)
  })

  it('exhausts all retries with body without throwing body-already-used error', async () => {
    let callCount = 0
    requestHandler = (_req, res) => {
      callCount++
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'upstream error' }))
    }

    const f = createClient({ retries: 2 })
    const res = await f(`${baseUrl}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    })

    expect(res.status).toBe(500)
    expect(callCount).toBe(3)
  })
})
