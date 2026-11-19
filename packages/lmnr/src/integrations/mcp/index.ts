import {
  type Attributes,
  type Context,
  context as contextApi,
  createContextKey,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getTracer } from "../../opentelemetry-lib/tracing";
import {
  SESSION_ID,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
} from "../../opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "../../opentelemetry-lib/tracing/context";
import {
  enableForcedTraceIds,
  isValidTraceId,
  withForcedTraceId,
} from "../../opentelemetry-lib/tracing/id-generator";
import { initializeLogger, toJson, truncateSpanPayload } from "../../utils";
import {
  AI_INVOCATION_META_KEY,
  CLIENT_INFO_META_KEY,
  CONTEXT_DESCRIPTION,
  CONTEXT_MAX_LENGTH,
  ERROR_TYPE,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROMPT_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  JSONRPC_REQUEST_ID,
  LMNR_MCP_CLIENT_NAME,
  LMNR_MCP_CLIENT_VERSION,
  LMNR_MCP_CONTEXT,
  MCP_METHOD_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_URI,
  MCP_SESSION_ID,
  NETWORK_PROTOCOL_NAME,
  NETWORK_TRANSPORT,
  OPENAI_SESSION_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  RPC_RESPONSE_STATUS_CODE,
  TOOL_ERROR,
  TRACEPARENT_META_KEY,
} from "./attributes";
import { buildExtraKeys, redact } from "./redact";
import {
  DEFAULT_TURN_GAP_MS,
  MAX_TURN_GAP_MS,
  parseTraceparent,
  TurnTracker,
  traceIdForTurn,
} from "./turns";

const logger = initializeLogger();

export interface WrapMcpServerOptions {
  /**
   * Add an optional `context` string argument to every tool's advertised
   * input schema, asking the model for one sentence on the user's overall
   * goal. It is removed before the SDK validates the arguments and before the
   * tool handler runs, and recorded on the span as `lmnr.mcp.context`. Tools
   * that already declare their own `context` argument are left alone.
   * Always off when `recordPayloads` is false. Defaults to true.
   */
  context?: boolean;
  /**
   * Record arguments, results, the `context` argument and resource URIs
   * (redacted). False records only names, counts and errors. Defaults to true.
   */
  recordPayloads?: boolean;
  /**
   * Extra key names whose values are replaced with `[REDACTED]` in recorded
   * payloads, on top of the built-in secret-key rules. Matched
   * case-insensitively, ignoring non-alphanumerics (`API-Key` = `apikey`).
   */
  redactKeys?: string[];
  /**
   * Requests of one MCP session less than this many milliseconds apart (or
   * overlapping) are grouped into one trace, one trace per user turn.
   * Defaults to 20000; values above 25000 are clamped to 25000.
   */
  turnGapMs?: number;
}

interface ResolvedOptions {
  context: boolean;
  recordPayloads: boolean;
  extraKeys: ReadonlySet<string>;
  turnGapMs: number;
}

/** Exported for tests. */
export const resolveMcpOptions = (
  options: WrapMcpServerOptions = {},
): ResolvedOptions => {
  const recordPayloads = options.recordPayloads !== false;
  let turnGapMs = DEFAULT_TURN_GAP_MS;
  if (options.turnGapMs !== undefined) {
    if (
      typeof options.turnGapMs !== "number" ||
      !Number.isFinite(options.turnGapMs) ||
      options.turnGapMs < 0
    ) {
      logger.warn(
        `Laminar MCP: invalid turnGapMs ${String(options.turnGapMs)}, ` +
          `using ${DEFAULT_TURN_GAP_MS}`,
      );
    } else if (options.turnGapMs > MAX_TURN_GAP_MS) {
      logger.warn(
        `Laminar MCP: turnGapMs ${options.turnGapMs} is above the maximum ` +
          `of ${MAX_TURN_GAP_MS} (it must stay under the 30 s Signals settle ` +
          `window), using ${MAX_TURN_GAP_MS}`,
      );
      turnGapMs = MAX_TURN_GAP_MS;
    } else {
      turnGapMs = options.turnGapMs;
    }
  }
  return {
    context: recordPayloads && options.context !== false,
    recordPayloads,
    extraKeys: buildExtraKeys(options.redactKeys),
    turnGapMs,
  };
};

type Handler = (request: any, extra: any) => unknown;

// The request-handler table of a low-level `Server` (1.x) / `Protocol` (2.x).
interface ProtocolLike {
  _requestHandlers: Map<string, Handler>;
  transport?: unknown;
  getClientVersion?: () => unknown;
  _negotiatedProtocolVersion?: unknown;
}

interface ServerState {
  protocol: ProtocolLike;
  mcpServer?: any;
  options: ResolvedOptions;
  /** From this server's `initialize` result. */
  protocolVersion?: string;
  /** Whether a tool listed by this server declares its own `context`. */
  listedOwnContext: Map<string, boolean>;
}

/** Per traced request, readable from the handler's context. */
interface RequestRecord {
  handlerError?: { error: unknown };
}

const WRAPPED = Symbol.for("lmnr.mcp.wrapped");
const WRAPPED_HANDLER = Symbol.for("lmnr.mcp.wrapped_handler");
const REQUEST_RECORD_KEY = createContextKey("lmnr.mcp.request");

const TRACED_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

const MAX_SESSIONS = 10_000;

// Module-level so they work across the per-session (or per-request) server
// instances that Streamable HTTP servers usually create.
const turnTracker = new TurnTracker();
const clientInfoBySession = new Map<
  string,
  { name?: string; version?: string }
>();
const protocolVersionBySession = new Map<string, string>();
// Tool name -> declares its own `context`, from every `tools/list` served in
// this process. Fallback for low-level servers (no tool registry to inspect).
const listedOwnContextGlobal = new Map<string, boolean>();
const warnedOwnContextTools = new Set<string>();
let warnedForcing = false;

/** Exported for tests. */
export const resetMcpState = () => {
  turnTracker.clear();
  clientInfoBySession.clear();
  protocolVersionBySession.clear();
  listedOwnContextGlobal.clear();
  warnedOwnContextTools.clear();
  warnedForcing = false;
};

const boundedSet = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
};

const isPlainObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Not `Object.hasOwn`: the repo's tsconfig lib predates es2022.
const hasOwn = (value: object, key: string): boolean =>
  Object.getOwnPropertyDescriptor(value, key) !== undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const serialize = (value: unknown, kind: "input" | "output") => {
  const json = toJson(value);
  return json === undefined ? undefined : truncateSpanPayload(json, kind);
};

const getHeader = (extra: any, name: string): string | undefined => {
  try {
    const fromWeb = extra?.http?.req?.headers;
    if (fromWeb && typeof fromWeb.get === "function") {
      return nonEmptyString(fromWeb.get(name));
    }
    const fromInfo = extra?.requestInfo?.headers;
    if (isPlainObject(fromInfo)) {
      const value = fromInfo[name];
      return nonEmptyString(Array.isArray(value) ? value[0] : value);
    }
  } catch {
    // Missing headers just mean no attribute.
  }
  return undefined;
};

const getSessionId = (
  extra: any,
  meta: Record<string, any>,
): string | undefined =>
  nonEmptyString(extra?.sessionId) ??
  getHeader(extra, "mcp-session-id") ??
  nonEmptyString(meta[OPENAI_SESSION_META_KEY]);

const transportAttributes = (state: ServerState, extra: any): Attributes => {
  if (extra?.requestInfo || extra?.http?.req) {
    return { [NETWORK_TRANSPORT]: "tcp", [NETWORK_PROTOCOL_NAME]: "http" };
  }
  const name = (state.protocol.transport as any)?.constructor?.name;
  if (typeof name === "string") {
    if (name.includes("Stdio")) {
      return { [NETWORK_TRANSPORT]: "pipe" };
    }
    if (name.includes("HTTP") || name.includes("SSE")) {
      return { [NETWORK_TRANSPORT]: "tcp", [NETWORK_PROTOCOL_NAME]: "http" };
    }
  }
  return {};
};

const getProtocolVersion = (
  state: ServerState,
  extra: any,
  sessionId: string | undefined,
): string | undefined =>
  getHeader(extra, "mcp-protocol-version") ??
  (sessionId ? protocolVersionBySession.get(sessionId) : undefined) ??
  state.protocolVersion ??
  nonEmptyString(state.protocol._negotiatedProtocolVersion) ??
  nonEmptyString(extra?.mcpReq?.envelope?.[PROTOCOL_VERSION_META_KEY]);

const getClientInfo = (
  state: ServerState,
  extra: any,
  sessionId: string | undefined,
): { name?: string; version?: string } | undefined => {
  const fromSession = sessionId
    ? clientInfoBySession.get(sessionId)
    : undefined;
  if (fromSession) {
    return fromSession;
  }
  let info: unknown;
  try {
    info = state.protocol.getClientVersion?.();
  } catch {
    info = undefined;
  }
  info ??= extra?.mcpReq?.envelope?.[CLIENT_INFO_META_KEY];
  return isPlainObject(info)
    ? { name: nonEmptyString(info.name), version: nonEmptyString(info.version) }
    : undefined;
};

const normalizeContext = (value: unknown): string | undefined => {
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
  if (warnedOwnContextTools.has(toolName)) {
    return;
  }
  warnedOwnContextTools.add(toolName);
  logger.warn(
    `Laminar MCP: tool "${toolName}" already declares a "context" argument, ` +
      `so Laminar does not add its own "context" field to it.`,
  );
};

/**
 * Whether the tool declares its own `context` argument (then it is left
 * alone). McpServer: from the registered tool's schema (2.x has a JSON Schema
 * accessor; 1.x and 2.x Zod object schemas expose `shape`). Otherwise, from
 * the `tools/list` responses served in this process; unknown means no.
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

const injectContext = (state: ServerState, result: any): any => {
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

const firstText = (result: any): string | undefined => {
  if (!Array.isArray(result?.content)) {
    return undefined;
  }
  for (const block of result.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
};

// SDK-made `isError` results for invalid params: 1.x folds every McpError into
// "MCP error -32602: ..." text, 2.x folds argument validation into "Input
// validation error: ...". Unknown / disabled tools read "Tool x not found".
const isInvalidParamsText = (text: string | undefined): boolean =>
  text !== undefined &&
  (text.includes("-32602") ||
    /Input validation error/i.test(text) ||
    /Invalid arguments for tool/.test(text) ||
    /^Tool \S+ (not found|disabled)/.test(text));

const errorClassName = (error: unknown): string => {
  if (error === null || typeof error !== "object") {
    return "_OTHER";
  }
  const ctorName = (error as any).constructor?.name;
  if (typeof ctorName === "string" && ctorName && ctorName !== "Object") {
    return ctorName;
  }
  return nonEmptyString((error as any).name) ?? "Error";
};

const errorCode = (error: unknown): number | undefined => {
  const code = (error as any)?.code;
  return Number.isSafeInteger(code) ? code : undefined;
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof (error as any)?.message === "string") {
    return (error as any).message;
  }
  return String(error);
};

interface Prepared {
  span: Span;
  spanContext: Context;
  record: RequestRecord;
  forwarded: any;
  method: string;
  sessionId?: string;
  trackTurn: boolean;
}

const markError = (
  prepared: Prepared,
  options: ResolvedOptions,
  errorType: string,
  message: string | undefined,
  fallbackMessage: string,
  rpcCode?: string,
  stack?: string,
) => {
  const { span } = prepared;
  const text =
    options.recordPayloads && message !== undefined ? message : fallbackMessage;
  span.setAttribute(ERROR_TYPE, errorType);
  if (rpcCode !== undefined) {
    span.setAttribute(RPC_RESPONSE_STATUS_CODE, rpcCode);
  }
  span.addEvent("exception", {
    "exception.type": errorType,
    "exception.message": text,
    ...(options.recordPayloads && stack
      ? { "exception.stacktrace": stack }
      : {}),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: text });
};

const endSpan = (prepared: Prepared) => {
  try {
    prepared.span.end();
  } finally {
    if (prepared.trackTurn && prepared.sessionId) {
      turnTracker.end(prepared.sessionId);
    }
  }
};

const finishResult = (state: ServerState, prepared: Prepared, result: any) => {
  try {
    const { options } = state;
    const { span, method } = prepared;
    if (method === "tools/call") {
      if (options.recordPayloads) {
        const json = serialize(redact(result, options.extraKeys), "output");
        if (json !== undefined) {
          span.setAttribute(GEN_AI_TOOL_CALL_RESULT, json);
        }
      }
      if (isPlainObject(result) && result.isError === true) {
        const thrown = prepared.record.handlerError;
        if (thrown) {
          const code = errorCode(thrown.error);
          markError(
            prepared,
            options,
            code !== undefined ? String(code) : errorClassName(thrown.error),
            errorText(thrown.error),
            "Tool raised an error",
            undefined,
            (thrown.error as any)?.stack,
          );
        } else {
          const text = firstText(result);
          markError(
            prepared,
            options,
            isInvalidParamsText(text) ? INVALID_PARAMS : TOOL_ERROR,
            text,
            "Tool returned an error",
          );
        }
      }
    } else if (options.recordPayloads) {
      const json = serialize(redact(result, options.extraKeys), "output");
      if (json !== undefined) {
        span.setAttribute(SPAN_OUTPUT, json);
      }
    }
  } catch (e) {
    logger.debug(`Laminar MCP: failed to record the result: ${String(e)}`);
  } finally {
    endSpan(prepared);
  }
};

const finishError = (
  state: ServerState,
  prepared: Prepared,
  error: unknown,
) => {
  try {
    const code = errorCode(error);
    // What the SDK answers with: the error's own code, else Internal error.
    const rpcCode = String(code ?? INTERNAL_ERROR);
    markError(
      prepared,
      state.options,
      code !== undefined ? String(code) : errorClassName(error),
      errorText(error),
      "Request failed",
      rpcCode,
      (error as any)?.stack,
    );
  } catch (e) {
    logger.debug(`Laminar MCP: failed to record the error: ${String(e)}`);
  } finally {
    endSpan(prepared);
  }
};

const prepare = (
  state: ServerState,
  method: string,
  request: any,
  extra: any,
): Prepared => {
  const { options } = state;
  const params: Record<string, any> = isPlainObject(request?.params)
    ? request.params
    : {};
  const meta: Record<string, any> = isPlainObject(params._meta)
    ? params._meta
    : isPlainObject(extra?._meta)
      ? extra._meta
      : isPlainObject(extra?.mcpReq?._meta)
        ? extra.mcpReq._meta
        : {};
  const sessionId = getSessionId(extra, meta);
  const name = nonEmptyString(params.name);
  const aiInvocation = isPlainObject(meta[AI_INVOCATION_META_KEY])
    ? meta[AI_INVOCATION_META_KEY]
    : undefined;

  const attributes: Attributes = {
    [MCP_METHOD_NAME]: method,
    [SPAN_TYPE]: method === "tools/call" ? "TOOL" : "DEFAULT",
    ...transportAttributes(state, extra),
  };
  let spanName = method;
  let forwarded = request;
  let contextValue: unknown;

  if (method === "tools/call") {
    attributes[GEN_AI_OPERATION_NAME] = "execute_tool";
    if (name) {
      attributes[GEN_AI_TOOL_NAME] = name;
      spanName = `${method} ${name}`;
    }
    const args = params.arguments;
    if (
      options.context &&
      name &&
      isPlainObject(args) &&
      hasOwn(args, "context") &&
      !toolDeclaresContext(state, name)
    ) {
      contextValue = args.context;
      const { context: _injected, ...rest } = args;
      // A copy: the transport may share the message object with the sender.
      forwarded = { ...request, params: { ...params, arguments: rest } };
    }
    if (options.recordPayloads && args !== undefined) {
      // As the client sent them, `context` included.
      const json = serialize(redact(args, options.extraKeys), "input");
      if (json !== undefined) {
        attributes[GEN_AI_TOOL_CALL_ARGUMENTS] = json;
      }
    }
  } else {
    if (method === "prompts/get" && name) {
      attributes[GEN_AI_PROMPT_NAME] = name;
      spanName = `${method} ${name}`;
    }
    if (options.recordPayloads) {
      const uri = nonEmptyString(params.uri);
      if (method === "resources/read" && uri) {
        attributes[MCP_RESOURCE_URI] = uri;
      }
      const { _meta: _ignored, ...input } = params;
      const json = serialize(redact(input, options.extraKeys), "input");
      if (json !== undefined) {
        attributes[SPAN_INPUT] = json;
      }
    }
  }

  if (options.recordPayloads) {
    const recordedContext =
      normalizeContext(contextValue) ??
      normalizeContext(aiInvocation?.userIntent);
    if (recordedContext !== undefined) {
      attributes[LMNR_MCP_CONTEXT] = recordedContext;
    }
  }

  const requestId = request?.id ?? extra?.requestId ?? extra?.mcpReq?.id;
  if (typeof requestId === "string" || typeof requestId === "number") {
    attributes[JSONRPC_REQUEST_ID] = String(requestId);
  }
  if (sessionId) {
    attributes[MCP_SESSION_ID] = sessionId;
    attributes[SESSION_ID] = sessionId;
  }
  const protocolVersion = getProtocolVersion(state, extra, sessionId);
  if (protocolVersion) {
    attributes[MCP_PROTOCOL_VERSION] = protocolVersion;
  }
  const clientInfo = getClientInfo(state, extra, sessionId);
  if (clientInfo?.name) {
    attributes[LMNR_MCP_CLIENT_NAME] = clientInfo.name;
  }
  if (clientInfo?.version) {
    attributes[LMNR_MCP_CLIENT_VERSION] = clientInfo.version;
  }

  // Trace id: client turn id > session turn tracker > client traceparent >
  // random. The span always stays a root; a traceparent is always a link.
  // The tracker beats the traceparent because clients with their own tracing
  // send a fresh trace id per call (one trace per call) or one for a whole
  // session (many turns in one trace); the gap tracker is never that wrong.
  const remoteParent = parseTraceparent(meta[TRACEPARENT_META_KEY]);
  const links: Link[] = remoteParent
    ? [
        {
          context: {
            traceId: remoteParent.traceId,
            spanId: remoteParent.spanId,
            traceFlags: remoteParent.traceFlags,
            isRemote: true,
          },
        },
      ]
    : [];
  const turnId = nonEmptyString(aiInvocation?.turnId);
  let forcedTraceId: string | undefined;
  let trackTurn = false;
  if (turnId) {
    forcedTraceId = traceIdForTurn(sessionId, turnId);
  } else if (sessionId) {
    forcedTraceId = turnTracker.begin(sessionId, options.turnGapMs);
    trackTurn = true;
  } else if (remoteParent) {
    forcedTraceId = remoteParent.traceId;
  }

  try {
    const record: RequestRecord = {};
    let baseContext: Context = ROOT_CONTEXT.setValue(
      REQUEST_RECORD_KEY,
      record,
    );
    if (sessionId) {
      baseContext = LaminarContextManager.setRawAssociationProperties(
        { sessionId },
        baseContext,
      );
    }
    const tracer = getTracer();
    if (forcedTraceId && !enableForcedTraceIds(tracer) && !warnedForcing) {
      warnedForcing = true;
      logger.debug(
        "Laminar MCP: the tracer does not support forced trace ids, " +
          "so requests of one turn get separate traces",
      );
    }
    const span = contextApi.with(baseContext, () =>
      withForcedTraceId(forcedTraceId, () =>
        tracer.startSpan(
          spanName,
          { kind: SpanKind.SERVER, root: true, attributes, links },
          baseContext,
        ),
      ),
    );
    // New turn: remember the id the span got (a no-op span, e.g. Laminar not
    // initialized, has an invalid one and starts no turn).
    const startedTraceId = span.spanContext().traceId;
    if (
      trackTurn &&
      sessionId &&
      forcedTraceId === undefined &&
      isValidTraceId(startedTraceId)
    ) {
      turnTracker.start(sessionId, startedTraceId);
    }
    return {
      span,
      spanContext: trace.setSpan(baseContext, span),
      record,
      forwarded,
      method,
      sessionId,
      trackTurn,
    };
  } catch (error) {
    if (trackTurn && sessionId && forcedTraceId !== undefined) {
      turnTracker.end(sessionId);
    }
    throw error;
  }
};

const traceRequest = (
  state: ServerState,
  method: string,
  handler: Handler,
  request: any,
  extra: any,
): unknown => {
  let prepared: Prepared | undefined;
  try {
    prepared = prepare(state, method, request, extra);
  } catch (e) {
    logger.debug(`Laminar MCP: failed to start the span: ${String(e)}`);
  }
  if (!prepared) {
    return handler(request, extra);
  }
  const active = prepared;
  let outcome: unknown;
  try {
    outcome = LaminarContextManager.runWithIsolatedContext(
      [active.spanContext],
      () =>
        contextApi.with(active.spanContext, () =>
          handler(active.forwarded, extra),
        ),
    );
  } catch (error) {
    finishError(state, active, error);
    throw error;
  }
  return Promise.resolve(outcome).then(
    (result) => {
      finishResult(state, active, result);
      return result;
    },
    (error) => {
      finishError(state, active, error);
      throw error;
    },
  );
};

const observeInitialize = (
  state: ServerState,
  handler: Handler,
  request: any,
  extra: any,
): unknown => {
  let sessionId: string | undefined;
  try {
    sessionId = nonEmptyString(extra?.sessionId);
    const info = request?.params?.clientInfo;
    if (sessionId && isPlainObject(info)) {
      boundedSet(clientInfoBySession, sessionId, {
        name: nonEmptyString(info.name),
        version: nonEmptyString(info.version),
      });
    }
  } catch {
    // Observation only.
  }
  return Promise.resolve(handler(request, extra)).then((result: any) => {
    try {
      const version = nonEmptyString(result?.protocolVersion);
      if (version) {
        state.protocolVersion = version;
        if (sessionId) {
          boundedSet(protocolVersionBySession, sessionId, version);
        }
      }
    } catch {
      // Observation only.
    }
    return result;
  });
};

const wrapHandler = (
  state: ServerState,
  method: string,
  handler: Handler,
): Handler => {
  let wrapped: Handler | undefined;
  if (method === "initialize") {
    wrapped = (request, extra) =>
      observeInitialize(state, handler, request, extra);
  } else if (method === "tools/list") {
    wrapped = (request, extra) => {
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
  } else if (TRACED_METHODS.has(method)) {
    wrapped = (request, extra) =>
      traceRequest(state, method, handler, request, extra);
  }
  if (!wrapped) {
    return handler;
  }
  Object.defineProperty(wrapped, WRAPPED_HANDLER, { value: true });
  return wrapped;
};

const hookHandlerTable = (state: ServerState) => {
  const table = state.protocol._requestHandlers;
  const originalSet = table.set;
  const wrapEntry = (method: string, handler: Handler): Handler => {
    if (typeof handler !== "function" || (handler as any)[WRAPPED_HANDLER]) {
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

// McpServer turns an exception thrown by a tool handler into an `isError`
// result. Remember the exception so the span gets its class name.
const hookToolExecutor = (mcpServer: any) => {
  const original = mcpServer.executeToolHandler;
  if (typeof original !== "function" || original[WRAPPED_HANDLER]) {
    return;
  }
  const remember = (error: unknown) => {
    try {
      const record = (LaminarContextManager.getContext().getValue(
        REQUEST_RECORD_KEY,
      ) ?? contextApi.active().getValue(REQUEST_RECORD_KEY)) as
        | RequestRecord
        | undefined;
      if (record) {
        record.handlerError = { error };
      }
    } catch {
      // Observation only.
    }
  };
  const patched = (...args: unknown[]) => {
    let result: unknown;
    try {
      result = original.apply(mcpServer, args);
    } catch (error) {
      remember(error);
      throw error;
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then(undefined, (error) => {
        remember(error);
        throw error;
      });
    }
    return result;
  };
  Object.defineProperty(patched, WRAPPED_HANDLER, { value: true });
  mcpServer.executeToolHandler = patched;
};

const isProtocolLike = (value: unknown): value is ProtocolLike =>
  isPlainObjectLike(value) &&
  (value as any)._requestHandlers instanceof Map &&
  typeof (value as any).setRequestHandler === "function";

const isPlainObjectLike = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object";

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
      isPlainObjectLike(candidate) &&
      isProtocolLike(candidate.server) &&
      isPlainObjectLike(candidate._registeredTools);
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
    if (isMcpServer && !state.mcpServer) {
      state.mcpServer = candidate;
      hookToolExecutor(candidate);
    }
  } catch (e) {
    logger.warn(`Laminar MCP: failed to wrap the server: ${String(e)}`);
  }
  return server;
};
