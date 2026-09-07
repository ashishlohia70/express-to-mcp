# Contributing

Thanks for taking a look. Bug reports and PRs are both welcome.

## Getting set up

```bash
git clone https://github.com/ashishlohia70/express-to-mcp.git
cd express-to-mcp
npm install
npm run verify     # typecheck + tests + build + packaged smoke test
```

Node **22.12 or newer** is needed to develop (vitest 5 requires it). The published library itself supports Node 20+, which CI verifies separately by installing the packed tarball.

## The checks

| Command | What it covers |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests` and `examples` |
| `npm test` | the vitest suite, in-process |
| `npm run build` | dual ESM/CJS bundle plus `.d.ts`, via tsup |
| `npm run smoke` | the built package through its public entrypoints (needs `build` first) |
| `node scripts/check-example.mjs` | `examples/stdio.ts` driven by a real MCP client over a real pipe |
| `npm run verify` | all of the above, in order |

## About the regression tests

`tests/bridge.test.ts` has a block called `verified internals (regression)`. Those tests pin behaviours of Node and Express that this library depends on and that **fail silently** when they break — no exception, no error log, just a wrong result:

- `app.handle()` replaces the response prototype, so the capture wrappers have to be own properties. Get this wrong and every tool returns an empty body.
- A `ServerResponse` with no socket never emits `finish`, and body-parser skips entirely. Get this wrong and every call times out, or `req.body` is silently never parsed.
- `http.Server` forwards the socket's `drain` to the response. Get this wrong and any response over ~16KB hangs forever — while small ones keep working, so casual testing misses it.
- `content-length` must be the byte length, not the string length. Get this wrong and any non-ASCII body 400s.
- `zod-to-json-schema` returns an empty schema for a Zod 4 input rather than throwing. Get this wrong and the LLM is shown parameterless tools.

Please don't delete one because it looks redundant. If you change the mock pipeline and one of them fails, the test is probably right.

## Pull requests

- Add or update a test for any behaviour change.
- Run `npm run verify` before pushing.
- Keep the public API additive where you can; this package follows semver and is pre-1.0, so breaking changes need a minor bump and a `CHANGELOG.md` entry.
- Note anything you could not verify. "I couldn't test this on Windows" is useful; silence is not.

## Releasing

Publishing is automated. One-time setup: add an npm **automation** access token as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).

```bash
# 1. bump the version and write the changelog entry
npm version minor          # or patch / major — this creates the v* tag

# 2. push the commit and the tag
git push --follow-tags
```

The `Release` workflow then refuses to continue unless the tag matches `package.json` and the version is not already on npm, runs the full `verify` gate, and publishes with `--provenance` so npm can attest the tarball was built from this commit.

To rehearse without publishing, run the workflow manually from the Actions tab with **dry-run** left checked. It performs every check and uploads the tarball as an artifact.

Publishing by hand is possible (`npm publish --access public`) but skips the tag/version guards and produces no provenance attestation, so prefer the workflow.
