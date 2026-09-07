# express-to-mcp

[![npm](https://img.shields.io/npm/v/express-to-mcp.svg)](https://www.npmjs.com/package/express-to-mcp)
[![CI](https://github.com/ashishlohia70/express-to-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ashishlohia70/express-to-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/express-to-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/express-to-mcp.svg)](LICENSE)

Expose an existing Express router as [Model Context Protocol](https://modelcontextprotocol.io) tools — without writing a second server, and without a network hop.

Tool calls are dispatched **through your Express middleware stack in memory**. No port is bound, no HTTP request leaves the process, and your existing auth, validation, and error-handling middleware all run exactly as they do in production.

```
LLM ──JSON-RPC──▶ MCP Server ──▶ mock req/res ──▶ your Express stack ──▶ handler
                                  (in-process, no socket)
```

## Install

```bash
npm install express-to-mcp @modelcontextprotocol/sdk zod
```

Requires **Express 5** and Node 20+. `express`, `zod` and `@modelcontextprotocol/sdk` are peer dependencies, so your app's own copies are used.

## Usage

```ts
import express from 'express';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExpressMcpBridge } from 'express-to-mcp';

const app = express();                    // ← your existing app
app.use(express.json());
app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));

const bridge = new ExpressMcpBridge({
  app,
  serverInfo: { name: 'my-api', version: '1.0.0' },
  headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
  routes: [
    {
      name: 'get_user',
      description: 'Fetch a single user by id.',
      method: 'GET',
      path: '/api/users/:id',
      schema: z.object({ id: z.string().min(1).describe('The user id') }),
      annotations: { readOnlyHint: true },
    },
  ],
});

await bridge.connect(new StdioServerTransport());
```

That's a complete MCP server. See [`examples/stdio.ts`](examples/stdio.ts) for a fuller one.

No transport is bundled — `bridge.server` is the configured MCP `Server`, so attach whichever you need (`StdioServerTransport`, `StreamableHTTPServerTransport`, …).

## How arguments map onto a request

One flat argument object from the LLM becomes a real HTTP request:

| Argument | Goes to | Why |
|---|---|---|
| matches a `:param` in `path` | the URL path | encoded per segment, so a value containing `/` stays in one segment |
| anything else, on `GET`/`HEAD`/`DELETE`/`OPTIONS` | the query string | |
| anything else, on `POST`/`PUT`/`PATCH` | a JSON body | |

Override per route with `argsIn: 'body' | 'query'`, or per argument with `queryParams` / `bodyParams`:

```ts
{
  name: 'search',
  method: 'POST',
  path: '/api/search',
  queryParams: ['page'],            // -> POST /api/search?page=2
  schema: z.object({ term: z.string(), page: z.number().optional() }),
}
```

`req.params` and `req.query` are never assigned directly — they are derived by Express from the URL we build, which is the only way that works reliably (Express recomputes `req.params` on every matched layer, and `req.query` is a get-only accessor).

## Auth and per-call context

`headers` is applied to every request, so existing auth middleware runs unchanged. For per-call identity, use `buildRequest` — it receives the *validated* arguments and runs just before dispatch:

```ts
new ExpressMcpBridge({
  app,
  routes,
  headers: { 'x-service': 'mcp-bridge' },
  buildRequest: (toolName, args) => ({
    headers: { authorization: `Bearer ${tokenFor(args.tenantId)}` },
    extend: { user: { id: 'svc', scopes: ['read'] } },   // assigned onto `req`
  }),
});
```

`extend` sets properties directly on the mocked `req`, which is useful when your handlers expect auth middleware to have already populated something like `req.user`.

## Options

| Option | Default | |
|---|---|---|
| `app` | — | An Express application, or an `express.Router()` (mounted on a throwaway app for you) |
| `routes` | — | The tools to expose |
| `serverInfo` | `express-to-mcp` | Name and version reported over MCP |
| `headers` | `{}` | Headers added to every mocked request |
| `buildRequest` | — | Per-call headers and `req` properties |
| `timeoutMs` | `30000` | Per-call budget; a hung handler becomes an error result |
| `queryStyle` | read from `app.get('query parser')` | `'simple'` or `'extended'` |
| `stripPoweredBy` | `true` | Drop `x-powered-by` from reported headers |

## Route paths use Express 5 syntax

Paths are parsed with `path-to-regexp` v8, so Express 4 patterns are rejected **at construction** with a message telling you the replacement:

| Express 4 | Express 5 |
|---|---|
| `/:file.:ext?` | `/:file{.:ext}` |
| `/*` | `/*splat` |
| `/:id(\d+)` | two routes, or validate in the Zod schema |

`()[]?+!` are reserved; escape them with `\`.

## Error handling

`callTool` never throws — every failure comes back as an MCP `isError` result the LLM can act on:

| Situation | Result |
|---|---|
| arguments fail the Zod schema | `isError`, naming the offending fields; the handler is never invoked |
| handler responds 4xx/5xx | `isError` with the status line and response body |
| no route matched | `isError` 404 noting the path didn't match |
| error escaped all middleware | `isError` with the real message (not a `finalhandler` HTML page) |
| handler never responds | `isError` after `timeoutMs` |

Developer mistakes — a malformed path, a duplicate tool name, a non-object argument schema, an argument that can't survive the app's query parser — throw from the **constructor** instead, so they surface at startup rather than as a confusing tool failure.

## Zod 3 and Zod 4

Both work. Zod 4 schemas are converted with its native `z.toJSONSchema()`; Zod 3 schemas go through `zod-to-json-schema`. Schemas are compiled once at construction, using the *input* JSON Schema so that `.default()` and `.transform()` fields are advertised as optional.

## Limitations

- **JSON bodies only.** `express.urlencoded()` and `multipart` (`multer`) are not supported; only `application/json` is generated.
- **Express 5 only.** Express 4's `app._router` and path syntax are not supported.
- **`compression` is bypassed**, deliberately: no `accept-encoding` request header is sent, so the middleware negotiates `identity` and we capture readable JSON rather than gzipped bytes.
- **Timeouts cannot cancel a running handler** — Node has no such primitive. The dispatch is abandoned and the streams destroyed so `on-finished` cleanup runs, but the handler itself keeps going.

## Lower-level API

The mock pipeline is exported on its own, which is handy for testing an app without a server:

```ts
import { createExchange, dispatch } from 'express-to-mcp';

const exchange = createExchange({ method: 'POST', url: '/api/items?dry=1', body: { name: 'x' } });
const res = await dispatch(app, exchange);

res.status;        // 201
res.headers;       // lowercase keys, set-cookie preserved as an array
res.json();        // parsed body
```

## Contributing

```bash
npm install
npm run verify   # typecheck + tests + build + packaged smoke test
```

The suite includes regression tests that pin the Node and Express internals this library depends on — response prototype replacement, socket-dependent `finish` and body parsing, drain forwarding, byte-length content headers. They exist because every one of those fails *silently* if it regresses; see [CONTRIBUTING.md](CONTRIBUTING.md) before removing one.

Bug reports and PRs welcome. Development needs Node 22.12+ (a vitest 5 requirement); the published library supports Node 20+, which CI verifies by installing the packed tarball.

## License

[MIT](LICENSE) © Ashish Lohia
