import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { RetryLimitError } from '../../src/error.js'
import { responseShortcutsPlugin } from '../../src/plugins/response-shortcuts.js'

describe('response shortcuts plugin', () => {
  it('attaches shortcut methods as non-enumerable properties', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () => new Response('{"ok":true}', { status: 200 }),
    })

    const pending = client(
      'https://example.com/shortcuts'
    ) as Promise<Response> & {
      json: <T = unknown>() => Promise<T>
      text: () => Promise<string>
      blob: () => Promise<Blob>
      arrayBuffer: () => Promise<ArrayBuffer>
      formData: () => Promise<FormData>
    }

    expect(typeof pending.json).toBe('function')
    expect(typeof pending.text).toBe('function')
    expect(typeof pending.blob).toBe('function')
    expect(typeof pending.arrayBuffer).toBe('function')
    expect(typeof pending.formData).toBe('function')
    expect(Object.keys(pending)).not.toContain('json')

    const descriptor = Object.getOwnPropertyDescriptor(pending, 'json')
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)

    await expect(pending).resolves.toBeInstanceOf(Response)
  })

  it('supports client(url).json() and client(url).text() flows', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"value":42}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(new Response('hello world', { status: 200 })),
    })

    const jsonData = await client('https://example.com/json').json<{
      value: number
    }>()
    const textData = await client('https://example.com/text').text()

    expect(jsonData.value).toBe(42)
    expect(textData).toBe('hello world')
  })

  it('preserves native await behavior for Response objects', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    const response = await client('https://example.com/native-response')
    expect(response).toBeInstanceOf(Response)
    expect(await response.text()).toBe('ok')
  })

  it('is safe when the plugin is configured multiple times', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin(), responseShortcutsPlugin()],
      fetchHandler: async () => new Response('{"multi":true}', { status: 200 }),
    })

    const data = await client('https://example.com/multi').json<{
      multi: boolean
    }>()
    expect(data.multi).toBe(true)
  })

  it('propagates request rejection through shortcut calls', async () => {
    const client = createClient({
      retries: 0,
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () => {
        throw new Error('boom')
      },
    })

    await expect(
      client('https://example.com/reject').json()
    ).rejects.toBeInstanceOf(RetryLimitError)
  })

  it('supports client(url).blob() flow', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () =>
        new Response('hello blob', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    })

    const data = await client('https://example.com/blob').blob()
    expect(data).toBeInstanceOf(Blob)
    await expect(data.text()).resolves.toBe('hello blob')
  })

  it('supports client(url).arrayBuffer() flow', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () => new Response('ABC', { status: 200 }),
    })

    const data = await client('https://example.com/arraybuffer').arrayBuffer()
    const bytes = Array.from(new Uint8Array(data))
    expect(bytes).toEqual([65, 66, 67])
  })

  it('supports client(url).formData() flow', async () => {
    const client = createClient({
      plugins: [responseShortcutsPlugin()],
      fetchHandler: async () =>
        new Response('a=1&b=two', {
          status: 200,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
    })

    const data = await client('https://example.com/formdata').formData()
    expect(data.get('a')).toBe('1')
    expect(data.get('b')).toBe('two')
  })
})
