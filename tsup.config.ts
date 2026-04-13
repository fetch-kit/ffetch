import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/plugins/dedupe.ts',
      'src/plugins/circuit.ts',
      'src/plugins/hedge.ts',
      'src/plugins/response-shortcuts.ts',
      'src/plugins/request-shortcuts.ts',
      'src/plugins/download-progress.ts',
    ],
    format: ['esm', 'cjs'],
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
