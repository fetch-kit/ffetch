---
'@fetchkit/ffetch': patch
---

Run the retry sequence from one internal executor instead of three places.

The loop, the attempt counter, the retry decision, the `onRetry` hook, the release of a discarded response body and the wait between attempts were split across `retry()`, the pipeline's `shouldRetryWithHook` wrapper and `runAttempt`, which each wrote part of `ctx.metadata.retry` and kept part of the state: the pipeline counted attempts a second time, guarded `onRetry` with a condition the loop had already applied, and only the pipeline's copy of the metadata write described the attempt a policy had just seen.

`runRetrySequence` in `src/internals/retry-execution.ts` now owns the sequence, and the pipeline hands it the attempts to run, the policy, the hook and the metadata to keep up to date. Nothing observable changes: attempts are still numbered from 1, the policy is still consulted only for the attempts a retry budget can follow, `onRetry` still receives a zero-based retry number and still runs after the decision, before a discarded response body is cancelled and before the delay is waited out, a wait is still cut short by a cancellation, and an error raised by the policy, the hook or the attempt still reaches the caller with the same identity and provenance.

`src/retry.ts` keeps the delay contract (`RetryDelay`, `defaultDelay`) and no longer exports the loop, which was internal to the pipeline either way: `retry()` was never part of the public API in `src/index.ts`.
