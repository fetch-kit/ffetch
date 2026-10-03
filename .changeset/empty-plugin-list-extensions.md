---
'@fetchkit/ffetch': patch
---

Keep a client created with an empty plugin list usable in TypeScript.

`createClient({ plugins: [] })`, `createClient({ plugins: [] as const })` and an options object typed as `FFetchOptions<[]>` produced an uncallable client: the plugin extensions inferred `never`, which made the whole client `never`, so a call failed with "This expression is not callable" and `pendingRequests`/`abortAll` appeared to be missing. `[]` infers `never[]` and `[] as const` infers `readonly []`, and for an empty plugin union `UnionToIntersection<never>` resolves to `unknown`, whose `Extract<..., object>` is `never`.

- An empty plugin list now contributes an empty extension object instead of erasing the extensions, so the client and the promise its calls return stay usable.
- Plugins installed through a non-empty list are unaffected: their extensions are still intersected into the client and into the call result.
