// Span attributes of the MCP server span. The keys and the `error.type` values
// are a contract shared with the Python SDK and app-server (the MCP dashboard
// queries them), so change them together.

// OTel MCP / GenAI / RPC semantic conventions.
export const MCP_METHOD_NAME = "mcp.method.name";
export const MCP_SESSION_ID = "mcp.session.id";
export const MCP_PROTOCOL_VERSION = "mcp.protocol.version";
export const MCP_RESOURCE_URI = "mcp.resource.uri";
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_PROMPT_NAME = "gen_ai.prompt.name";
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
export const JSONRPC_REQUEST_ID = "jsonrpc.request.id";
export const NETWORK_TRANSPORT = "network.transport";
export const NETWORK_PROTOCOL_NAME = "network.protocol.name";
export const ERROR_TYPE = "error.type";
export const RPC_RESPONSE_STATUS_CODE = "rpc.response.status_code";

// Laminar-only, where the spec has nothing.
export const LMNR_MCP_CLIENT_NAME = "lmnr.mcp.client.name";
export const LMNR_MCP_CLIENT_VERSION = "lmnr.mcp.client.version";
export const LMNR_MCP_CONTEXT = "lmnr.mcp.context";

// `error.type` values.
export const TOOL_ERROR = "tool_error";
export const INVALID_PARAMS = "-32602";
export const INTERNAL_ERROR = "-32603";

// `params._meta` keys.
export const AI_INVOCATION_META_KEY = "io.modelcontextprotocol/aiInvocation";
export const OPENAI_SESSION_META_KEY = "openai/session";
export const TRACEPARENT_META_KEY = "traceparent";
// 2026-era per-request envelope keys (`@modelcontextprotocol/server` 2.x).
export const PROTOCOL_VERSION_META_KEY =
  "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/** Verbatim in every SDK. */
export const CONTEXT_DESCRIPTION =
  "Optional. One sentence on what the user is trying to accomplish overall " +
  "(their goal, not this call's arguments). Shared with this server's " +
  "developer to improve the server; it does not change the result.";

export const CONTEXT_MAX_LENGTH = 1000;
