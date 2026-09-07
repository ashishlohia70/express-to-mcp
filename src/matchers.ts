/**
 * Turns a declared route plus a flat bag of LLM-supplied arguments into a
 * concrete URL, a request body, and a record of which arguments were consumed.
 *
 * The central decision here: we never assign `req.params` or `req.query`. Both
 * are derived by Express from `req.url`, so the only reliable way to get values
 * into them is to build a correct URL and let the framework do its job.
 */

import { compile, parse, type ParamData, type Token, type TokenData } from 'path-to-regexp';
import {
  MissingPathParamError,
  PathSyntaxError,
  UnrepresentableQueryError,
} from './errors.js';

export type HttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS';

/**
 * How the target app parses query strings.
 *
 * `'simple'` is Express 5's default (`node:querystring`) and has no bracket
 * semantics: `?a[b]=c` yields the literal key `"a[b]"`. `'extended'` is `qs`,
 * which understands nesting.
 */
export type QueryStyle = 'simple' | 'extended';

/** Where non-path arguments go. `'auto'` picks by HTTP method. */
export type ArgTarget = 'auto' | 'body' | 'query';

export interface RouteSpec {
  method: HttpMethod;
  /** Express 5 / path-to-regexp v8 syntax, e.g. `/api/org/:orgId/users/:userId`. */
  path: string;
  /** Router mount prefix, if the bridged router is mounted under one. */
  basePath?: string | undefined;
  argsIn?: ArgTarget | undefined;
  /** Argument names forced into the query string. */
  queryParams?: readonly string[] | undefined;
  /** Argument names forced into the body. */
  bodyParams?: readonly string[] | undefined;
}

export interface ResolveOptions {
  queryStyle?: QueryStyle | undefined;
}

export interface ResolvedRequest {
  /** Assign straight to `req.url`. */
  url: string;
  pathname: string;
  /** `''` or `'?a=1&b=2'`. */
  search: string;
  body: Record<string, unknown> | undefined;
  /** Argument names that were spent on path parameters. */
  consumedParams: ReadonlySet<string>;
  queryKeys: readonly string[];
  bodyKeys: readonly string[];
}

/** Methods for which `'auto'` routes arguments into a JSON body. */
export function methodTakesBody(method: HttpMethod): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

/* -------------------------------------------------------------------------- */
/* Path templates                                                             */
/* -------------------------------------------------------------------------- */

interface WalkResult {
  params: string[];
  wildcards: string[];
  optional: Set<string>;
}

function walk(tokens: readonly Token[], depth: number, out: WalkResult): void {
  for (const token of tokens) {
    // path-to-regexp 8.0/8.1 emitted bare strings for text tokens; 8.4 emits
    // {type:'text'}. Tolerate both so a patch bump can't break parsing.
    if (typeof token === 'string') continue;
    switch (token.type) {
      case 'text':
        break;
      case 'param':
        out.params.push(token.name);
        if (depth > 0) out.optional.add(token.name);
        break;
      case 'wildcard':
        out.wildcards.push(token.name);
        if (depth > 0) out.optional.add(token.name);
        break;
      case 'group':
        // A `{...}` group is optional, so everything inside it is too.
        walk(token.tokens, depth + 1, out);
        break;
    }
  }
}

/**
 * A parsed route path, able to expand itself back into a concrete pathname.
 *
 * Parsing happens once at bridge construction so that a malformed path fails
 * immediately rather than on the first tool call.
 */
export class PathTemplate {
  readonly paramNames: readonly string[];
  readonly wildcardNames: readonly string[];
  readonly optionalNames: ReadonlySet<string>;
  /** Every name that can be filled from arguments. */
  readonly allNames: readonly string[];

  private readonly toPath: (params?: ParamData) => string;

  private constructor(
    readonly path: string,
    tokenData: TokenData,
    walked: WalkResult,
  ) {
    this.paramNames = walked.params;
    this.wildcardNames = walked.wildcards;
    this.optionalNames = walked.optional;
    this.allNames = [...walked.params, ...walked.wildcards];
    // Reusing the already-parsed TokenData avoids a second parse per call.
    this.toPath = compile(tokenData, { encode: encodeURIComponent });
  }

  static parse(path: string): PathTemplate {
    let tokenData: TokenData;
    try {
      tokenData = parse(path);
    } catch (err) {
      // PathError extends TypeError. Thrown on Express 4 leftovers like `:id?`,
      // `:id(\d+)` and bare `*`, plus the reserved set ()[]?+!
      throw new PathSyntaxError(path, err);
    }
    const walked: WalkResult = { params: [], wildcards: [], optional: new Set() };
    walk(tokenData.tokens, 0, walked);
    return new PathTemplate(path, tokenData, walked);
  }

  /**
   * Fill the template from `args`, returning the pathname and the argument
   * names that were consumed.
   */
  expand(args: Readonly<Record<string, unknown>>): {
    pathname: string;
    consumed: Set<string>;
  } {
    const consumed = new Set<string>();
    const data: ParamData = {};

    for (const name of this.paramNames) {
      const value = args[name];
      // An empty string compiles to a zero-length segment ("//"), which 404s
      // with no useful diagnostic. Treat it as absent.
      if (value === undefined || value === null || value === '') continue;
      data[name] = scalarToString(value, name);
      consumed.add(name);
    }

    for (const name of this.wildcardNames) {
      const value = args[name];
      if (value === undefined || value === null || value === '') continue;
      // compile() encodes each element separately and joins with '/', so a
      // slash-bearing string must be split first or the whole splat collapses
      // into a single %2F-escaped segment.
      const segments = Array.isArray(value)
        ? value.map((item) => scalarToString(item, name))
        : scalarToString(value, name).split('/');
      const filtered = segments.filter((segment) => segment !== '');
      if (filtered.length === 0) continue;
      data[name] = filtered;
      consumed.add(name);
    }

    try {
      return { pathname: this.toPath(data), consumed };
    } catch (err) {
      const missing = this.allNames.find(
        (name) => data[name] === undefined && !this.optionalNames.has(name),
      );
      if (missing) throw new MissingPathParamError(missing, this.path);
      throw new PathSyntaxError(this.path, err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Query encoding                                                             */
/* -------------------------------------------------------------------------- */

/** `qs` refuses to parse deeper than this by default. */
const MAX_QUERY_DEPTH = 5;

/**
 * Encode arguments into a query string the target app can actually parse back.
 *
 * Arrays become repeated keys (`t=1&t=2`), which both parsers decode to an
 * array. Nested objects need bracket notation, which only `'extended'`
 * understands — under `'simple'` we refuse rather than silently deliver a
 * literal `"filter[type]"` key to the handler.
 */
export function encodeQuery(
  obj: Readonly<Record<string, unknown>>,
  style: QueryStyle,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) append(params, key, value, style, 0);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function append(
  params: URLSearchParams,
  key: string,
  value: unknown,
  style: QueryStyle,
  depth: number,
): void {
  // Omit rather than stringify: String(undefined) would send the literal
  // "undefined" and the handler would treat it as a real value.
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (isComposite(item)) {
        requireExtended(key, style);
        append(params, `${key}[${index}]`, item, style, depth + 1);
      } else {
        append(params, key, item, style, depth + 1);
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    requireExtended(key, style);
    if (depth >= MAX_QUERY_DEPTH) {
      throw new UnrepresentableQueryError(
        key,
        style,
        `nesting deeper than ${MAX_QUERY_DEPTH} levels is rejected by the query parser`,
      );
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      append(params, `${key}[${childKey}]`, childValue, style, depth + 1);
    }
    return;
  }

  params.append(key, scalarToString(value, key));
}

function requireExtended(key: string, style: QueryStyle): void {
  if (style !== 'extended') throw new UnrepresentableQueryError(key, style);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return !(value instanceof Date);
}

function isComposite(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function scalarToString(value: unknown, key: string): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new UnrepresentableQueryError(key, 'simple', `${value} is not a finite number`);
      }
      return String(value);
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      if (value instanceof Date) return value.toISOString();
      throw new UnrepresentableQueryError(
        key,
        'simple',
        `cannot serialize ${Object.prototype.toString.call(value)} into a URL`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Join a mount prefix and a route path without producing a double slash, while
 * preserving the declared trailing slash (Express's `strict routing` setting
 * makes it significant).
 */
export function joinPaths(basePath: string | undefined, path: string): string {
  if (!basePath || basePath === '/') return ensureLeadingSlash(path);
  const base = ensureLeadingSlash(basePath).replace(/\/+$/, '');
  const rest = ensureLeadingSlash(path);
  if (rest === '/') return base === '' ? '/' : base;
  return `${base}${rest}`;
}

function ensureLeadingSlash(path: string): string {
  if (path === '') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Resolve a route plus arguments into everything needed to build a request.
 *
 * `template` may be passed in to reuse the parse done at registration time.
 */
export function resolveRequest(
  route: RouteSpec,
  args: Readonly<Record<string, unknown>>,
  options: ResolveOptions = {},
  template?: PathTemplate,
): ResolvedRequest {
  const style = options.queryStyle ?? 'simple';
  const tpl = template ?? PathTemplate.parse(joinPaths(route.basePath, route.path));
  const { pathname, consumed } = tpl.expand(args);

  const fallbackTarget: 'body' | 'query' =
    route.argsIn && route.argsIn !== 'auto'
      ? route.argsIn
      : methodTakesBody(route.method)
        ? 'body'
        : 'query';

  const toBody: Record<string, unknown> = {};
  const toQuery: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key)) continue;
    const target = route.queryParams?.includes(key)
      ? 'query'
      : route.bodyParams?.includes(key)
        ? 'body'
        : fallbackTarget;
    if (target === 'body') toBody[key] = value;
    else toQuery[key] = value;
  }

  const search = encodeQuery(toQuery, style);
  const bodyKeys = Object.keys(toBody);

  return {
    url: pathname + search,
    pathname,
    search,
    body: bodyKeys.length > 0 ? toBody : undefined,
    consumedParams: consumed,
    queryKeys: Object.keys(toQuery),
    bodyKeys,
  };
}
