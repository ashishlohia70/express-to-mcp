/**
 * Route declarations and the Zod -> JSON Schema compilation that feeds
 * `tools/list`.
 */

import { z, type ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { SchemaCompilationError } from './errors.js';
import type { ArgTarget, HttpMethod, QueryStyle, RouteSpec } from './matchers.js';
import type { ExpressLike } from './mock-http.js';

export type { ArgTarget, HttpMethod, QueryStyle } from './matchers.js';

/** A plain JSON Schema object, as MCP clients expect it inline. */
export type JsonSchema = Record<string, unknown>;

/**
 * MCP tool behaviour hints. Purely advisory — clients use them to decide
 * whether to auto-approve a call.
 */
export interface ToolAnnotations {
  title?: string;
  /** The tool does not modify state. */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates. */
  destructiveHint?: boolean;
  /** Repeated identical calls have no additional effect. */
  idempotentHint?: boolean;
  /** The tool touches entities outside the local environment. */
  openWorldHint?: boolean;
}

/** One Express route exposed as one MCP tool. */
export interface ToolRoute extends RouteSpec {
  /** MCP tool name. Must be unique across the bridge. */
  name: string;
  description: string;
  method: HttpMethod;
  /** Express 5 / path-to-regexp v8 syntax. */
  path: string;
  /**
   * Zod schema for the arguments the LLM supplies. Path parameters are drawn
   * from here too, so declare them alongside everything else.
   */
  schema?: ZodType | undefined;
  annotations?: ToolAnnotations | undefined;
}

/** Extra per-call context injected into the mocked request. */
export interface RequestOverrides {
  /** Merged over {@link BridgeOptions.headers}. */
  headers?: Record<string, string> | undefined;
  /**
   * Properties assigned directly onto `req` before dispatch — e.g.
   * `{ user: { id: 'u1' } }` for an app that expects auth middleware to have
   * already populated an identity.
   */
  extend?: Record<string, unknown> | undefined;
}

export interface BridgeOptions {
  /** An Express application or an `express.Router()`. */
  app: ExpressLike;
  routes: readonly ToolRoute[];
  serverInfo?: { name: string; version: string } | undefined;
  /** Headers applied to every mocked request (e.g. a service token). */
  headers?: Record<string, string> | undefined;
  /**
   * Per-call hook for auth and context. Runs after argument validation and
   * before dispatch, so it can key off the validated arguments.
   */
  buildRequest?:
    | ((
        toolName: string,
        args: Record<string, unknown>,
      ) => RequestOverrides | undefined | Promise<RequestOverrides | undefined>)
    | undefined;
  /** Per-call wall-clock budget. Defaults to 30s. */
  timeoutMs?: number | undefined;
  /**
   * How the target app parses query strings. Read from
   * `app.get('query parser')` when omitted, defaulting to Express 5's
   * `'simple'`.
   */
  queryStyle?: QueryStyle | undefined;
  /** Strip `x-powered-by` from reported response headers. Defaults to `true`. */
  stripPoweredBy?: boolean | undefined;
}

/** Argument schema for a route that declares none. */
export const EMPTY_ARGS_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  properties: {},
});

/** Zod 4 schemas carry a `_zod` internals bag; Zod 3 schemas only have `_def`. */
function isZod4Schema(schema: object): boolean {
  return '_zod' in schema;
}

/**
 * Compile a Zod schema into inline JSON Schema for `tools/list`.
 *
 * Two converters, because there is no single one that handles both majors:
 *
 *  - Zod 4 exposes a native `z.toJSONSchema()`. It must be used, because
 *    `zod-to-json-schema` does not throw on a Zod 4 schema — it silently
 *    returns a bare `{"$schema": ...}` with no properties at all, which would
 *    advertise a parameterless tool to the LLM.
 *  - Zod 3 has no native converter, so `zod-to-json-schema` handles it.
 *
 * `io: 'input'` matters: it describes what the caller must send, so
 * `.default()` and `.transform()` fields come out optional rather than
 * required. `target: 'draft-7'` inlines reused sub-schemas instead of emitting
 * `$defs`/`$ref`, which not every MCP client resolves.
 */
export function toJsonSchema(schema: ZodType, toolName: string): JsonSchema {
  let raw: JsonSchema;
  try {
    if (isZod4Schema(schema)) {
      if (typeof z.toJSONSchema !== 'function') {
        throw new Error(
          'this is a Zod 4 schema but the installed zod has no toJSONSchema(); upgrade zod to ^4',
        );
      }
      raw = z.toJSONSchema(schema as never, {
        target: 'draft-7',
        io: 'input',
      }) as JsonSchema;
    } else {
      raw = zodToJsonSchema(schema as never, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as JsonSchema;
    }
  } catch (err) {
    throw new SchemaCompilationError(
      toolName,
      err instanceof Error ? err.message : String(err),
      err,
    );
  }

  // MCP clients want a plain schema object, not a document with a dialect.
  const { $schema: _dialect, ...rest } = raw;

  // Catches both a genuinely wrong schema (e.g. `z.string()` used for
  // arguments) and any future silent-empty-output regression in either converter.
  if (rest['type'] !== 'object') {
    throw new SchemaCompilationError(
      toolName,
      `expected an object schema for tool arguments but got ${
        rest['type'] === undefined ? 'a schema with no "type"' : `type "${String(rest['type'])}"`
      }. Wrap the arguments in z.object({ ... }).`,
    );
  }
  if (rest['properties'] === undefined) rest['properties'] = {};

  return rest;
}

/** Flatten Zod issues into one line the LLM can act on. */
export function formatSchemaIssues(error: unknown): string {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }
  return issues
    .map((issue) => {
      const raw = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(raw.path) ? raw.path.join('.') : '';
      const message = typeof raw.message === 'string' ? raw.message : 'invalid value';
      return path ? `${path}: ${message}` : message;
    })
    .join('; ');
}

/**
 * Identity helper that keeps a route literal type-checked at the point of
 * declaration rather than at the call to the bridge constructor.
 */
export function defineTool(route: ToolRoute): ToolRoute {
  return route;
}
