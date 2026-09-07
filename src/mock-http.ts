/**
 * The "virtual loop": a mock request/response pair that Express cannot tell
 * apart from one produced by `http.createServer`, and the dispatcher that runs
 * it through the middleware stack.
 *
 * The design is constrained by four behaviours of Node and Express that are
 * verified by the regression tests in `tests/bridge.test.ts`. Each is called out
 * inline where it forces a decision, because every one of them fails *silently*
 * if you get it wrong.
 */

import * as http from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { DispatchTimeoutError, UnmatchedRouteError, normalizeHandlerError } from './errors.js';

/**
 * Anything that can serve a request: an Express application, an
 * `express.Router()`, or a bare middleware function. All three share this shape.
 */
export type ExpressLike = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void,
) => void;

/** The captured result of running one request through the stack. */
export interface CapturedResponse {
  status: number;
  statusMessage: string;
  /** Lowercase-keyed, with `set-cookie` preserved as an array. */
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
  /** `false` when the router ran out of layers and we synthesized a 404. */
  matched: boolean;
  text(): string;
  json(): unknown;
}

export interface DispatchOptions {
  /** Wall-clock budget for the handler. Defaults to 30s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When the router matches nothing, return a synthetic 404 `CapturedResponse`
   * (default) instead of rejecting with {@link UnmatchedRouteError}.
   */
  synthesize404?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Socket                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A `Duplex` standing in for a TCP socket.
 *
 * It is not a convenience — it is mandatory, for three separate reasons:
 *
 *  1. A `ServerResponse` with no socket never emits `'finish'`. `end()` returns
 *     normally and silently buffers the serialized message into
 *     `res.outputData`, so every dispatch would hang until the timeout.
 *  2. body-parser 2.x's first guard is `onFinished.isFinished(req)`, which is
 *     `Boolean(!socket || !socket.readable || ...)`. With no socket it returns
 *     `true`, making `express.json()` a silent no-op that never even initializes
 *     `req.body`.
 *  3. `req.protocol`, `req.secure` and `req.ip` read `socket.encrypted` and
 *     `socket.remoteAddress`, and would throw on `undefined`.
 */
export class MockSocket extends Duplex {
  readonly remoteAddress: string;
  readonly remotePort = 0;
  readonly localAddress = '127.0.0.1';
  readonly localPort = 80;
  /** Drives `req.protocol` / `req.secure`. */
  readonly encrypted: boolean;
  bytesWritten = 0;

  constructor(opts: { remoteAddress?: string; encrypted?: boolean } = {}) {
    // autoDestroy would tear the socket down mid-request and flip
    // `socket.readable` to false, re-triggering reason (2) above intermittently.
    super({ autoDestroy: false });
    this.remoteAddress = opts.remoteAddress ?? '127.0.0.1';
    this.encrypted = opts.encrypted ?? false;
  }

  // Deliberately never pushes EOF: `socket.readable` must stay true for the
  // whole exchange or body-parser starts skipping.
  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    // The fully framed HTTP message lands here (status line, headers, chunk
    // sizes) and is discarded. We capture the payload upstream instead, which is
    // what lets us skip writing an HTTP response parser.
    this.bytesWritten += chunk.length;
    cb();
  }

  override _writev(
    chunks: Array<{ chunk: Buffer }>,
    cb: (err?: Error | null) => void,
  ): void {
    for (const { chunk } of chunks) this.bytesWritten += chunk.length;
    cb();
  }

  // `OutgoingMessage._writeRaw` pokes at these. `cork`/`uncork` come from Duplex.
  // NOTE: never declare `writableCorked` here — it is a getter-only property on
  // Duplex and assigning it throws a TypeError at construction.
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  destroySoon(): void {
    this.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Response                                                                   */
/* -------------------------------------------------------------------------- */

const SR_WRITE = http.ServerResponse.prototype.write;
const SR_END = http.ServerResponse.prototype.end;

function captureChunk(chunks: Buffer[], chunk: unknown, enc: unknown): void {
  if (chunk === null || chunk === undefined || chunk === '') return;
  if (Buffer.isBuffer(chunk)) {
    chunks.push(chunk);
    return;
  }
  if (typeof chunk === 'string') {
    chunks.push(Buffer.from(chunk, typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8'));
    return;
  }
  if (chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk));
  }
}

/**
 * A real `ServerResponse` that also keeps the payload bytes.
 *
 * Extending `ServerResponse` rather than hand-rolling an `EventEmitter` is what
 * makes the rest of the Express ecosystem work: `on-headers` (used by
 * `compression`, `express-session`, `morgan`) hooks `writeHead` and depends on
 * `_implicitHeader()` firing at exactly the right moment, `on-finished` (used by
 * `finalhandler`, `send`, body-parser) branches on `finished`/`writableEnded`
 * and the socket's `writable` flag, and `res.sendFile` pipes a stream into `res`
 * and needs genuine backpressure. Reimplementing that state machine is strictly
 * more work than inheriting it.
 */
export class MockResponse extends http.ServerResponse {
  /** Payload bytes only — no status line, headers, or chunked framing. */
  readonly chunks: Buffer[] = [];

  constructor(req: http.IncomingMessage) {
    super(req);

    const chunks = this.chunks;

    // These MUST be own properties, not prototype methods.
    //
    // `app.handle()` runs `Object.setPrototypeOf(res, app.response)`
    // (express@5.2.1/lib/application.js), which splices MockResponse.prototype
    // out of the chain entirely. A `write`/`end` override declared as a class
    // method is silently discarded and never invoked, and every tool call
    // returns an empty body with no error anywhere. Assigning them here as
    // instance properties keeps them ahead of whatever prototype Express swaps in.
    // Cast away the polymorphic `this` return types so the wrappers can be
    // plain arrow functions; the runtime behaviour is what matters here.
    const patch = this as unknown as {
      write: (chunk?: unknown, enc?: unknown, cb?: unknown) => boolean;
      end: (chunk?: unknown, enc?: unknown, cb?: unknown) => unknown;
    };

    patch.write = (chunk, enc, cb) => {
      // Anything written after end() is rejected by the stream and would never
      // reach a real client, so it must not reach the captured body either.
      if (!this.writableEnded) captureChunk(chunks, chunk, enc);
      return (SR_WRITE as Function).call(this, chunk, enc, cb) as boolean;
    };

    patch.end = (chunk, enc, cb) => {
      // end(cb) / end(chunk, cb) / end(chunk, enc, cb)
      if (typeof chunk !== 'function' && !this.writableEnded) {
        captureChunk(chunks, chunk, enc);
      }
      return (SR_END as Function).call(this, chunk, enc, cb);
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Exchange construction                                                      */
/* -------------------------------------------------------------------------- */

export interface ExchangeInit {
  method: string;
  /** Path plus query string, exactly as it would arrive on the wire. */
  url: string;
  /** Serialized as a JSON body. Omit for methods that carry no body. */
  body?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /** Extra properties assigned onto `req` before dispatch (e.g. `user`). */
  extend?: Record<string, unknown> | undefined;
  remoteAddress?: string | undefined;
}

export interface Exchange {
  req: http.IncomingMessage;
  res: MockResponse;
  socket: MockSocket;
}

/**
 * Build one request/response pair.
 *
 * Always call this per dispatch: `assignSocket` throws if the socket already
 * carries an `_httpMessage`, so a shared exchange would break concurrent calls.
 */
export function createExchange(init: ExchangeInit): Exchange {
  const socket = new MockSocket({ remoteAddress: init.remoteAddress });
  const req = new http.IncomingMessage(socket as unknown as Socket);

  const raw =
    init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body), 'utf8');

  req.method = init.method.toUpperCase();
  req.url = init.url;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;

  const headers: http.IncomingHttpHeaders = {
    host: 'localhost',
    accept: 'application/json, */*',
    // Deliberately no `accept-encoding`. With one present, `compression`
    // negotiates gzip and wraps `res.write` *after* us, so we would capture
    // compressed bytes where the caller expects JSON. Omitting it makes the
    // middleware negotiate `identity` and stay out of the way.
    ...(raw
      ? {
          'content-type': 'application/json; charset=utf-8',
          // Byte length, not String#length: `raw-body` compares against this and
          // rejects with a 400 "request size did not match content length" for
          // any body containing non-ASCII characters.
          'content-length': String(raw.byteLength),
        }
      : {}),
    ...lowercaseKeys(init.headers),
  };
  req.headers = headers;
  req.rawHeaders = flattenHeaders(headers);

  if (raw) {
    // Pre-set `req.body` AND push the real bytes, so both worlds work:
    //
    //  - parser mounted: `express.json()` reads the stream for real, honouring
    //    `limit`, `strict`, `verify` and charset checks, then overwrites
    //    `req.body` with the parse of these same bytes. Same value either way.
    //    (body-parser 2.x's `if (!('body' in req)) req.body = undefined` leaves
    //    our own property alone, and we deliberately do NOT set `req._body`,
    //    which would make it skip and bypass the app's own limits.)
    //  - no parser, or one configured with a non-matching `type`: our pre-set
    //    object survives and the handler still works.
    (req as http.IncomingMessage & { body?: unknown }).body = init.body;
    req.push(raw);
  }
  req.push(null);
  // `isFinished(req)` is `!socket || !socket.readable || (complete && !readable)`.
  // Right after push(null) the stream is still readable, so this stays false and
  // parsers run; once one drains it, the transition to "finished" matches a real
  // server. Without this, `onFinished(req, cb)` never fires and any middleware
  // waiting on request-finish hangs until the timeout.
  req.complete = true;

  if (init.extend) Object.assign(req, init.extend);

  const res = new MockResponse(req);
  // Without a socket assigned, `finish` never fires. See MockSocket.
  res.assignSocket(socket as unknown as Socket);

  // `http.Server` forwards the socket's 'drain' to the response message
  // (`socketOnDrain` in node's _http_server). Nothing else does, and we bypass
  // the server entirely — so without this, any `res.write()` that returns false
  // leaves `stream.pipe(res)` waiting forever for a 'drain' that never arrives.
  // That is every response larger than the socket's high-water mark, which is
  // why `res.sendFile()` hangs on a file over ~16KB but works under it.
  socket.on('drain', () => {
    res.emit('drain');
  });

  return { req, res, socket };
}

function lowercaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.push(k, item);
    else out.push(k, String(v));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

const BENIGN_STREAM_CODES = new Set([
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
  'ERR_STREAM_DESTROYED',
]);

/**
 * Run one exchange through `handler` and resolve with the captured response.
 *
 * We pass our own `done` callback rather than letting Express fall back to
 * `finalhandler`, which would hand us a pre-rendered HTML error page and throw
 * away the actual `Error`. The three outcomes are distinguishable:
 *
 *  - `'finish'` fires                      -> the app answered (including any
 *                                             4xx/5xx produced by error
 *                                             middleware, which responds normally)
 *  - `done(err)`                           -> the error escaped every layer
 *                                             uncaught; we still have the stack
 *  - `done()` with nothing written         -> no route matched -> 404
 */
export function dispatch(
  handler: ExpressLike,
  exchange: Exchange,
  options: DispatchOptions = {},
): Promise<CapturedResponse> {
  const { req, res, socket } = exchange;
  const { timeoutMs = 30_000, signal, synthesize404 = true } = options;

  return new Promise<CapturedResponse>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      fail(new DispatchTimeoutError(`handler did not respond within ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't hold the event loop open on a hung handler.
    if (typeof timer.unref === 'function') timer.unref();

    const onFinish = (): void => succeed(capture(res, true));

    const onStreamError = (err: Error & { code?: string }): void => {
      // A stray double `res.end()` surfaces here as ERR_STREAM_WRITE_AFTER_END
      // rather than throwing. With no listener attached it becomes an uncaught
      // exception and takes down the whole MCP server, so swallowing these is
      // load-bearing, not defensive.
      if (err.code && BENIGN_STREAM_CODES.has(err.code)) return;
      fail(normalizeHandlerError(err));
    };

    const onAbort = (): void => fail(new DispatchTimeoutError('dispatch aborted'));

    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('finish', onFinish);
      signal?.removeEventListener('abort', onAbort);
      // The 'error' listeners stay attached deliberately. A handler that calls
      // res.end() twice raises ERR_STREAM_WRITE_AFTER_END *after* 'finish' has
      // already settled this dispatch, and an unhandled 'error' on a stream is
      // an uncaught exception that would kill the process. They are harmless
      // once settled (fail() short-circuits) and the streams are discarded
      // immediately after, so there is nothing to leak.
    };

    // Destroying the streams is what lets `on-finished` consumers (sessions,
    // multer temp files, open fds inside `send`) run their cleanup hooks.
    const teardown = (cause?: Error): void => {
      try {
        if (!req.readableEnded) req.resume();
      } catch {
        /* already gone */
      }
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      try {
        req.destroy(cause);
      } catch {
        /* already gone */
      }
    };

    // Both paths set `settled` before tearing down, so any error event raised
    // *by* the teardown re-enters onStreamError and hits the guard below.
    const succeed = (value: CapturedResponse): void => {
      if (settled) return;
      settled = true;
      teardown();
      cleanup();
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      teardown(err);
      cleanup();
      reject(err);
    };

    const done = (err?: unknown): void => {
      if (settled) return;
      if (err !== undefined && err !== null) {
        fail(normalizeHandlerError(err));
        return;
      }
      // The handler answered and then called next() anyway. 'finish' has already
      // fired or is about to; let it win.
      if (res.writableEnded || res.headersSent) return;

      if (!synthesize404) {
        fail(new UnmatchedRouteError(`no route matched ${req.method} ${req.url}`));
        return;
      }
      succeed({
        status: 404,
        statusMessage: 'Not Found',
        headers: {},
        body: Buffer.alloc(0),
        matched: false,
        text: () => '',
        json: () => undefined,
      });
    };

    res.on('finish', onFinish);
    res.on('error', onStreamError);
    req.on('error', onStreamError);
    socket.on('error', onStreamError);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      handler(req, res, done);
    } catch (err) {
      // A synchronous throw before any middleware runs never reaches `done`.
      fail(normalizeHandlerError(err));
    }
  });
}

function capture(res: MockResponse, matched: boolean): CapturedResponse {
  const body = Buffer.concat(res.chunks);
  return {
    status: res.statusCode,
    statusMessage: res.statusMessage || http.STATUS_CODES[res.statusCode] || '',
    headers: res.getHeaders(),
    body,
    matched,
    text: () => body.toString('utf8'),
    json: () => JSON.parse(body.toString('utf8')),
  };
}
