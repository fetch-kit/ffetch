---
'@fetchkit/ffetch': patch
---

Run the retry sequence from one internal executor instead of three places.

The loop, the attempt counter, the retry decision, the `onRetry` hook, the release of a discarded response body and the wait between attempts were split across `retry()`, the pipeline's `shouldRetryWithHook` wrapper and `runAttempt`, which each wrote part of `ctx.metadata.retry` and kept part of the state: the pipeline counted attempts a second time, guarded `onRetry` with a condition the loop had already applied, and only the pipeline's copy of the metadata write described the attempt a policy had just seen.

`runRetrySequence` in `src/internals/retry-execution.ts` now owns the sequence, and the pipeline hands it the attempts to run, the policy, the hook and the metadata to keep up to date. The sequence keeps its shape: attempts are still numbered from 1, the policy is still consulted only for the attempts a retry budget can follow, `onRetry` still receives a zero-based retry number and still runs after the decision, before a discarded response body is cancelled and before the delay is waited out, a wait is still cut short by a cancellation, and an error raised by the policy, the hook or the attempt still reaches the caller with the same identity and provenance.

Consolidating it also fixed two things the sequence reported that did not match what it documents. Both are visible to `shouldRetry`, `onRetry` and `ctx.metadata.retry`, and both are covered by tests now:

- An attempt that fails is reported with its own error and no response. The context it was reported in also carried the response an earlier attempt left behind, so a policy that reads `response` could decide on a response that was no longer the answer, `onRetry` was told about it, and its body - already released when the retry discarded it - could be released again.
- Every attempt is recorded in `ctx.metadata.retry`, the last one a request's budget allows included. That attempt used to leave the metadata on the attempt before it (or on `0` with `retries: 0`) while `onSuccess`, `onError` and `onFinally` ran, and `shouldRetryResult` kept the previous attempt's answer: it is now unset for an attempt that was never offered for a retry.

`src/retry.ts` keeps the delay contract (`RetryDelay`, `defaultDelay`) and no longer exports the loop, which was internal to the pipeline either way: `retry()` was never part of the public API in `src/index.ts`.
