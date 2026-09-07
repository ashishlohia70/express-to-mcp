/**
 * The orchestrator: an MCP server whose tools are Express routes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
  ExpressMcpError,
  InvalidAppError,
  UnrepresentableQueryError,
} from './errors.js';
import {
  PathTemplate,
  joinPaths,
  methodTakesBody,
  resolveRequest,
  type QueryStyle,
} from './matchers.js';
import {
  createExchange,
  dispatch,
  type CapturedResponse,
  type ExpressLike,
} from './mock-http.js';
import {
  EMPTY_ARGS_SCHEMA,
  formatSchemaIssues,
  toJsonSchema,
  type BridgeOptions,
  type JsonSchema,
  type ToolRoute,
} from './router.js';

/** One MCP tool descriptor, as returned by `tools/list`. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolRoute['annotations'];
}

/**
 * An MCP `tools/call` result.
 *
 * Declared as a type alias rather than an interface so it picks up an implicit
 * index signature and stays assignable to the SDK's `ServerResult` union.
 */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

interface CompiledRoute {
  route: ToolRoute;
  template: PathTemplate;
  inputSchema: JsonSchema;
}

/** Minimal view of the parts of an Express application we rely on. */
interface ExpressAppLike extends ExpressLike {
  handle(req: unknown, res: unknown, cb: unknown): void;
  set(setting: string, value: unknown): unknown;
  get(setting: string): unknown;
  listen(...args: unknown[]): unknown;
  use(...args: unknown[]): unknown;
}

function isExpressApp(value: unknown): value is ExpressAppLike {
  if (typeof value !== 'function') return false;
  const candidate = value as Partial<ExpressAppLike>;
  return (
    typeof candidate.handle === 'function' &&
    typeof candidate.set === 'function' &&
    typeof candidate.listen === 'function'
  );
}

export class ExpressMcpBridge {
  /**
   * The configured MCP server. Attach whichever transport you need:
   *
   * ```ts
   * await bridge.server.connect(new StdioServerTransport());
   * ```
   */
  readonly server: Server;

  readonly #routes = new Map<string, CompiledRoute>();
  readonly #options: BridgeOptions;
  readonly #queryStyle: QueryStyle;
  readonly #stripPoweredBy: boolean;

  /** Set when `options.app` is a bare Router that needs wrapping on first use. */
  #rawHandler: ExpressLike;
  #wrapped: Promise<ExpressLike> | undefined;
  readonly #needsWrap: boolean;

  constructor(options: BridgeOptions) {
    this.#options = options;
    this.#stripPoweredBy = options.stripPoweredBy ?? true;

    if (typeof options.app !== 'function') {
      throw new InvalidAppError(
        'options.app must be an Express application or an express.Router() instance.',
      );
    }
    this.#rawHandler = options.app;
    this.#needsWrap = !isExpressApp(options.app);

    // Mirror the app's own query parser so encoded arguments survive the round
    // trip. Express 5 defaults to 'simple' (node:querystring).
    this.#queryStyle =
      options.queryStyle ??
      (isExpressApp(options.app) ? readQueryStyle(options.app) : 'simple');

    // Compile and validate everything up front: a bad path or an
    // untransportable argument is a developer error and must not surface as a
    // confusing tool failure at LLM call time.
    for (const route of options.routes) {
      if (this.#routes.has(route.name)) {
        throw new ExpressMcpError(
          `Duplicate MCP tool name ${JSON.stringify(route.name)}. Tool names must be unique.`,
        );
      }
      const template = PathTemplate.parse(joinPaths(route.basePath, route.path));
      const inputSchema = route.schema
        ? toJsonSchema(route.schema, route.name)
        : EMPTY_ARGS_SCHEMA;

      this.#assertQueryArgsTransportable(route, template, inputSchema);

      this.#routes.set(route.name, { route, template, inputSchema });
    }

    this.server = new Server(
      options.serverInfo ?? { name: 'express-to-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.listTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callTool(request.params.name, request.params.arguments ?? {}),
    );
  }

  /** Tool descriptors, with schemas compiled once at construction. */
  listTools(): ToolDescriptor[] {
    return [...this.#routes.values()].map(({ route, inputSchema }) => {
      const descriptor: ToolDescriptor = {
        name: route.name,
        description: route.description,
        inputSchema,
      };
      if (route.annotations) descriptor.annotations = route.annotations;
      return descriptor;
    });
  }

  /**
   * Validate arguments, dispatch through Express, and format the response.
   *
   * Never throws: every failure becomes an `isError` result, because a throw
   * here reaches the client as an opaque JSON-RPC internal error with nothing
   * the LLM can act on.
   */
  async callTool(name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
    const compiled = this.#routes.get(name);
    if (!compiled) {
      const known = [...this.#routes.keys()].join(', ') || '(none)';
      return errorResult(`Unknown tool ${JSON.stringify(name)}. Available tools: ${known}`);
    }
    const { route, template } = compiled;

    let args: Record<string, unknown> = rawArgs;
    if (route.schema) {
      const parsed = route.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(`Invalid arguments for ${name}: ${formatSchemaIssues(parsed.error)}`);
      }
      args = (parsed.data ?? {}) as Record<string, unknown>;
    }

    try {
      const overrides = (await this.#options.buildRequest?.(name, args)) ?? {};
      const resolved = resolveRequest(
        route,
        args,
        { queryStyle: this.#queryStyle },
        template,
      );

      const exchange = createExchange({
        method: route.method,
        url: resolved.url,
        body: methodTakesBody(route.method) ? (resolved.body ?? {}) : resolved.body,
        headers: { ...this.#options.headers, ...overrides.headers },
        extend: overrides.extend,
      });

      const handler = await this.#getHandler();
      const captured = await dispatch(handler, exchange, {
        timeoutMs: this.#options.timeoutMs ?? 30_000,
      });

      return this.#formatResponse(route, captured);
    } catch (err) {
      if (err instanceof ExpressMcpError) {
        return errorResult(`${route.method} ${route.path} failed: ${err.message}`);
      }
      const status = (err as { status?: number } | null)?.status;
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(
        `${route.method} ${route.path} failed${status ? ` (HTTP ${status})` : ''}: ${message}`,
      );
    }
  }

  /** Convenience passthrough for `bridge.server.connect(transport)`. */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /* ---------------------------------------------------------------------- */

  #formatResponse(route: ToolRoute, captured: CapturedResponse): ToolResult {
    const headers = { ...captured.headers };
    if (this.#stripPoweredBy) delete headers['x-powered-by'];

    const contentType = String(headers['content-type'] ?? '');
    const raw = captured.body.length > 0 ? captured.body.toString('utf8') : '';

    let rendered = raw;
    if (raw && contentType.includes('json')) {
      try {
        rendered = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Malformed JSON despite the header — show it verbatim rather than hide it.
      }
    }

    const isError = captured.status >= 400;
    const statusLine = `HTTP ${captured.status} ${captured.statusMessage}`.trimEnd();

    if (!captured.matched) {
      return errorResult(
        `${statusLine} — no route matched ${route.method} ${route.path}. ` +
          'Check the tool path against the routes actually mounted on the app.',
      );
    }
    if (!rendered) return { content: [{ type: 'text', text: statusLine }], ...(isError ? { isError: true } : {}) };
    if (isError) return errorResult(`${statusLine}\n${rendered}`);
    return { content: [{ type: 'text', text: rendered }] };
  }

  /**
   * A bare Router cannot be called directly: `app.handle()` is what runs
   * `Object.setPrototypeOf(req, app.request)`, so invoking `router(req,res,next)`
   * leaves us with no `res.json`, no `res.send`, and a `req.query` getter that
   * throws because `req.app` is undefined. Mount it on a throwaway app instead.
   */
  async #getHandler(): Promise<ExpressLike> {
    if (!this.#needsWrap) return this.#rawHandler;
    this.#wrapped ??= (async () => {
      let express: () => ExpressAppLike;
      try {
        const mod: unknown = await import('express');
        const candidate =
          (mod as { default?: unknown }).default ?? (mod as unknown);
        if (typeof candidate !== 'function') throw new Error('express export is not callable');
        express = candidate as () => ExpressAppLike;
      } catch (err) {
        throw new InvalidAppError(
          'options.app looks like a bare Router, so express is needed to mount it, ' +
            'but express could not be imported. Either install express or pass a full ' +
            'Express application (const app = express(); app.use(router)).',
          { cause: err },
        );
      }
      const app = express();
      if (this.#options.queryStyle) app.set('query parser', this.#options.queryStyle);
      app.use(this.#rawHandler);
      return app;
    })();
    return this.#wrapped;
  }

  /**
   * Reject, at construction, any argument that could not survive the app's
   * query parser.
   *
   * Under the default `'simple'` parser a nested object encodes to `?a[b]=c`
   * and comes back as the literal key `"a[b]"`. Catching it here means the LLM
   * never sees a parameter that cannot work.
   */
  #assertQueryArgsTransportable(
    route: ToolRoute,
    template: PathTemplate,
    inputSchema: JsonSchema,
  ): void {
    if (this.#queryStyle === 'extended') return;

    const properties = inputSchema['properties'];
    if (typeof properties !== 'object' || properties === null) return;

    const goesToBodyByDefault =
      route.argsIn && route.argsIn !== 'auto'
        ? route.argsIn === 'body'
        : methodTakesBody(route.method);

    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      // Path parameters are encoded into the URL, never the query string.
      if (template.allNames.includes(key)) continue;

      const target = route.queryParams?.includes(key)
        ? 'query'
        : route.bodyParams?.includes(key)
          ? 'body'
          : goesToBodyByDefault
            ? 'body'
            : 'query';
      if (target !== 'query') continue;

      if (isObjectValued(value)) {
        throw new UnrepresentableQueryError(
          `${route.name}.${key}`,
          this.#queryStyle,
          'nested objects are not representable',
        );
      }
    }
  }
}

/** Does this JSON Schema describe an object, or an array of objects? */
function isObjectValued(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const node = schema as Record<string, unknown>;
  const type = node['type'];
  if (type === 'object' || (type === undefined && node['properties'] !== undefined)) return true;
  if (type === 'array') return isObjectValued(node['items']);
  // Unions still count if any branch is an object.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.some(isObjectValued)) return true;
  }
  return false;
}

function readQueryStyle(app: ExpressAppLike): QueryStyle {
  try {
    const setting = app.get('query parser');
    return setting === 'extended' ? 'extended' : 'simple';
  } catch {
    return 'simple';
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
