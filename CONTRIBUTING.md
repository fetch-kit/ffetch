# Contributing to ffetch

Contributions are welcome. Use [GitHub Issues](https://github.com/fetch-kit/ffetch/issues) to report bugs or propose enhancements. Security vulnerabilities should be reported privately as described in [SECURITY.md](./SECURITY.md).

## Development

Development uses Node.js 24, matching the CI environment. Fork the repository, create a branch from `main`, and install the dependencies:

```sh
npm ci
```

Before submitting a pull request, run the same checks used by CI:

```sh
npm run lint
npm run test:ci
npm run build
```

You can use `npm test` while developing to run the tests in watch mode.

## Pull requests

- Keep changes focused and explain their purpose in the pull request.
- Add automated tests for new functionality and bug fixes.
- Update the documentation when behavior or the public API changes.
- Make sure linting, tests, and the build pass before submitting the pull request.

Submit pull requests against the `main` branch. Maintainers handle versioning and releases.
