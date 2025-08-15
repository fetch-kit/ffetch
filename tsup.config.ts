import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
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
