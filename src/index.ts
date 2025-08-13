export type { FFetch, FFetchOptions } from './types'
export type { Hooks } from './hooks'

import { createClient } from './client'
export { createClient } from './client'

export {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
  ResponseError,
} from './error'

export default createClient
