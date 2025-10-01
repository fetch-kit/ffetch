# Error Handling in ffetch

The native `fetch` API does not throw errors for HTTP error status codes (4xx, 5xx). Instead, it returns a `Response` object with the corresponding status code, and it is up to the developer to check `response.ok` or `response.status` to handle such cases. This is `ffetch`'s default behavior as well, but it can be configured to throw errors for HTTP error responses using the `throwOnHttpError` flag.

This document explains exactly how, when, and what errors are thrown by the ffetch client, especially in relation to the `throwOnHttpError` flag.

## Summary Table

| Scenario                           | throwOnHttpError: true | throwOnHttpError: false | What gets thrown/returned           |
| ---------------------------------- | :--------------------: | :---------------------: | ----------------------------------- |
| HTTP 2xx (success)                 |           —            |            —            | Returns Response                    |
| HTTP 4xx after retries             |         throws         |         returns         | Throws HttpError / Returns Response |
| HTTP 5xx after retries             |         throws         |         returns         | Throws HttpError / Returns Response |
| Network error after retries        |         throws         |         throws          | Throws NetworkError                 |
| Circuit breaker open               |         throws         |         throws          | Throws CircuitOpenError             |
| Timeout (request times out)        |         throws         |         throws          | Throws TimeoutError                 |
| Aborted by user                    |         throws         |         throws          | Throws AbortError                   |
| Retry limit reached (other errors) |         throws         |         throws          | Throws RetryLimitError              |

## Detailed Behavior

### 1. HTTP Errors (all 4xx and 5xx)

- If `throwOnHttpError` is **true** (globally or per-request):
  - After all retries are exhausted, if the final response is any 4xx or 5xx status (e.g. 400, 401, 404, 429, 500, 503, etc.), the client **throws an `HttpError`** containing the final `Response`.
- If `throwOnHttpError` is **false** (default):
  - The client **returns the final `Response`** object, regardless of status.
- This applies to both global and per-request settings. Per-request overrides global.

### 2. Network Errors

- If a network error (e.g., lost connection, DNS failure) occurs and all retries are exhausted, the client **throws a `NetworkError`**.
- This happens regardless of the `throwOnHttpError` flag.

### 3. Circuit Breaker

- If the circuit breaker is open, the client **throws a `CircuitOpenError`** before making the request.
- This happens regardless of the `throwOnHttpError` flag.

### 4. Timeout

- If the request times out (exceeds the `timeout` value), the client **throws a `TimeoutError`**.
- This happens regardless of the `throwOnHttpError` flag.

### 5. Abort

- If the request is aborted by the user (via `AbortController`), the client **throws an `AbortError`**.
- This happens regardless of the `throwOnHttpError` flag.

### 6. Retry Limit

- If all retries are exhausted and the error is not one of the above, the client **throws a `RetryLimitError`**.
- This happens regardless of the `throwOnHttpError` flag.

## Examples

```typescript
const client = createClient({ throwOnHttpError: true, retries: 1 })

// Throws HttpError for 404 after retries
await client('https://example.com/404') // throws HttpError

// Returns Response for 404 if flag is false
const client2 = createClient({ throwOnHttpError: false })
const res = await client2('https://example.com/404') // res.status === 404

// Throws TimeoutError
const client3 = createClient({ timeout: 10 })
await client3('https://example.com/slow') // throws TimeoutError

// Throws AbortError
const controller = new AbortController()
controller.abort()
await client('https://example.com', { signal: controller.signal }) // throws AbortError
```

## Notes

- The `throwOnHttpError` flag can be set globally (on the client) or per-request (in the `init` object). Per-request always takes precedence.
- Only the final response after all retries is considered for throwing `HttpError`.
- All other error types (timeout, abort, network, circuit, retry limit) are always thrown as errors, regardless of the flag.
