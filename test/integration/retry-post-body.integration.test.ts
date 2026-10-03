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

  it('sends the same body on the retry as on the first attempt', async () => {
    const bodies: string[] = []
    requestHandler = (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        bodies.push(body)
        const status = bodies.length === 1 ? 500 : 200
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: status === 200 }))
      })
    }

    const f = createClient({ retries: 1 })
    const res = await f(`${baseUrl}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    })

    expect(res.status).toBe(200)
    expect(bodies).toEqual([
      JSON.stringify({ key: 'value' }),
      JSON.stringify({ key: 'value' }),
    ])
  })
})
