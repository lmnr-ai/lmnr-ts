/**
 * Narrow structural mirrors of the `@earendil-works/pi-durable`,
 * `pi-telemetry`, `chord` and `pi-ai` types this integration touches. The
 * packages are optional peers, so nothing here is imported at runtime.
 */

export type PiAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type PiSpanAttributes = Record<string, PiAttributeValue | undefined>;

export type PiTelemetryCarrier = Record<string, string>;

export interface PiTelemetryPropagation {
  inject(context: PiTelemetryContext): PiTelemetryCarrier | undefined;
  extract(carrier: PiTelemetryCarrier | undefined): PiTelemetryContext;
}

export interface PiSpanOptions {
  name: string;
  attributes?: PiSpanAttributes;
  links?: readonly { context: PiTelemetryContext }[];
}

export type PiSpanStatus =
  | { status: "ok" }
  | { status: "error"; error?: { name: string; message: string } };

/** `TelemetryContext` from `@earendil-works/pi-telemetry`. */
export interface PiTelemetryContext {
  readonly metrics?: unknown;
  readonly propagation?: PiTelemetryPropagation;
  startSpan<T>(
    options: PiSpanOptions,
    callback: (span: PiTelemetrySpan) => T | Promise<T>,
  ): Promise<T>;
}

/** `TelemetrySpan` from `@earendil-works/pi-telemetry`. */
export interface PiTelemetrySpan extends PiTelemetryContext {
  addLink(link: { context: PiTelemetryContext }): void;
  addEvent(name: string, attributes?: PiSpanAttributes): void;
  setAttributes(attributes: PiSpanAttributes): void;
  setStatus(status: PiSpanStatus): void;
}

/** Chord's `Context`, as hooks receive it. */
export interface PiContext {
  readonly telemetry: PiTelemetrySpan;
}

/** A `defineDoc()` token, enough for `api.snapshot()`. */
export interface PiDocToken {
  readonly definition: {
    readonly kind: string;
    readonly version: number;
    readonly scope: string;
    readonly history: string;
    readonly fork: string;
  };
}

/** `HookApi` from pi-durable, reduced to what the hooks read. */
export interface PiHookApi {
  readonly taskId: number;
  readonly conversationId: number;
  snapshot(
    token: PiDocToken,
    conversationId: number,
    context: PiContext,
  ): Promise<unknown>;
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface PiSystemMessage {
  role: "system";
  content: string | PiTextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: PiTool[];
  toolsRemoved?: { name: string }[];
}

export interface PiUserMessage {
  role: "user";
  content: string | (PiTextContent | PiImageContent)[];
}

export interface PiAssistantMessage {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCall)[];
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  isError: boolean;
}

export type PiMessage =
  | PiSystemMessage
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage;

/** `ToolHookCall` from pi-durable. */
export interface PiToolHookCall extends PiToolCall {
  readonly parent?: { readonly taskId: number; readonly callId: string };
}

/** `ToolExecutionResult` from pi-durable, reduced to what the hooks read. */
export interface PiToolExecutionResult {
  output?: (PiTextContent | PiImageContent)[];
  isError?: boolean;
  structuredOutput?: unknown;
  diagnostics?: { severity?: string; code?: string; message?: string }[];
}

/** The `hook(task, handlers)` value pi-durable's registry reads. */
export interface PiHook {
  readonly task: string;
  readonly handlers: Record<string, (...args: any[]) => unknown>;
}

/** `defineExtension()` value: a named bundle of hooks. */
export interface PiExtension {
  readonly name: string;
  readonly hooks: readonly PiHook[];
}
