import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/plugins/dedupe.ts',
      'src/plugins/bulkhead.ts',
      'src/plugins/circuit.ts',
      'src/plugins/hedge.ts',
      'src/plugins/response-shortcuts.ts',
      'src/plugins/request-shortcuts.ts',
      'src/plugins/download-progress.ts',
      'src/plugins/context-id.ts',
    ],
    format: ['esm', 'cjs'],
    // Keep one copy of shared modules (e.g. src/error.ts) across every
    // entrypoint so error classes keep a single identity and `instanceof`
    // holds between the root export and the plugin subpaths. esbuild code
    // splitting is ESM-only, so without this CJS inlines a duplicate.
    splitting: true,
    dts: true,
    minify: false,
    sourcemap: true,
    outDir: 'dist',
    clean: true,
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    minify: true,
    sourcemap: true,
    outDir: 'dist',
    dts: false,
    clean: false,
    outExtension: () => ({ js: '.min.js' }),
  },
])
