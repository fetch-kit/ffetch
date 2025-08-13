import { describe, it, expect } from 'vitest'
import { withTimeout } from '../src/timeout.js'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('withTimeout', () => {
  it('aborts after the specified timeout', async () => {
    const signal = withTimeout(20)
    expect(signal.aborted).toBe(false)
    await delay(25)
    expect(signal.aborted).toBe(true)
  })

  it('aborts if parent signal is aborted', async () => {
    const parent = new AbortController()
    const signal = withTimeout(50, parent.signal)
    expect(signal.aborted).toBe(false)
    parent.abort()
    expect(signal.aborted).toBe(true)
  })

  it('does not abort before timeout if parent is not aborted', async () => {
    const signal = withTimeout(30)
    expect(signal.aborted).toBe(false)
    await delay(10)
    expect(signal.aborted).toBe(false)
  })

  it('clears timer if parent aborts before timeout', async () => {
    const parent = new AbortController()
    const signal = withTimeout(50, parent.signal)
    parent.abort()
    await delay(60)
    expect(signal.aborted).toBe(true)
  })
})
