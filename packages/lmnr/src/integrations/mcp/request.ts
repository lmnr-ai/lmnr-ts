import {
  AI_INVOCATION_META_KEY,
  CLIENT_INFO_META_KEY,
  OPENAI_SESSION_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "./attributes";
import { isPlainObject, nonEmptyString, type ServerState } from "./shared";

/** What a traced request carries, read off either SDK major. */
export interface McpRequest {
  method: string;
  params: Record<string, any>;
  meta: Record<string, any>;
  /** The tool or prompt name of a `tools/call` / `prompts/get`. */
  target?: string;
  requestId?: string;
  sessionId?: string;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  /** An HTTP request is visible (stdio and in-memory can't be told apart). */
  http: boolean;
  aiInvocation?: Record<string, any>;
}

// 1.x: `extra.requestInfo.headers` (plain object); 2.x: `ctx.http.req.headers`.
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

const getClientInfo = (
  state: ServerState,
  envelope: Record<string, any> | undefined,
): Record<string, any> | undefined => {
  let info: unknown;
  try {
    info = state.protocol.getClientVersion?.();
  } catch {
    info = undefined;
  }
  // 2026-07-28 requests have no `initialize`: the envelope carries it.
  info ??= envelope?.[CLIENT_INFO_META_KEY];
  return isPlainObject(info) ? info : undefined;
};

export const readRequest = (
  state: ServerState,
  method: string,
  request: any,
  extra: any,
): McpRequest => {
  // Both majors hand the handler the request with `id` and `params._meta`
  // (2.x lifts only its own envelope keys out of `_meta`).
  const params: Record<string, any> = isPlainObject(request?.params)
    ? request.params
    : {};
  const meta: Record<string, any> = isPlainObject(params._meta)
    ? params._meta
    : {};
  const envelope: Record<string, any> | undefined = isPlainObject(
    extra?.mcpReq?.envelope,
  )
    ? extra.mcpReq.envelope
    : undefined;
  const requestId = request?.id;
  const clientInfo = getClientInfo(state, envelope);
  return {
    method,
    params,
    meta,
    target:
      method === "tools/call" || method === "prompts/get"
        ? nonEmptyString(params.name)
        : undefined,
    requestId:
      typeof requestId === "string" || typeof requestId === "number"
        ? String(requestId)
        : undefined,
    // The transport's session, else the header (a stateless copy behind a
    // gateway that keeps sessions), else ChatGPT's session meta.
    sessionId:
      nonEmptyString(extra?.sessionId) ??
      getHeader(extra, "mcp-session-id") ??
      nonEmptyString(meta[OPENAI_SESSION_META_KEY]),
    protocolVersion:
      getHeader(extra, "mcp-protocol-version") ??
      state.protocolVersion ??
      nonEmptyString(envelope?.[PROTOCOL_VERSION_META_KEY]),
    clientName: nonEmptyString(clientInfo?.name),
    clientVersion: nonEmptyString(clientInfo?.version),
    http: Boolean(extra?.requestInfo || extra?.http?.req),
    aiInvocation: isPlainObject(meta[AI_INVOCATION_META_KEY])
      ? meta[AI_INVOCATION_META_KEY]
      : undefined,
  };
};
