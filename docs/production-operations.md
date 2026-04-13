# Production Operations Guide

This guide is the canonical runbook for operating `@fetchkit/ffetch` in production.

## 1. Pre-Deployment Checklist

### Core configuration

- [ ] Set `timeout` per dependency SLA (avoid using one global value for everything).
- [ ] Set `retries` conservatively (`1-3` in most systems).
- [ ] Decide `throwOnHttpError` policy (`true` for strict exception flow, `false` for response-driven handling).
- [ ] Use a runtime-appropriate `fetchHandler` for SSR/edge/custom environments.

### Resilience plugins

- [ ] Enable `circuitPlugin` for external dependencies.
- [ ] Enable `bulkheadPlugin` for dependencies that can saturate under load.
- [ ] Enable `dedupePlugin` on bursty read-heavy endpoints.
- [ ] Enable `hedgePlugin` only for safe methods and latency-sensitive paths.
- [ ] Validate plugin order assumptions when composing multiple plugins.

### Observability and hooks

- [ ] Instrument `before`/`after`/`onError` hooks for logs and metrics.
- [ ] Track request latency (`p50/p95/p99`) and error-rate by endpoint.
- [ ] Track resilience signals: circuit opens, bulkhead queue depth, retry counts.
- [ ] Add request correlation IDs in `transformRequest`.

## 2. Operational Metrics

Minimum metrics to collect:

- Request count by endpoint/method/status
- Latency histogram (`p50`, `p95`, `p99`)
- Error count by error class (`TimeoutError`, `CircuitOpenError`, `NetworkError`, `RetryLimitError`, etc.)
- Circuit breaker open events and duration
- Bulkhead `activeCount`, `queueDepth`, rejection count
- Retry attempts and eventual success-after-retry rate

## 3. Alerting Baseline

- Alert on sustained high error rate for a dependency.
- Alert when circuit remains open beyond expected recovery windows.
- Alert when bulkhead queue remains near capacity.
- Alert when `p99` latency regresses significantly from baseline.

## 4. Incident Playbook

### Circuit open incidents

1. Check downstream dependency health first.
2. Confirm `threshold`/`reset` values are aligned with failure patterns.
3. Use fallback/degraded responses at app level while circuit is open.
4. Avoid releasing queued traffic all at once during recovery.

### High latency incidents

1. Check bulkhead saturation (`activeCount`, `queueDepth`).
2. Check retry inflation (too many retries amplifying load).
3. If using hedging, verify `delay` and `maxHedges` are tuned for current latency distribution.

### Rate-limit incidents (429)

1. Ensure retry strategy honors `Retry-After` behavior.
2. Reduce concurrency (`bulkhead`) and hedge aggressiveness.
3. Add app-level backpressure or queueing upstream.

## 5. Recommended Baseline Configs

### Internal service-to-service client

```typescript
createClient({
  timeout: 10_000,
  retries: 2,
  plugins: [
    circuitPlugin({ threshold: 5, reset: 30_000 }),
    bulkheadPlugin({ maxConcurrent: 20, maxQueue: 100 }),
    dedupePlugin({ ttl: 30_000 }),
  ],
})
```

### Latency-sensitive read path

```typescript
createClient({
  timeout: 5_000,
  retries: 1,
  plugins: [
    dedupePlugin({ ttl: 10_000 }),
    hedgePlugin({ delay: 75, maxHedges: 1 }),
  ],
})
```

## 6. Related References

- [api.md](./api.md) for full option and plugin reference
- [plugins.md](./plugins.md) for plugin lifecycle and ordering semantics
- [advanced.md](./advanced.md) for retry, circuit, and operational patterns
- [errorhandling.md](./errorhandling.md) for exact error behavior
