import * as http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  ExpressMcpBridge,
  MockResponse,
  MockSocket,
  PathTemplate,
  PathSyntaxError,
  UnrepresentableQueryError,
  createExchange,
  dispatch,
  encodeQuery,
  joinPaths,
  resolveRequest,
  type ToolRoute,
} from '../src/index.js';

const TOKEN = 'Bearer test-token';

interface AppHooks {
  /** Byte lengths seen by express.json()'s verify hook. */
  verified: number[];
  handlerCalls: string[];
}

function buildApp(): { app: Express; hooks: AppHooks } {
  const hooks: AppHooks = { verified: [], handlerCalls: [] };
  const app = express();

  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        hooks.verified.push(buf.length);
      },
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== TOKEN) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/users/:id', (req, res) => {
    hooks.handlerCalls.push('getUser');
    res.json({ params: req.params, query: req.query, protocol: req.protocol, ip: req.ip });
  });

  app.post('/items/:itemId/reviews', (req, res) => {
    hooks.handlerCalls.push('createReview');
    res.status(201).json({ params: req.params, body: req.body });
  });

  app.get('/search', (req, res) => {
    hooks.handlerCalls.push('search');
    res.json({ query: req.query });
  });

  app.get('/echo-headers', (req, res) => {
    res.json({ authorization: req.headers.authorization, custom: req.headers['x-tenant'] });
  });

  app.get('/whoami', (req, res) => {
    res.json({ user: (req as Request & { user?: unknown }).user ?? null });
  });

  app.post('/unicode', (req, res) => {
    res.json({ received: req.body });
  });

  app.get('/no-content', (_req, res) => {
    res.status(204).end();
  });

  app.get('/double-end', (_req, res) => {
    res.json({ ok: true });
    // Deliberate misuse: raises ERR_STREAM_WRITE_AFTER_END on res.
    res.end('again');
  });

  app.get('/boom-handled', () => {
    throw new Error('handled failure');
  });

  app.get('/slow', () => {
    /* never responds and never calls next() */
  });

  // Error-handling middleware: turns the thrown error into a normal response.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message, handledBy: 'errorMiddleware' });
  });

  return { app, hooks };
}

const ROUTES: ToolRoute[] = [
  {
    name: 'get_user',
    description: 'Fetch a user by id',
    method: 'GET',
    path: '/users/:id',
    schema: z.object({ id: z.string().min(1), verbose: z.boolean().optional() }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_review',
    description: 'Create a review for an item',
    method: 'POST',
    path: '/items/:itemId/reviews',
    schema: z.object({
      itemId: z.string().min(1),
      rating: z.number().int().min(1).max(5),
      text: z.string().optional(),
    }),
  },
  {
    name: 'search',
    description: 'Search things',
    method: 'GET',
    path: '/search',
    schema: z.object({ q: z.string(), tags: z.array(z.string()).optional() }),
  },
];

function buildBridge(overrides: Partial<ConstructorParameters<typeof ExpressMcpBridge>[0]> = {}) {
  const { app, hooks } = buildApp();
  const bridge = new ExpressMcpBridge({
    app,
    routes: ROUTES,
    headers: { authorization: TOKEN },
    ...overrides,
  });
  return { bridge, app, hooks };
}

/** Parse the single text block out of a tool result. */
function payload(result: { content: Array<{ text: string }> }): unknown {
  const text = result.content[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ========================================================================== */
/* Tool discovery                                                             */
/* ========================================================================== */

describe('tools/list', () => {
  it('emits one inline JSON Schema per route with no dialect or $ref', () => {
    const { bridge } = buildBridge();
    const tools = bridge.listTools();

    expect(tools.map((t) => t.name)).toEqual(['get_user', 'create_review', 'search']);

    const getUser = tools[0]!;
    expect(getUser.description).toBe('Fetch a user by id');
    expect(getUser.annotations).toEqual({ readOnlyHint: true });
    expect(getUser.inputSchema['type']).toBe('object');
    expect(getUser.inputSchema['required']).toEqual(['id']);
    expect(getUser.inputSchema['properties']).toMatchObject({
      id: { type: 'string', minLength: 1 },
      verbose: { type: 'boolean' },
    });

    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain('$schema');
    expect(serialized).not.toContain('$ref');
    expect(serialized).not.toContain('$defs');
  });

  it('gives a route without a schema an empty object schema', () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [
        { name: 'no_args', description: 'no args', method: 'GET', path: '/echo-headers' },
      ],
    });
    expect(bridge.listTools()[0]!.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

/* ========================================================================== */
/* Core dispatch behaviour                                                    */
/* ========================================================================== */

describe('tools/call', () => {
  it('routes an argument into req.params and reaches the handler', async () => {
    const { bridge, hooks } = buildBridge();
    const result = await bridge.callTool('get_user', { id: '42' });

    expect(result.isError).toBeUndefined();
    expect(hooks.handlerCalls).toEqual(['getUser']);
    expect(payload(result)).toMatchObject({ params: { id: '42' }, query: {} });
  });

  it('splits path params from the body on POST', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.callTool('create_review', {
      itemId: 'item-7',
      rating: 5,
      text: 'great',
    });

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({
      params: { itemId: 'item-7' },
      body: { rating: 5, text: 'great' },
    });
  });

  it('encodes remaining args into the query string on GET', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.callTool('search', { q: 'a b', tags: ['x', 'y'] });

    expect(payload(result)).toEqual({ query: { q: 'a b', tags: ['x', 'y'] } });
  });

  it('percent-encodes a path param containing a slash without splitting the segment', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.callTool('get_user', { id: 'a/b' });

    // The router matches the still-encoded pathname, then decodes the capture.
    expect(payload(result)).toMatchObject({ params: { id: 'a/b' } });
  });

  it('reports a 204 with no body as a status line', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [{ name: 'nc', description: 'no content', method: 'GET', path: '/no-content' }],
    });
    const result = await bridge.callTool('nc', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('HTTP 204 No Content');
  });
});

/* ========================================================================== */
/* Auth and per-call context                                                  */
/* ========================================================================== */

describe('auth and context', () => {
  it('passes static headers through so existing auth middleware succeeds', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN, 'x-tenant': 'acme' },
      routes: [{ name: 'hdrs', description: 'headers', method: 'GET', path: '/echo-headers' }],
    });
    expect(payload(await bridge.callTool('hdrs', {}))).toEqual({
      authorization: TOKEN,
      custom: 'acme',
    });
  });

  it('surfaces a 401 as an error result when the token is missing', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({ app, routes: ROUTES });
    const result = await bridge.callTool('get_user', { id: '1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('HTTP 401 Unauthorized');
    expect(result.content[0]!.text).toContain('unauthorized');
  });

  it('lets buildRequest inject per-call headers and req properties', async () => {
    const { app } = buildApp();
    const buildRequest = vi.fn((toolName: string, args: Record<string, unknown>) => ({
      headers: { authorization: TOKEN },
      extend: { user: { id: `u-${String(args['id'] ?? '?')}`, tool: toolName } },
    }));

    const bridge = new ExpressMcpBridge({
      app,
      buildRequest,
      routes: [
        {
          name: 'whoami',
          description: 'current user',
          method: 'GET',
          path: '/whoami',
          schema: z.object({ id: z.string() }),
        },
      ],
    });

    const result = await bridge.callTool('whoami', { id: '9' });
    expect(payload(result)).toEqual({ user: { id: 'u-9', tool: 'whoami' } });
    // The hook sees validated args, not the raw input.
    expect(buildRequest).toHaveBeenCalledWith('whoami', { id: '9' });
  });
});

/* ========================================================================== */
/* Failure paths                                                              */
/* ========================================================================== */

describe('failure handling', () => {
  it('rejects invalid arguments without invoking the handler', async () => {
    const { bridge, hooks } = buildBridge();
    const result = await bridge.callTool('create_review', { itemId: 'i1', rating: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rating');
    expect(hooks.handlerCalls).toEqual([]);
  });

  it('reports an unknown tool name with the available names', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.callTool('nope', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('get_user');
  });

  it('synthesizes a 404 when no route matches', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [
        { name: 'missing', description: 'nope', method: 'GET', path: '/definitely/not/mounted' },
      ],
    });
    const result = await bridge.callTool('missing', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no route matched');
  });

  it('returns the response produced by error-handling middleware', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [{ name: 'boom', description: 'throws', method: 'GET', path: '/boom-handled' }],
    });
    const result = await bridge.callTool('boom', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('HTTP 500');
    expect(result.content[0]!.text).toContain('handledBy');
  });

  it('reports an unhandled error with its message instead of an HTML page', async () => {
    // No error middleware here, so the error escapes to our own `done` callback.
    const app = express();
    app.get('/bare-boom', () => {
      throw new Error('escaped to done');
    });
    const bridge = new ExpressMcpBridge({
      app,
      routes: [{ name: 'bare', description: 'throws', method: 'GET', path: '/bare-boom' }],
    });
    const result = await bridge.callTool('bare', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('escaped to done');
    expect(result.content[0]!.text).not.toContain('<pre>');
  });

  it('times out a handler that never responds', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      timeoutMs: 120,
      routes: [{ name: 'slow', description: 'hangs', method: 'GET', path: '/slow' }],
    });
    const result = await bridge.callTool('slow', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('did not respond within 120ms');
  });

  it('rejects a malformed route path at construction, naming the v8 syntax', () => {
    const { app } = buildApp();
    expect(
      () =>
        new ExpressMcpBridge({
          app,
          // Express 4 optional-param syntax; path-to-regexp v8 rejects it.
          routes: [{ name: 'legacy', description: 'x', method: 'GET', path: '/users/:id?' }],
        }),
    ).toThrow(PathSyntaxError);
  });

  it('rejects duplicate tool names at construction', () => {
    const { app } = buildApp();
    expect(
      () =>
        new ExpressMcpBridge({
          app,
          routes: [
            { name: 'dup', description: 'a', method: 'GET', path: '/search' },
            { name: 'dup', description: 'b', method: 'GET', path: '/users/:id' },
          ],
        }),
    ).toThrow(/Duplicate MCP tool name/);
  });

  it('rejects a non-object argument schema at construction', () => {
    const { app } = buildApp();
    expect(
      () =>
        new ExpressMcpBridge({
          app,
          routes: [
            {
              name: 'bad',
              description: 'x',
              method: 'GET',
              path: '/search',
              schema: z.string() as never,
            },
          ],
        }),
    ).toThrow(/expected an object schema/);
  });
});

/* ========================================================================== */
/* Regression tests pinning verified Node/Express internals                   */
/* ========================================================================== */

describe('verified internals (regression)', () => {
  it('F1/F2: ServerResponse emits finish only once a socket is assigned', async () => {
    const socketless = new MockSocket();
    const reqA = new http.IncomingMessage(socketless as never);
    const resA = new MockResponse(reqA);
    let finishedWithoutSocket = false;
    resA.on('finish', () => {
      finishedWithoutSocket = true;
    });
    resA.statusCode = 200;
    resA.end('hi');
    await new Promise((r) => setTimeout(r, 20));
    // end() returns normally and buffers, but finish never fires. This is why
    // assignSocket is mandatory rather than cosmetic.
    expect(finishedWithoutSocket).toBe(false);

    const socket = new MockSocket();
    const reqB = new http.IncomingMessage(socket as never);
    const resB = new MockResponse(reqB);
    const finished = new Promise<void>((resolve) => resB.on('finish', () => resolve()));
    resB.assignSocket(socket as never);
    resB.statusCode = 200;
    resB.end('hi');
    await expect(finished).resolves.toBeUndefined();
  });

  it('F3: capture survives app.handle() replacing the response prototype', async () => {
    const app = express();
    let prototypeSwapped = false;
    app.get('/proto', (_req, res) => {
      // Express has re-pointed the prototype away from MockResponse.prototype.
      prototypeSwapped = Object.getPrototypeOf(res) !== MockResponse.prototype;
      res.json({ captured: true });
    });

    const exchange = createExchange({ method: 'GET', url: '/proto' });
    const captured = await dispatch(app as never, exchange);

    expect(prototypeSwapped).toBe(true);
    // Own-property wrappers still ran, so the body is not empty.
    expect(captured.json()).toEqual({ captured: true });
  });

  it('F4/F10: express.json() genuinely parses the pushed body', async () => {
    const { bridge, hooks } = buildBridge();
    await bridge.callTool('create_review', { itemId: 'i', rating: 3 });

    // The verify hook only runs if body-parser actually read the stream, which
    // requires both a readable socket and content-type/content-length.
    expect(hooks.verified.length).toBe(1);
    expect(hooks.verified[0]).toBe(Buffer.byteLength(JSON.stringify({ rating: 3 })));
  });

  it('falls back to the pre-set req.body when no parser is mounted', async () => {
    const app = express(); // no express.json()
    app.post('/raw', (req, res) => {
      res.json({ body: req.body ?? null });
    });
    const bridge = new ExpressMcpBridge({
      app,
      routes: [
        {
          name: 'raw',
          description: 'x',
          method: 'POST',
          path: '/raw',
          schema: z.object({ a: z.number() }),
        },
      ],
    });
    expect(payload(await bridge.callTool('raw', { a: 1 }))).toEqual({ body: { a: 1 } });
  });

  it('F9: a non-ASCII body round-trips (byte length, not string length)', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [
        {
          name: 'uni',
          description: 'x',
          method: 'POST',
          path: '/unicode',
          schema: z.object({ name: z.string() }),
        },
      ],
    });
    const result = await bridge.callTool('uni', { name: 'héllo wörld 日本' });

    // With String#length, raw-body would 400 with a content-length mismatch.
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({ received: { name: 'héllo wörld 日本' } });
  });

  it('F8: a handler calling res.end() twice does not crash the process', async () => {
    const { app } = buildApp();
    const bridge = new ExpressMcpBridge({
      app,
      headers: { authorization: TOKEN },
      routes: [{ name: 'de', description: 'x', method: 'GET', path: '/double-end' }],
    });
    const result = await bridge.callTool('de', {});
    expect(payload(result)).toEqual({ ok: true });
    // Give the stray ERR_STREAM_WRITE_AFTER_END time to surface.
    await new Promise((r) => setTimeout(r, 20));
  });

  it('F7: rejects a nested-object query arg under the default simple parser', () => {
    const { app } = buildApp();
    expect(
      () =>
        new ExpressMcpBridge({
          app,
          routes: [
            {
              name: 'nested',
              description: 'x',
              method: 'GET',
              path: '/search',
              schema: z.object({ filter: z.object({ type: z.string() }) }),
            },
          ],
        }),
    ).toThrow(UnrepresentableQueryError);
  });

  it('F7: accepts the same schema once the app opts into the extended parser', async () => {
    const app = express();
    app.set('query parser', 'extended');
    app.get('/nested', (req, res) => res.json({ query: req.query }));

    const bridge = new ExpressMcpBridge({
      app,
      routes: [
        {
          name: 'nested',
          description: 'x',
          method: 'GET',
          path: '/nested',
          schema: z.object({ filter: z.object({ type: z.string() }) }),
        },
      ],
    });
    expect(payload(await bridge.callTool('nested', { filter: { type: 'book' } }))).toEqual({
      query: { filter: { type: 'book' } },
    });
  });

  it('F6/F5: params and query are derived by Express, never assigned by us', async () => {
    const { bridge } = buildBridge();
    // A successful call proves req.query's getter was not clobbered (which
    // would have thrown) and that req.params came from the matched route.
    const result = await bridge.callTool('get_user', { id: 'abc', verbose: true });
    expect(payload(result)).toMatchObject({
      params: { id: 'abc' },
      // `verbose` is not a path param, so it lands in the query string.
      query: { verbose: 'true' },
      protocol: 'http',
    });
  });

  it('forwards socket drain to the response so backpressure resolves', async () => {
    // A body larger than the socket high-water mark makes res.write() return
    // false. Without socket-'drain' -> res-'drain' forwarding, a piping producer
    // stalls permanently here.
    const chunk = 'x'.repeat(1024);
    const total = 64;
    const app = express();
    app.get('/big', (_req, res) => {
      res.type('text/plain');
      Readable.from(Array.from({ length: total }, () => chunk)).pipe(res);
    });

    const exchange = createExchange({ method: 'GET', url: '/big' });
    const captured = await dispatch(app as never, exchange, { timeoutMs: 3000 });

    expect(captured.body.length).toBe(chunk.length * total);
  });

  it('supports res.sendFile, which pipes a real stream into the mock socket', async () => {
    const app = express();
    // Deliberately this file: at ~26KB it exceeds the socket high-water mark, so
    // it exercises the backpressure path that a small file would not.
    const thisFile = fileURLToPath(import.meta.url);
    app.get('/file', (_req, res) => {
      res.sendFile(thisFile);
    });

    const exchange = createExchange({ method: 'GET', url: '/file' });
    const captured = await dispatch(app as never, exchange);

    expect(captured.status).toBe(200);
    // Byte-for-byte identical to the file on disk: backpressure, on-finished and
    // fd cleanup all worked against the fake socket.
    const onDisk = await readFile(thisFile);
    expect(captured.body.length).toBe(onDisk.length);
    expect(captured.body.equals(onDisk)).toBe(true);
  });

  it('captures a chunked streaming response written in several parts', async () => {
    const app = express();
    app.get('/stream', (_req, res) => {
      res.type('text/plain');
      res.write('one|');
      res.write('two|');
      setTimeout(() => res.end('three'), 10);
    });

    const exchange = createExchange({ method: 'GET', url: '/stream' });
    const captured = await dispatch(app as never, exchange);

    // No status line or chunk-size framing leaks in: capture is pre-framing.
    expect(captured.text()).toBe('one|two|three');
  });

  it('keeps concurrent calls isolated', async () => {
    const { bridge } = buildBridge();
    const results = await Promise.all(
      ['1', '2', '3', '4', '5'].map((id) => bridge.callTool('get_user', { id })),
    );
    expect(results.map((r) => (payload(r) as { params: { id: string } }).params.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
});

/* ========================================================================== */
/* Matcher units                                                              */
/* ========================================================================== */

describe('matchers', () => {
  it('extracts params, wildcards and optional groups', () => {
    expect(PathTemplate.parse('/api/org/:orgId/users/:userId').paramNames).toEqual([
      'orgId',
      'userId',
    ]);
    expect(PathTemplate.parse('/files/*splat').wildcardNames).toEqual(['splat']);
    const optional = PathTemplate.parse('/users{/:id}');
    expect([...optional.optionalNames]).toEqual(['id']);
    expect(optional.expand({}).pathname).toBe('/users');
    expect(optional.expand({ id: '7' }).pathname).toBe('/users/7');
  });

  it('splits a slash-bearing wildcard into segments', () => {
    const tpl = PathTemplate.parse('/files/*path');
    expect(tpl.expand({ path: 'a/b/c.txt' }).pathname).toBe('/files/a/b/c.txt');
    expect(tpl.expand({ path: ['x', 'y'] }).pathname).toBe('/files/x/y');
  });

  it('treats an empty path param as missing', () => {
    expect(() => PathTemplate.parse('/users/:id').expand({ id: '' })).toThrow(
      /Missing required path parameter/,
    );
  });

  it('encodes arrays as repeated keys and rejects nesting under simple', () => {
    expect(encodeQuery({ t: ['1', '2'], q: 'a b' }, 'simple')).toBe('?t=1&t=2&q=a+b');
    expect(encodeQuery({ f: { a: '1' } }, 'extended')).toBe('?f%5Ba%5D=1');
    expect(encodeQuery({}, 'simple')).toBe('');
    expect(() => encodeQuery({ f: { a: '1' } }, 'simple')).toThrow(UnrepresentableQueryError);
  });

  it('omits null and undefined rather than stringifying them', () => {
    expect(encodeQuery({ a: undefined, b: null, c: 1 }, 'simple')).toBe('?c=1');
  });

  it('joins base paths without doubling slashes', () => {
    expect(joinPaths('/v1/', '/users')).toBe('/v1/users');
    expect(joinPaths('v1', 'users')).toBe('/v1/users');
    expect(joinPaths(undefined, '/users')).toBe('/users');
    expect(joinPaths('/v1', '/')).toBe('/v1');
  });

  it('honours per-argument body/query overrides', () => {
    const resolved = resolveRequest(
      { method: 'POST', path: '/search', queryParams: ['page'] },
      { page: 2, term: 'x' },
    );
    expect(resolved.url).toBe('/search?page=2');
    expect(resolved.body).toEqual({ term: 'x' });
  });
});

/* ========================================================================== */
/* End-to-end over a real MCP client                                          */
/* ========================================================================== */

describe('MCP protocol end-to-end', () => {
  it('serves tools/list and tools/call to a real MCP client', async () => {
    const { bridge } = buildBridge();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      bridge.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['get_user', 'create_review', 'search']);

    const called = await client.callTool({ name: 'get_user', arguments: { id: '77' } });
    const block = (called.content as Array<{ type: string; text: string }>)[0]!;
    expect(block.type).toBe('text');
    expect(JSON.parse(block.text)).toMatchObject({ params: { id: '77' } });

    const bad = await client.callTool({ name: 'get_user', arguments: {} });
    expect(bad.isError).toBe(true);

    await client.close();
  });

  it('accepts a bare Router by mounting it on a throwaway app', async () => {
    const router = express.Router();
    router.get('/ping/:name', (req, res) => {
      res.json({ pong: req.params['name'], query: req.query });
    });

    const bridge = new ExpressMcpBridge({
      app: router as never,
      routes: [
        {
          name: 'ping',
          description: 'ping',
          method: 'GET',
          path: '/ping/:name',
          schema: z.object({ name: z.string(), n: z.number().optional() }),
        },
      ],
    });

    expect(payload(await bridge.callTool('ping', { name: 'bob', n: 3 }))).toEqual({
      pong: 'bob',
      query: { n: '3' },
    });
  });
});
