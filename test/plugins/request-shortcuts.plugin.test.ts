import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { requestShortcutsPlugin } from '../../src/plugins/request-shortcuts.js'
import { responseShortcutsPlugin } from '../../src/plugins/response-shortcuts.js'

describe('request shortcuts plugin', () => {
  it('adds HTTP method convenience methods to the client', async () => {
    const methods: string[] = []
    const client = createClient({
      plugins: [requestShortcutsPlugin()],
      fetchHandler: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        methods.push(request.method)
        return new Response('ok', { status: 200 })
      },
    })

    await client.get('https://example.com/get')
    await client.post('https://example.com/post', { body: 'x' })
    await client.put('https://example.com/put', { body: 'x' })
    await client.patch('https://example.com/patch', { body: 'x' })
    await client.delete('https://example.com/delete')
    await client.head('https://example.com/head')
    await client.options('https://example.com/options')

    expect(methods).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ])
  })

  it('keeps method shortcut properties non-enumerable', () => {
    const client = createClient({
      plugins: [requestShortcutsPlugin()],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    expect(Object.keys(client)).not.toContain('get')
    expect(Object.keys(client)).not.toContain('post')

    const descriptor = Object.getOwnPropertyDescriptor(client, 'get')
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
  })

  it('method shortcuts force the expected HTTP method', async () => {
    const fetchHandler = vi
      .fn()
      .mockImplementation(async (input: RequestInfo) => {
        const request = input instanceof Request ? input : new Request(input)
        return new Response(request.method, { status: 200 })
      })

    const client = createClient({
      plugins: [requestShortcutsPlugin()],
      fetchHandler,
    })

    const response = await client.post('https://example.com/override', {
      method: 'GET',
      body: 'x',
    })

    await expect(response.text()).resolves.toBe('POST')
  })

  it('composes with response shortcuts plugin', async () => {
    const client = createClient({
      plugins: [requestShortcutsPlugin(), responseShortcutsPlugin()] as const,
      fetchHandler: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        return new Response(JSON.stringify({ method: request.method }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const data = await client.post('https://example.com/method-json').json<{
      method: string
    }>()

    expect(data.method).toBe('POST')
  })

  it('throws when a shortcut is called without a client function context', () => {
    const client = createClient({
      plugins: [requestShortcutsPlugin()],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    expect(() =>
      client.get.call(
        {} as unknown as typeof client,
        'https://example.com/invalid-context'
      )
    ).toThrow(
      'requestShortcutsPlugin methods must be called from a client instance'
    )
  })
})
