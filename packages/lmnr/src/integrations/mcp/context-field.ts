import { initializeLogger } from "../../utils";
import { CONTEXT_DESCRIPTION, CONTEXT_MAX_LENGTH } from "./attributes";
import { type McpRequest } from "./request";
import {
  boundedSet,
  hasOwn,
  isPlainObject,
  listedOwnContextGlobal,
  type ServerState,
  warned,
} from "./shared";

const logger = initializeLogger();

export const normalizeContext = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, CONTEXT_MAX_LENGTH) : undefined;
};

const hasOwnContextProperty = (jsonSchema: unknown): boolean =>
  isPlainObject(jsonSchema) &&
  isPlainObject(jsonSchema.properties) &&
  hasOwn(jsonSchema.properties, "context");

const warnOwnContext = (toolName: string) => {
  if (warned.ownContextTools.has(toolName)) {
    return;
  }
  warned.ownContextTools.add(toolName);
  logger.warn(
    `Laminar MCP: tool "${toolName}" already declares a "context" argument, ` +
      `so Laminar does not add its own "context" field to it.`,
  );
};

/**
 * Whether the tool declares its own `context` argument (then it is left
 * alone). Decided per call, not from `tools/list`: stateless servers often
 * serve the two from different instances. McpServer: from the registered
 * tool's schema (2.x has a JSON Schema accessor; 1.x and 2.x Zod object
 * schemas expose `shape`). Otherwise, from the `tools/list` responses served
 * in this process; unknown means no.
 */
const toolDeclaresContext = (state: ServerState, name: string): boolean => {
  const mcp = state.mcpServer;
  if (mcp) {
    try {
      if (typeof mcp.toolInputSchemaJson === "function") {
        const json = mcp.toolInputSchemaJson(name);
        if (json !== undefined) {
          return hasOwnContextProperty(json);
        }
      }
      const schema = mcp._registeredTools?.[name]?.inputSchema;
      if (schema) {
        const shape =
          schema.shape ??
          schema._zod?.def?.shape ??
          (typeof schema._def?.shape === "function"
            ? schema._def.shape()
            : schema._def?.shape);
        if (isPlainObject(shape)) {
          return hasOwn(shape, "context");
        }
      }
    } catch {
      // Fall through to what tools/list showed.
    }
  }
  return (
    state.listedOwnContext.get(name) ??
    listedOwnContextGlobal.get(name) ??
    false
  );
};

/** A copy of a `tools/list` result whose tools advertise `context`. */
export const injectContext = (state: ServerState, result: any): any => {
  if (!isPlainObject(result) || !Array.isArray(result.tools)) {
    return result;
  }
  const tools = result.tools.map((tool: any) => {
    if (!isPlainObject(tool) || typeof tool.name !== "string") {
      return tool;
    }
    const schema = tool.inputSchema;
    if (
      !isPlainObject(schema) ||
      (schema.type !== undefined && schema.type !== "object")
    ) {
      return tool;
    }
    const own = hasOwnContextProperty(schema);
    state.listedOwnContext.set(tool.name, own);
    boundedSet(listedOwnContextGlobal, tool.name, own);
    if (own) {
      warnOwnContext(tool.name);
      return tool;
    }
    // Copies only: the SDK may cache the schema objects it lists.
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          ...(isPlainObject(schema.properties) ? schema.properties : {}),
          context: { type: "string", description: CONTEXT_DESCRIPTION },
        },
      },
    };
  });
  return { ...result, tools };
};

/**
 * The request to hand the inner handler (a copy without our `context`
 * argument, so strict schemas still validate) and the stripped value.
 */
export const splitContext = (
  state: ServerState,
  req: McpRequest,
  request: any,
): { forwarded: any; context?: unknown } => {
  const args = req.params.arguments;
  if (
    req.method !== "tools/call" ||
    !state.options.context ||
    !req.target ||
    !isPlainObject(args) ||
    !hasOwn(args, "context") ||
    toolDeclaresContext(state, req.target)
  ) {
    return { forwarded: request };
  }
  const { context, ...rest } = args;
  // A copy: the transport may share the message object with the sender.
  return {
    forwarded: { ...request, params: { ...req.params, arguments: rest } },
    context,
  };
};
