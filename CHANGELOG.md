# ffetch

## 0.1.1

### Patch Changes

- ✅ Scaffolded TypeScript project

      package.json renamed to ffetch
      src/index.ts, src/client.ts, src/types.ts created
      tsconfig.json + tsup.config.ts for dual ESM/CJS build

  ✅ Tooling wired

      npm run build, test, lint, format scripts
      Vitest + coverage + happy-dom env
      Prettier + ESLint + Husky pre-commit hook
      .gitignore added

  ✅ First test passes

      test/client.test.ts asserts typeof createClient() === 'function'

  ✅ Published v0.1.0 to npm registry

      npm login done
      Manual npm version patch → v0.1.1 (changesets unused for initial setup)
