/** Types for Anthropic instrumentation span attributes and event models. */

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: unknown | null;
  service_tier?: string | null;
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: string | Record<string, unknown>;
  thinking?: string;
  citations?: unknown;
}

export interface InputMessage {
  role: string;
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "image"; source: Record<string, unknown>; [key: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; [key: string]: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; [key: string]: unknown }
  | Record<string, unknown>;

export interface OutputMessage {
  role: string;
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
}

export interface StreamingEvent {
  index?: number;
  text: string;
  type: string;
  id?: string;
  name?: string;
  input?: string;
  finish_reason?: string | null;
}

export interface CompleteStreamingResponse {
  events: StreamingEvent[];
  model: string;
  usage: Partial<AnthropicUsage>;
  id: string;
  service_tier: string | null;
}
