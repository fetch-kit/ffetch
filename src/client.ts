export function createClient() {
  // simplest possible fetch wrapper
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    return fetch(input, init)
  }
}
