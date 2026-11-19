import {
  type Attributes,
  context as contextApi,
  type Link,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from "@opentelemetry/api";

import { getTracer } from "../../opentelemetry-lib/tracing";
import {
  SESSION_ID,
  SPAN_INPUT,
  SPAN_TYPE,
} from "../../opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "../../opentelemetry-lib/tracing/context";
import {
  enableForcedTraceIds,
  isValidTraceId,
  withForcedTraceId,
} from "../../opentelemetry-lib/tracing/id-generator";
import { initializeLogger } from "../../utils";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROMPT_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_NAME,
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
  TRACEPARENT_META_KEY,
} from "./attributes";
import { normalizeContext, splitContext } from "./context-field";
import { type ResolvedOptions } from "./options";
import {
  type ActiveSpan,
  finishError,
  finishResult,
  serialize,
} from "./outcome";
import { redact } from "./redact";
import { type McpRequest, readRequest } from "./request";
import {
  type Handler,
  nonEmptyString,
  type ServerState,
  turnTracker,
  warned,
} from "./shared";
import { parseTraceparent, type Turn, traceIdForTurn } from "./turns";

const logger = initializeLogger();

const startAttributes = (
  options: ResolvedOptions,
  req: McpRequest,
  contextValue: unknown,
): Attributes => {
  const { method, params } = req;
  const attributes: Attributes = {
    [MCP_METHOD_NAME]: method,
    [SPAN_TYPE]: method === "tools/call" ? "TOOL" : "DEFAULT",
  };
  if (method === "tools/call") {
    attributes[GEN_AI_OPERATION_NAME] = "execute_tool";
    if (req.target) {
      attributes[GEN_AI_TOOL_NAME] = req.target;
    }
  } else if (method === "prompts/get" && req.target) {
    attributes[GEN_AI_PROMPT_NAME] = req.target;
  }
  if (options.recordPayloads) {
    if (method === "tools/call") {
      // As the client sent them, `context` included.
      if (params.arguments !== undefined) {
        attributes[GEN_AI_TOOL_CALL_ARGUMENTS] = serialize(
          redact(params.arguments, options.extraKeys),
          "input",
        );
      }
    } else {
      if (method === "resources/read") {
        attributes[MCP_RESOURCE_URI] = nonEmptyString(params.uri);
      }
      const { _meta: _ignored, ...input } = params;
      attributes[SPAN_INPUT] = serialize(
        redact(input, options.extraKeys),
        "input",
      );
    }
    attributes[LMNR_MCP_CONTEXT] =
      normalizeContext(contextValue) ??
      normalizeContext(req.aiInvocation?.userIntent);
  }
  if (req.http) {
    attributes[NETWORK_TRANSPORT] = "tcp";
    attributes[NETWORK_PROTOCOL_NAME] = "http";
  }
  Object.assign(attributes, {
    [JSONRPC_REQUEST_ID]: req.requestId,
    [MCP_SESSION_ID]: req.sessionId,
    [SESSION_ID]: req.sessionId,
    [MCP_PROTOCOL_VERSION]: req.protocolVersion,
    [LMNR_MCP_CLIENT_NAME]: req.clientName,
    [LMNR_MCP_CLIENT_VERSION]: req.clientVersion,
  });
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      delete attributes[key];
    }
  }
  return attributes;
};

const startSpan = (
  options: ResolvedOptions,
  req: McpRequest,
  contextValue: unknown,
): ActiveSpan => {
  const { sessionId } = req;
  // Trace id: client turn id > session turn tracker > client traceparent >
  // random. A session's NEW turn starts with the traceparent's trace id when
  // there is one (later calls in the gap join it). The span always stays a
  // root; a traceparent is always a link. The tracker beats the traceparent
  // because clients with their own tracing send a fresh trace id per call
  // (one trace per call) or one for a whole session (many turns in one
  // trace); the gap tracker is never that wrong.
  const remoteParent = parseTraceparent(req.meta[TRACEPARENT_META_KEY]);
  const links: Link[] = remoteParent
    ? [{ context: { ...remoteParent, isRemote: true } }]
    : [];
  const turnId = nonEmptyString(req.aiInvocation?.turnId);
  let forcedTraceId: string | undefined;
  let turn: Turn | undefined;
  let newTurn = false;
  if (turnId) {
    forcedTraceId = traceIdForTurn(sessionId, turnId);
  } else if (sessionId) {
    turn = turnTracker.begin(sessionId, options.turnGapMs);
    newTurn = turn === undefined;
    forcedTraceId = turn?.traceId ?? remoteParent?.traceId;
  } else if (remoteParent) {
    forcedTraceId = remoteParent.traceId;
  }

  try {
    const baseContext = sessionId
      ? LaminarContextManager.setRawAssociationProperties(
          { sessionId },
          ROOT_CONTEXT,
        )
      : ROOT_CONTEXT;
    const tracer = getTracer();
    if (forcedTraceId && !enableForcedTraceIds(tracer) && !warned.forcing) {
      warned.forcing = true;
      logger.debug(
        "Laminar MCP: the tracer does not support forced trace ids, " +
          "so requests of one turn get separate traces",
      );
    }
    const name = req.target ? `${req.method} ${req.target}` : req.method;
    const span = contextApi.with(baseContext, () =>
      withForcedTraceId(forcedTraceId, () =>
        tracer.startSpan(
          name,
          {
            kind: SpanKind.SERVER,
            root: true,
            attributes: startAttributes(options, req, contextValue),
            links,
          },
          baseContext,
        ),
      ),
    );
    // New turn: remember the id the span got, which is the traceparent's when
    // forcing worked (a no-op span, e.g. Laminar not initialized, has an
    // invalid one and starts no turn).
    const startedTraceId = span.spanContext().traceId;
    if (sessionId && newTurn && isValidTraceId(startedTraceId)) {
      turn = turnTracker.start(sessionId, startedTraceId);
    }
    return {
      span,
      spanContext: trace.setSpan(baseContext, span),
      method: req.method,
      turn,
    };
  } catch (error) {
    // `begin` or `start` already marked the call in flight.
    if (turn) {
      turnTracker.end(turn);
    }
    throw error;
  }
};

export const traceRequest = (
  state: ServerState,
  method: string,
  handler: Handler,
  request: any,
  extra: any,
): unknown => {
  const { options } = state;
  let active: ActiveSpan | undefined;
  let forwarded = request;
  try {
    const req = readRequest(state, method, request, extra);
    const split = splitContext(state, req, request);
    forwarded = split.forwarded;
    active = startSpan(options, req, split.context);
  } catch (e) {
    logger.debug(`Laminar MCP: failed to start the span: ${String(e)}`);
  }
  if (!active) {
    return handler(forwarded, extra);
  }
  const { spanContext } = active;
  let outcome: unknown;
  try {
    outcome = LaminarContextManager.runWithIsolatedContext([spanContext], () =>
      contextApi.with(spanContext, () => handler(forwarded, extra)),
    );
  } catch (error) {
    finishError(options, active, error);
    throw error;
  }
  return Promise.resolve(outcome).then(
    (result) => {
      finishResult(options, active, result);
      return result;
    },
    (error) => {
      finishError(options, active, error);
      throw error;
    },
  );
};
