import { initializeLogger } from "../../../utils";
import {
  type InstrumentedModule,
  LaminarInstrumentation,
  type PatchedMethod,
} from "../shared/base";
import { injectContext } from "./context-field";
import { getMcpOptions } from "./options";
import { type Handler, nonEmptyString, type ServerState } from "./shared";
import { traceRequest } from "./span";

export { type McpOptions, setMcpOptions } from "./options";
export { resetMcpState } from "./shared";

const logger = initializeLogger();

const SDK_V2 = "@modelcontextprotocol/server";

const STATE = Symbol.for("lmnr.mcp.server");

// What MCP observability mode traces; listing, `ping` would mint noise traces.
const OBSERVED_METHODS = new Set([
  "tools/call",
  "prompts/get",
  "resources/read",
]);

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
  return (request, extra) => {
    const options = getMcpOptions();
    if (options.observe ? OBSERVED_METHODS.has(method) : true) {
      return traceRequest(state, options, method, handler, request, extra);
    }
    const result = handler(request, extra);
    if (method !== "tools/list" || !options.context) {
      return result;
    }
    return Promise.resolve(result).then((listed) => {
      try {
        return injectContext(listed);
      } catch (e) {
        logger.debug(`Laminar MCP: failed to add "context": ${String(e)}`);
        return listed;
      }
    });
  };
};

/**
 * Wrap every handler in the low-level server's `_requestHandlers` Map, the
 * same in 1.x (`Protocol`) and 2.x. Our wrapper is the outermost layer: it
 * sees the raw request before the SDK's schema parse and McpServer's argument
 * validation, and the result or the thrown error. Once per server.
 */
const hookServer = (protocol: any): ServerState | undefined => {
  if (protocol[STATE]) {
    return protocol[STATE];
  }
  const table = protocol._requestHandlers;
  if (!(table instanceof Map)) {
    return undefined;
  }
  const state: ServerState = { protocol };
  Object.defineProperty(protocol, STATE, { value: state });
  const originalSet = table.set;
  const wrapEntry = (method: string, handler: Handler): Handler =>
    typeof handler === "function"
      ? wrapHandler(state, method, handler)
      : handler;
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
  return state;
};

/**
 * MCP servers (`@modelcontextprotocol/sdk` 1.x, `@modelcontextprotocol/server`
 * 2.x): a SERVER span per request the server handles. 2.x is patched when
 * required; 1.x and ESM imports through `instrumentModules: { mcp }` (the
 * `Server` / `McpServer` classes, a module exporting them, or an array; the
 * base `manuallyInstrument` hands each to the module entry that `accepts` it).
 * `connect` is the one call every server makes before it handles a request,
 * so it is where a server's handler table gets hooked; `McpServer.connect`
 * also links the `McpServer` (its tool registry) to its low-level server.
 *
 * `Laminar.initialize({ mcp })` switches MCP observability mode; the handlers
 * read it per request.
 */
export class McpInstrumentation extends LaminarInstrumentation {
  constructor() {
    super("mcp");
  }

  protected modules(): InstrumentedModule[] {
    return [
      {
        name: SDK_V2,
        supportedVersions: [">=2.0.0 <3"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) => this.unpatch(moduleExports),
        accepts: (input) => this.classes(input).length > 0,
      },
      // `@modelcontextprotocol/sdk` 1.x can't be hooked on require: its "."
      // export points at a file the package doesn't ship, and
      // require-in-the-middle skips the internal files of a package whose
      // main doesn't resolve. 1.x servers need `instrumentModules.mcp`, whose
      // classes the entry above `accepts`.
    ];
  }

  /** `Server` / `McpServer` classes in a module, or the value itself. */
  private classes(input: any): any[] {
    const candidates =
      typeof input === "function" ? [input] : [input?.Server, input?.McpServer];
    return candidates.filter(
      (cls) =>
        typeof cls === "function" &&
        typeof cls.prototype?.connect === "function",
    );
  }

  private patch(input: any): void {
    for (const cls of this.classes(input)) {
      this.wrapMethod(cls.prototype, "connect", (patched) =>
        this.patchConnect(patched),
      );
    }
  }

  private unpatch(input: any): void {
    for (const cls of this.classes(input)) {
      this.unwrapMethod(cls.prototype, "connect");
    }
  }

  private patchConnect({ original }: PatchedMethod) {
    return function (this: any, ...args: any[]) {
      try {
        // An `McpServer` wraps a low-level `server`; a `Server` is one.
        const isMcpServer = this?.server?._requestHandlers instanceof Map;
        const state = hookServer(isMcpServer ? this.server : this);
        if (state && isMcpServer) {
          state.mcpServer = this;
        }
      } catch (e) {
        logger.debug(`Laminar MCP: failed to hook the server: ${String(e)}`);
      }
      return original.apply(this, args);
    };
  }
}
