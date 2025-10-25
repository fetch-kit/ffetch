import { describe, it, expect } from 'vitest'
import { dedupeRequestHash, DedupeHashParams } from '../src/dedupeRequestHash'

describe('dedupeRequestHash', () => {
  it('returns undefined for FormData body', () => {
    const form = new FormData()
    form.append('foo', 'bar')
    const params: DedupeHashParams = {
      method: 'POST',
      url: 'https://example.com',
      body: form,
    }
    expect(dedupeRequestHash(params)).toBeUndefined()
  })

  it('returns undefined for ReadableStream body', () => {
    // Only run this test if ReadableStream is available
    if (typeof ReadableStream !== 'undefined') {
      const stream = new ReadableStream()
      const params: DedupeHashParams = {
        method: 'POST',
        url: 'https://example.com',
        body: stream,
      }
      expect(dedupeRequestHash(params)).toBeUndefined()
    }
  })

  it('hashes GET with string body', () => {
    const params: DedupeHashParams = {
      method: 'GET',
      url: 'https://example.com',
      body: 'foo',
    }
    expect(dedupeRequestHash(params)).toBe('GET|https://example.com|foo')
  })

  it('hashes POST with URLSearchParams body', () => {
    const params: DedupeHashParams = {
      method: 'POST',
      url: 'https://example.com',
      body: new URLSearchParams({ a: '1', b: '2' }),
    }
    expect(dedupeRequestHash(params)).toBe('POST|https://example.com|a=1&b=2')
  })

  it('hashes PUT with ArrayBuffer body', () => {
    const buf = new TextEncoder().encode('abc').buffer
    const params: DedupeHashParams = {
      method: 'PUT',
      url: 'https://example.com',
      body: buf,
    }
    expect(dedupeRequestHash(params)).toMatch(/^PUT\|https:\/\/example.com\|/)
  })

  it('hashes PATCH with Uint8Array body', () => {
    const arr = new Uint8Array([1, 2, 3])
    const params: DedupeHashParams = {
      method: 'PATCH',
      url: 'https://example.com',
      body: arr,
    }
    expect(dedupeRequestHash(params)).toMatch(/^PATCH\|https:\/\/example.com\|/)
  })

  it('hashes POST with Blob body', () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const params: DedupeHashParams = {
      method: 'POST',
      url: 'https://example.com',
      body: blob,
    }
    expect(dedupeRequestHash(params)).toBe(
      `POST|https://example.com|[blob:text/plain:${blob.size}]`
    )
  })

  it('hashes DELETE with null body', () => {
    const params: DedupeHashParams = {
      method: 'DELETE',
      url: 'https://example.com',
      body: null,
    }
    expect(dedupeRequestHash(params)).toBe('DELETE|https://example.com|')
  })

  it('dedupeRequestHash handles unserializable body (circular reference)', () => {
    type Circular = { self?: Circular }
    const circular: Circular = {}
    circular.self = circular
    const params = {
      method: 'POST',
      url: 'http://example.com',
      body: circular as DedupeHashParams['body'],
    }
    const hash = dedupeRequestHash(params)
    expect(hash).toContain('[unserializable-body]')
  })
})
