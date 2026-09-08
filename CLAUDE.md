# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run verify          # typecheck -> test -> build -> smoke. Run before any commit.
npm run typecheck       # tsc --noEmit over src, tests, examples
npm test                # vitest run
npm run build           # tsup -> dist/ (ESM + CJS + .d.ts)
npm run smoke           # exercises the BUILT package; requires `npm run build` first

npx vitest run -t "verified internals"          # one describe block
npx vitest run -t "forwards socket drain"       # one test by name
npx vitest                                       # watch mode

node scripts/check-example.mjs   # boots examples/stdio.ts, drives it with a real MCP client
```

Both `smoke` and `check-example.mjs` resolve `express-to-mcp` by name via Node's package self-reference, so they need `npm run build` first — on a clean checkout they fail with `ERR_MODULE_NOT_FOUND` until `dist/` exists.

`npm test` alone is not sufficient before committing. The vitest suite runs in-process against `src/`; `npm run smoke` is the only check that exercises `dist/` through the real `exports` map, and `check-example.mjs` is the only one that speaks the protocol over an actual pipe.

Development needs Node ≥22.12 (a vitest 5 constraint). The published library supports Node ≥20 — CI verifies that floor by packing the tarball and installing it into a clean project, because vitest cannot run there.

## What this is

An npm library that exposes an existing Express 5 app as MCP tools. Tool calls are dispatched **through the Express middleware stack in memory** — no socket is bound and no HTTP request leaves the process. The app's own auth, body parsing, validation and error middleware all run unchanged.

```
tools/call ─▶ bridge.ts ─▶ matchers.ts ─▶ mock-http.ts ─▶ app(req, res, done) ─▶ handler
             validate      build URL      fake req/res      real Express stack
             (Zod)         + body         over a Duplex
```

## Architecture

Five modules, each with one job:

- **`bridge.ts`** — `ExpressMcpBridge`. Owns the MCP `Server`, the `tools/list` and `tools/call` handlers, and result formatting. Compiles and validates every route in the constructor.
- **`router.ts`** — route/option types and Zod → JSON Schema compilation.
- **`matchers.ts`** — `PathTemplate` (path-to-regexp v8) and `resolveRequest`, which turn one flat argument bag into a URL plus a body.
- **`mock-http.ts`** — `MockSocket`/`MockResponse`/`createExchange`/`dispatch`. The virtual loop.
- **`errors.ts`** — shared error classes, so the other two layers don't import each other.

Two invariants that shape the whole design:

**Fail fast in the constructor, never at call time.** Malformed paths, duplicate tool names, non-object argument schemas and query args that can't survive the app's query parser all throw from `new ExpressMcpBridge(...)`. Those are developer errors and must surface at startup.

**`callTool` never throws.** Every runtime failure — schema violation, 4xx/5xx, unmatched route, escaped error, timeout — returns an MCP `isError` result with a message the LLM can act on. A throw would reach the client as an opaque JSON-RPC internal error. Keep the catch-all in `callTool` total.

### Three dispatch outcomes

`dispatch()` passes its **own** `done` callback to `app(req, res, done)` rather than letting Express fall back to `finalhandler`, which would return a rendered HTML page and discard the `Error`. That makes three cases distinguishable:

| Signal | Meaning |
|---|---|
| `res` emits `finish` | the app answered — including 4xx/5xx produced by error middleware, which responds normally |
| `done(err)` | the error escaped every layer uncaught; the real stack is intact |
| `done()` with nothing written | the router matched nothing → synthesized 404 |

### Never assign `req.params` or `req.query`

Express derives both from `req.url`. `req.params` is overwritten on every matched layer, and `req.query` is a get-only accessor that throws on assignment. The only thing that works is building a correct URL and letting Express parse it — which is what `matchers.ts` exists to do.

## Invariants that fail silently

`tests/bridge.test.ts` has a `verified internals (regression)` block pinning behaviours of Node and Express that this library leans on. Each one breaks with **no exception and no log** — just a wrong result. Do not delete one because it looks redundant; if you change `mock-http.ts` and one fails, the test is probably right.

- **`app.handle()` runs `Object.setPrototypeOf(res, app.response)`**, splicing `MockResponse.prototype` out of the chain. The `write`/`end` capture wrappers must be assigned as **own properties in the constructor**. As prototype methods they are silently discarded and every tool returns an empty body.
- **A `ServerResponse` with no socket never emits `finish`**, and body-parser 2.x skips entirely when `req.socket` is absent (its first guard is `onFinished.isFinished(req)`). Hence `res.assignSocket()` and a `MockSocket` whose `_read` never pushes EOF — `socket.readable` must stay `true` for the whole exchange.
- **`http.Server` forwards the socket's `drain` to the response** (`socketOnDrain` in `_http_server`). We bypass the server, so `createExchange` does it manually. Without it, any `res.write()` returning `false` — i.e. any body over the ~16KB high-water mark — leaves `stream.pipe(res)` waiting forever. Small responses keep working, so casual testing misses it. This is what made `res.sendFile()` hang.
- **`content-length` must be `Buffer.byteLength`**, not `String#length`, or `raw-body` rejects any non-ASCII body with a 400.
- **`zod-to-json-schema` does not throw on a Zod 4 schema** — it returns a bare `{"$schema": ...}` with zero properties, which would advertise parameterless tools. Zod 4 goes through the native `z.toJSONSchema()`; Zod 3 keeps the old converter. `toJsonSchema()` asserts `type === 'object'` as a backstop.
- **The `'error'` listeners in `dispatch` are deliberately never removed.** A handler calling `res.end()` twice raises `ERR_STREAM_WRITE_AFTER_END` *after* `finish` settled the dispatch, and an unhandled stream `'error'` would kill the process.
- **No `accept-encoding` request header is sent.** `compression` wraps `res.write` after us, so with one present we would capture gzipped bytes.

## Deliberate scope limits

Confirmed decisions, not oversights — check before "fixing" one:

- **Express 5 only.** Route paths use path-to-regexp v8; Express 4 syntax (`/:id?`, bare `/*`, inline regex) is rejected at construction with a message naming the replacement.
- **Explicit route config.** No router-stack auto-discovery.
- **No transport bundled.** `bridge.server` exposes the configured MCP `Server`; the consumer attaches stdio/HTTP themselves.
- **JSON request bodies only.** `express.urlencoded()` and multipart are unsupported. Adding them means a `bodyEncoding` option, not a change to the default.

`express`, `zod` and `@modelcontextprotocol/sdk` are peer dependencies and are `external` in `tsup.config.ts` — never inline them, a second copy of Express breaks `instanceof`.

## Releasing

Publishing is automated by `.github/workflows/release.yml` on a `v*` tag; it refuses to run if the tag disagrees with `package.json` or the version already exists on npm. Bump with `npm version <patch|minor|major>`, add a `CHANGELOG.md` entry, then `git push --follow-tags`. Rehearse via the workflow's `dry-run` input. See CONTRIBUTING.md.
