---
'@fetchkit/ffetch': patch
---

Replay the request body on every retry attempt. Sending a request consumes its body, so a retried request that carried a body was silently skipped and the previous response was returned instead.

Only a body ffetch owns is replayed: a `string`, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed array or `FormData` passed in `init`. Other bodies keep the previous behaviour instead of being buffered before the first attempt:

- a `ReadableStream` body or a `Request` input can be an upload that only ends when the server acknowledges it, so buffering one would stall the request;
- a request replaced by a `transformRequest` hook is copied only when the retry starts, which still throws if the hook's body was already sent.
