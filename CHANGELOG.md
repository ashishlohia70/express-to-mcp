# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major version is `0`, breaking changes may land in a minor release.

## [Unreleased]

## [0.1.0] - 2026-09-07

Initial release.

### Added

- `ExpressMcpBridge` — turns a declared list of Express routes into MCP tools, dispatched through the app's middleware stack in memory with no socket bound and no port used.
- In-memory HTTP pipeline (`createExchange`, `dispatch`, `MockRequest`/`MockResponse`/`MockSocket`) built on real `http.IncomingMessage` and `http.ServerResponse`, so `res.json`, `res.send`, `res.cookie`, `res.redirect`, `res.sendFile` and streaming responses all behave as they do under `http.createServer`.
- Argument mapping: path parameters are encoded into the URL, remaining arguments go to the query string on `GET`/`HEAD`/`DELETE`/`OPTIONS` and to a JSON body on `POST`/`PUT`/`PATCH`, overridable per route (`argsIn`) or per argument (`queryParams`, `bodyParams`).
- Zod argument schemas compiled to inline JSON Schema for `tools/list`, supporting both Zod 3 and Zod 4.
- Auth support via static `headers` plus a per-call `buildRequest` hook that can inject headers and properties on `req`.
- Fail-fast construction: malformed route paths, duplicate tool names, non-object argument schemas, and arguments that cannot survive the app's query parser all throw at startup rather than at LLM call time.
- Every runtime failure — schema violation, 4xx/5xx, unmatched route, escaped error, timeout — returned as an MCP `isError` result with an actionable message instead of an exception.
- Bare `express.Router()` instances accepted and mounted on a throwaway app automatically.
- Dual ESM/CJS build with TypeScript declarations.

### Notes

- Requires Express 5. Route paths use `path-to-regexp` v8 syntax; Express 4 patterns such as `/:id?` are rejected at construction with a message naming the replacement.
- JSON request bodies only — `express.urlencoded()` and multipart uploads are not supported.
- No transport is bundled. `bridge.server` exposes the configured MCP `Server` for you to attach `StdioServerTransport`, `StreamableHTTPServerTransport`, or anything else.

[Unreleased]: https://github.com/ashishlohia70/express-to-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ashishlohia70/express-to-mcp/releases/tag/v0.1.0
