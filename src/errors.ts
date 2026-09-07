/**
 * Error classes shared by the mock-http and matchers layers, plus the
 * normalizer that turns whatever an Express handler threw into an Error with a
 * usable HTTP status.
 *
 * This module exists to keep `mock-http.ts` and `matchers.ts` free of an import
 * cycle: both throw these, and `bridge.ts` maps them onto MCP tool results.
 */

/** Base class so consumers can catch everything this library throws. */
export class ExpressMcpError extends Error {
  /** HTTP-ish status used when reporting the failure back to the LLM. */
  readonly status: number = 500;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The declared route path is not valid `path-to-regexp` v8 syntax.
 *
 * Thrown at bridge construction, not at call time — a malformed path is a
 * developer error and should never reach an LLM.
 */
export class PathSyntaxError extends ExpressMcpError {
  override readonly status = 500;

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `Invalid route path ${JSON.stringify(path)}: ${describe(cause)}\n` +
        'express-to-mcp targets Express 5, which uses path-to-regexp v8 syntax:\n' +
        '  optional segments use braces  -  "/:file{.:ext}"  not  "/:file.:ext?"\n' +
        '  wildcards must be named       -  "/*splat"        not  "/*"\n' +
        '  inline regex is unsupported   -  use two routes instead of "/:id(\\\\d+)"\n' +
        '  ()[]?+! are reserved          -  escape them with a backslash',
      { cause },
    );
  }
}

/** A path parameter had no value in the tool arguments (or was an empty string). */
export class MissingPathParamError extends ExpressMcpError {
  override readonly status = 400;

  constructor(
    readonly param: string,
    readonly path: string,
  ) {
    super(
      `Missing required path parameter ${JSON.stringify(param)} for route ${JSON.stringify(path)}. ` +
        'Provide a non-empty value.',
    );
  }
}

/**
 * An argument cannot survive the round trip through the app's query parser.
 *
 * Express 5 defaults to the `'simple'` query parser (`node:querystring`), which
 * has no bracket semantics: `?a[b]=c` parses to the literal key `"a[b]"` rather
 * than `{a: {b: 'c'}}`. Nested objects are therefore only transportable when the
 * app opts into `app.set('query parser', 'extended')`.
 */
export class UnrepresentableQueryError extends ExpressMcpError {
  override readonly status = 500;

  constructor(
    readonly key: string,
    readonly style: string,
    detail = 'nested objects are not representable',
  ) {
    super(
      `Query argument ${JSON.stringify(key)} cannot be encoded for this app: ${detail} ` +
        `under the '${style}' query parser. ` +
        (style === 'simple'
          ? "Either flatten the argument, route it to the body, or call app.set('query parser', 'extended')."
          : 'Flatten the argument or route it to the request body.'),
    );
  }
}

/**
 * A route's Zod schema could not be turned into JSON Schema.
 *
 * Thrown at bridge construction. The usual causes are a type with no JSON
 * representation (`z.date()`, `z.bigint()`, `z.map()`) or a non-object schema
 * used for tool arguments.
 */
export class SchemaCompilationError extends ExpressMcpError {
  override readonly status = 500;

  constructor(toolName: string, detail: string, cause?: unknown) {
    super(`Cannot compile the argument schema for tool ${JSON.stringify(toolName)}: ${detail}`, {
      cause,
    });
  }
}

/** The Express router ran out of layers without anyone answering. */
export class UnmatchedRouteError extends ExpressMcpError {
  override readonly status = 404;
}

/** The handler neither responded nor called `next()` before the deadline. */
export class DispatchTimeoutError extends ExpressMcpError {
  override readonly status = 504;
}

/** `options.app` was neither an Express application nor a Router. */
export class InvalidAppError extends ExpressMcpError {
  override readonly status = 500;
}

/**
 * Coerce an unknown thrown value into an Error carrying a usable status.
 *
 * Express handlers reject or throw arbitrary values. `http-errors` instances
 * (what `express.json()` and friends produce) carry `status`/`statusCode`, so
 * preserve those; anything else becomes a 500.
 */
export function normalizeHandlerError(value: unknown): Error & { status: number } {
  const err: Error =
    value instanceof Error ? value : new Error(typeof value === 'string' ? value : describe(value));

  const candidate = value as { status?: unknown; statusCode?: unknown } | null | undefined;
  const status =
    pickStatus(candidate?.status) ?? pickStatus(candidate?.statusCode) ?? 500;

  // Assign rather than reconstruct: callers benefit from the original stack.
  return Object.assign(err, { status });
}

function pickStatus(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
