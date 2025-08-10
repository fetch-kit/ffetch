import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom', // fetch in browser-like env
    coverage: { reporter: ['text', 'lcov'] },
  },
})
