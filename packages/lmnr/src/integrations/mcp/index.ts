import { initializeLogger } from "../../utils";
import { injectContext } from "./context-field";
import { resolveMcpOptions, type WrapMcpServerOptions } from "./options";
import {
  type Handler,
  isPlainObject,
  nonEmptyString,
  type ProtocolLike,
  type ServerState,
} from "./shared";
import { traceRequest } from "./span";

export { resolveMcpOptions, type WrapMcpServerOptions } from "./options";
export { resetMcpState } from "./shared";

const logger = initializeLogger();

const WRAPPED = Symbol.for("lmnr.mcp.wrapped");

const TRACED_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

const wrapHandler = (
  state: ServerState,
  method: string,
  handler: Handler,
): Handler => {
  if (method === "initialize") {
    // 1.x keeps the negotiated protocol version nowhere else.
    return (request, extra) =>
      Promise.resolve(handler(request, extra)).then((result: any) => {
        state.protocolVersion =
          nonEmptyString(result?.protocolVersion) ?? state.protocolVersion;
        return result;
      });
  }
  if (method === "tools/list") {
    return (request, extra) => {
      const result = handler(request, extra);
      if (!state.options.context) {
        return result;
      }
      return Promise.resolve(result).then((listed) => {
        try {
          return injectContext(state, listed);
        } catch (e) {
          logger.debug(`Laminar MCP: failed to add "context": ${String(e)}`);
          return listed;
        }
      });
    };
  }
  if (TRACED_METHODS.has(method)) {
    return (request, extra) =>
      traceRequest(state, method, handler, request, extra);
  }
  return handler;
};

/**
 * Wrap every handler in the low-level server's `_requestHandlers` Map, the
 * same in 1.x (`Protocol`) and 2.x. Our wrapper is the outermost layer: it
 * sees the raw request before the SDK's schema parse and McpServer's argument
 * validation, and the result or the thrown error.
 */
const hookHandlerTable = (state: ServerState) => {
  const table = state.protocol._requestHandlers;
  const originalSet = table.set;
  const wrapEntry = (method: string, handler: Handler): Handler => {
    if (typeof handler !== "function") {
      return handler;
    }
    try {
      return wrapHandler(state, method, handler);
    } catch {
      return handler;
    }
  };
  // Handlers registered later (McpServer registers its tools/prompts/resources
  // handlers lazily, on the first `registerTool` & co.) go through `set`.
  Object.defineProperty(table, "set", {
    configurable: true,
    writable: true,
    value: function (
      this: Map<string, Handler>,
      method: string,
      handler: Handler,
    ) {
      return originalSet.call(this, method, wrapEntry(method, handler));
    },
  });
  for (const [method, handler] of Array.from(table.entries())) {
    originalSet.call(table, method, wrapEntry(method, handler));
  }
};

const isProtocolLike = (value: unknown): value is ProtocolLike =>
  isPlainObject(value) &&
  value._requestHandlers instanceof Map &&
  typeof value.setRequestHandler === "function";

/**
 * Trace every `tools/call`, `prompts/get` and `resources/read` request the
 * MCP server handles as a Laminar span, one trace per user turn.
 *
 * Works with `McpServer` and the low-level `Server` of
 * `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` 2.x.
 * Call it before or after registering tools, before or after `connect()`.
 * With Streamable HTTP servers that create a server per session or per
 * request, wrap each one.
 *
 * Returns the same server object (instrumented in place). Wrapping twice is a
 * no-op. Instrumentation never changes what the server answers: if anything
 * goes wrong while recording, the request is handled as if unwrapped.
 *
 * @example
 * ```ts
 * import { Laminar, wrapMcpServer } from "@lmnr-ai/lmnr";
 * Laminar.initialize({ projectApiKey: process.env.LMNR_PROJECT_API_KEY });
 * const server = wrapMcpServer(new McpServer({ name: "docs", version: "1.0.0" }));
 * ```
 */
export const wrapMcpServer = <T>(
  server: T,
  options?: WrapMcpServerOptions,
): T => {
  try {
    const candidate = server as any;
    const isMcpServer =
      isPlainObject(candidate) &&
      isProtocolLike(candidate.server) &&
      isPlainObject(candidate._registeredTools);
    const protocol: unknown = isMcpServer ? candidate.server : candidate;
    if (!isProtocolLike(protocol)) {
      logger.warn(
        "Laminar MCP: wrapMcpServer expects an McpServer or Server from the " +
          "MCP TypeScript SDK; the server is left unwrapped.",
      );
      return server;
    }
    let state = (protocol as any)[WRAPPED] as ServerState | undefined;
    if (!state) {
      state = {
        protocol,
        options: resolveMcpOptions(options),
        listedOwnContext: new Map(),
      };
      Object.defineProperty(protocol, WRAPPED, { value: state });
      hookHandlerTable(state);
    }
    // Its tool registry answers "does this tool declare its own `context`?".
    state.mcpServer ??= isMcpServer ? candidate : undefined;
  } catch (e) {
    logger.warn(`Laminar MCP: failed to wrap the server: ${String(e)}`);
  }
  return server;
};
