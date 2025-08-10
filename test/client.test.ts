import { describe, it, expect } from 'vitest'
import { createClient } from '../src/client'

describe('createClient', () => {
  it('returns a fetch-like function', () => {
    const client = createClient()
    expect(typeof client).toBe('function')
  })
})
