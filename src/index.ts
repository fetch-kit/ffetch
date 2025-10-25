export type { FFetch, FFetchOptions } from './types'
export type { DedupeHashParams } from './dedupeRequestHash'
export type { Hooks } from './hooks'

import { createClient } from './client'
export { createClient } from './client'

export {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from './error'

export default createClient
