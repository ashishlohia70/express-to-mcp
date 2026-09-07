/**
 * express-to-mcp — expose an existing Express router as MCP tools, dispatched
 * in memory with no network hop.
 */

export { ExpressMcpBridge } from './bridge.js';
export type { ToolDescriptor, ToolResult } from './bridge.js';

export {
  EMPTY_ARGS_SCHEMA,
  defineTool,
  formatSchemaIssues,
  toJsonSchema,
} from './router.js';
export type {
  ArgTarget,
  BridgeOptions,
  HttpMethod,
  JsonSchema,
  QueryStyle,
  RequestOverrides,
  ToolAnnotations,
  ToolRoute,
} from './router.js';

// Lower-level pieces, exported for advanced use and for testing an app's
// behaviour under the mock pipeline without going through MCP at all.
export {
  MockResponse,
  MockSocket,
  createExchange,
  dispatch,
} from './mock-http.js';
export type {
  CapturedResponse,
  DispatchOptions,
  Exchange,
  ExchangeInit,
  ExpressLike,
} from './mock-http.js';

export {
  PathTemplate,
  encodeQuery,
  joinPaths,
  methodTakesBody,
  resolveRequest,
} from './matchers.js';
export type { ResolveOptions, ResolvedRequest, RouteSpec } from './matchers.js';

export {
  DispatchTimeoutError,
  ExpressMcpError,
  InvalidAppError,
  MissingPathParamError,
  PathSyntaxError,
  SchemaCompilationError,
  UnmatchedRouteError,
  UnrepresentableQueryError,
  normalizeHandlerError,
} from './errors.js';
