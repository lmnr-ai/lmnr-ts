/**
 * Convert provider-native LLM messages and tools into lmnr-atif shapes.
 *
 * Instrumentations record `gen_ai.input.messages` / `gen_ai.output.messages`
 * / `gen_ai.tool.definitions` in each provider's own format. This module
 * turns them into `LmnrMessage`s (spec §3) and ATIF tool definitions, so the
 * builder can compare conversations across calls and write ATIF steps.
 *
 * Shapes understood, detected per message so mixed lists work:
 *
 * - OpenAI Chat Completions (also LiteLLM, Groq, OpenRouter, LangChain-OpenAI):
 *   `{role, content, tool_calls: [{id, function: {name, arguments}}]}`, role
 *   `tool` results; outputs as `choices` (`{message, finish_reason}`) or bare
 *   messages.
 * - Anthropic: content blocks (`text`, `image`, `tool_use`, `tool_result`,
 *   `thinking`); `tool_result` blocks are split out of the user message into
 *   `tool` messages. Outputs carry `stop_reason`.
 * - OpenAI Responses: items (`message`, `function_call`,
 *   `function_call_output`, `reasoning`), with `input_text` / `output_text`
 *   parts.
 * - Gemini (google-genai, snake_case or camelCase): `{role, parts}` with
 *   `text`, `thought`, `function_call`, `function_response`, `inline_data`,
 *   `file_data`. Gemini calls often have no id, so the k-th call without one
 *   in a conversation gets the id `<name>_<k>` (marked `synthetic_id`), and
 *   its response is matched by name in order.
 * - Vercel AI SDK (LanguageModel prompts, as the TypeScript SDK records them):
 *   `tool-call` parts (`toolCallId`, `toolName`, `input`), `role: "tool"`
 *   messages of `tool-result` parts (`output: {type, value}`, `error-*` types
 *   are failures), `reasoning` parts, and `file` parts with a `mediaType`.
 * - OpenTelemetry GenAI semantic conventions: `{role, parts}` with typed parts
 *   (`text`, `reasoning`, `tool_call`, `tool_call_response`, `blob`, `uri`,
 *   `file`), as LangChain.js records its own LLM spans.
 *
 * Anything else degrades to role + text. Nothing here throws on bad input.
 *
 * Line-comparable port of the Python SDK's `lmnr/sdk/trajectory/normalize.py`.
 * Keep the two in step: the shared golden suite pins the output.
 */

import {
  get,
  has,
  isDict,
  isNone,
  JsonObject,
  jsonLoads,
  or,
  pyJsonDumps,
  pyStr,
  setdefault,
  truthy,
} from "./py";
import { asDict, dicts } from "./reader";

export type Message = JsonObject;

/**
 * Stores media and returns the path to reference it by (relative to the
 * trajectory file), or null to fall back to a text placeholder.
 * Arguments: base64 data, MIME type.
 */
export type MediaSink = (data: string, mediaType: string) => string | null;

export const ATIF_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Request-shaping keys the model never sees (as in app-server's tool
// normalizer).
const TRANSPORT_KEYS = new Set([
  "cache_control",
  "strict",
  "providerOptions",
  "provider_options",
]);
const SCHEMA_KEYS = [
  "parameters",
  "input_schema",
  "inputSchema",
  "parameters_json_schema",
  "parametersJsonSchema",
];

const ROLE_ALIASES = new Map([
  ["model", "assistant"],
  ["human", "user"],
  ["ai", "assistant"],
  ["function", "tool"],
]);

// Blocks with nothing the model reads as text: redacted reasoning, AI SDK
// reasoning images, citations, and tool approval responses.
const SKIPPED_BLOCKS = new Set([
  "redacted_thinking",
  "reasoning-file",
  "source",
  "tool-approval-response",
]);

/** First present key, for snake_case / camelCase variants. */
const getAny = (obj: JsonObject, ...keys: string[]): any => {
  for (const key of keys) {
    if (has(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
};

/** `{k: v for k, v in obj.items() if k not in keys}`. */
const without = (obj: JsonObject, keys: Set<string>): JsonObject =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.has(k)));

export const textPart = (text: string): JsonObject => ({ type: "text", text });

/** A single text part becomes a plain string; no parts become "". */
export const simplifyContent = (parts: JsonObject[]): any => {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1 && get(parts[0], "type") === "text") {
    return or(get(parts[0], "text"), "");
  }
  return parts;
};

/** Text of a message content, with media as placeholders. */
export const contentText = (content: unknown): string => {
  if (isNone(content)) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  const texts: string[] = [];
  for (const part of dicts(content)) {
    if (get(part, "type") === "text") {
      texts.push(or(get(part, "text"), ""));
    } else {
      const path = get(asDict(get(part, "source")), "path");
      texts.push(`[${pyStr(get(part, "type"))}: ${pyStr(path)}]`);
    }
  }
  return texts.join("\n");
};

const mediaPart = (
  mediaTypeRaw: unknown,
  dataRaw: unknown,
  urlRaw: unknown,
  media: MediaSink | null,
): JsonObject => {
  let mediaType = typeof mediaTypeRaw === "string" ? mediaTypeRaw : "";
  let data = dataRaw;
  let url = urlRaw;
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const header = comma === -1 ? url : url.slice(0, comma);
    const payload = comma === -1 ? "" : url.slice(comma + 1);
    mediaType = header.slice(5).split(";")[0] || mediaType;
    data = payload;
    url = null;
  }
  const kind =
    mediaType.startsWith("image/") || !mediaType ? "image" : mediaType;
  if (ATIF_IMAGE_TYPES.has(mediaType)) {
    let path: string | null = null;
    if (typeof url === "string" && url) {
      path = url;
    } else if (typeof data === "string" && data && media !== null) {
      path = media(data, mediaType);
    }
    if (path) {
      return { type: "image", source: { media_type: mediaType, path } };
    }
  }
  if (typeof url === "string" && url && !mediaType) {
    return textPart(`[image: ${url}]`);
  }
  return textPart(
    kind !== "image" ? `[${kind}]` : `[image: ${mediaType || "unknown"}]`,
  );
};

/** Tool call arguments as ATIF wants them (an object), plus the raw string
 * when they weren't a JSON object. */
export const parseArguments = (value: unknown): [JsonObject, string | null] => {
  if (isDict(value)) {
    return [asDict(value), null];
  }
  if (isNone(value) || value === "") {
    return [{}, null];
  }
  if (typeof value === "string") {
    const parsed = jsonLoads(value);
    if (parsed === undefined) {
      return [{}, value];
    }
    if (isDict(parsed.value)) {
      return [asDict(parsed.value), null];
    }
    return [{}, value];
  }
  return [{}, pyJsonDumps(value)];
};

export const toolCall = (
  callId: unknown,
  name: unknown,
  args: unknown,
  syntheticId: boolean = false,
): JsonObject => {
  const [parsed, raw] = parseArguments(args);
  const result: JsonObject = {
    tool_call_id: truthy(callId) ? pyStr(callId) : "",
    function_name: truthy(name) ? pyStr(name) : "",
    arguments: parsed,
  };
  const lmnr: JsonObject = {};
  if (raw !== null) {
    lmnr.raw_arguments = raw;
  }
  if (syntheticId) {
    lmnr.synthetic_id = true;
  }
  if (truthy(lmnr)) {
    result.extra = { lmnr };
  }
  return result;
};

/** Content of a tool result: a string, or parts if it has media. */
const resultContent = (value: unknown, media: MediaSink | null): any => {
  if (isNone(value)) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return simplifyContent(parts(value, media, {}));
  }
  return pyJsonDumps(value);
};

type Sink = Record<string, any[]>;

/** `sink.setdefault(key, []).append(value)`. */
const sinkPush = (sink: Sink, key: string, value: unknown): void => {
  setdefault(sink, key, [] as unknown[]).push(value);
};

/** Content parts of a block list; tool calls, results and reasoning go to
 * `sink`. */
const parts = (
  blocks: unknown[],
  media: MediaSink | null,
  sink: Sink,
): JsonObject[] => {
  const result: JsonObject[] = [];
  for (const raw of blocks) {
    if (typeof raw === "string") {
      result.push(textPart(raw));
      continue;
    }
    if (!isDict(raw)) {
      continue;
    }
    const block = asDict(raw);
    const kind = get(block, "type");
    if (
      ["text", "input_text", "output_text"].includes(kind) ||
      (isNone(kind) && has(block, "text"))
    ) {
      if (get(block, "thought") === true) {
        sinkPush(sink, "reasoning", pyStr(or(get(block, "text"), "")));
      } else {
        result.push(textPart(pyStr(or(get(block, "text"), ""))));
      }
    } else if (kind === "thinking" || kind === "reasoning") {
      let text = or(get(block, "thinking"), get(block, "text"), "");
      if (!truthy(text) && Array.isArray(get(block, "summary"))) {
        text = dicts(block.summary)
          .map((s) => pyStr(or(get(s, "text"), "")))
          .join("\n");
      }
      if (truthy(text)) {
        sinkPush(sink, "reasoning", pyStr(text));
      }
    } else if (SKIPPED_BLOCKS.has(kind)) {
      continue;
    } else if (kind === "tool_use") {
      sinkPush(
        sink,
        "tool_calls",
        toolCall(get(block, "id"), get(block, "name"), get(block, "input")),
      );
    } else if (kind === "tool_result") {
      sinkPush(sink, "tool_results", {
        role: "tool",
        tool_call_id: pyStr(or(get(block, "tool_use_id"), "")),
        content: resultContent(get(block, "content"), media),
        ...(get(block, "is_error") === true ? { _is_error: true } : {}),
      });
    } else if (kind === "tool-call") {
      sinkPush(
        sink,
        "tool_calls",
        toolCall(
          get(block, "toolCallId"),
          get(block, "toolName"),
          get(block, "input"),
        ),
      );
    } else if (kind === "tool-result") {
      const [content, isError] = aiSdkToolOutput(block, media);
      sinkPush(sink, "tool_results", {
        role: "tool",
        tool_call_id: pyStr(or(get(block, "toolCallId"), "")),
        content,
        ...(isError ? { _is_error: true } : {}),
      });
    } else if (["image", "input_image", "image_url"].includes(kind)) {
      const source = asDict(get(block, "source"));
      const imageUrl = get(block, "image_url");
      const url = isDict(imageUrl) ? get(asDict(imageUrl), "url") : imageUrl;
      result.push(
        mediaPart(
          get(source, "media_type"),
          get(source, "data"),
          or(url, get(source, "url")),
          media,
        ),
      );
    } else if (kind === "file" && has(block, "mediaType")) {
      result.push(aiSdkFile(block, media));
    } else if (["document", "file", "input_file"].includes(kind)) {
      result.push(
        textPart(
          `[file: ${pyStr(or(get(block, "filename"), get(block, "file_id"), ""))}]`,
        ),
      );
    } else if (kind === "input_audio" || kind === "audio") {
      result.push(textPart("[audio]"));
    } else {
      result.push(textPart(pyJsonDumps(block)));
    }
  }
  return result;
};

/**
 * Content of an AI SDK `tool-result` part, and whether the tool failed.
 *
 * Prompt parts carry `output: {type, value}`; results a provider executed
 * itself (in a call's output) carry `result` and `isError` instead.
 */
const aiSdkToolOutput = (
  block: JsonObject,
  media: MediaSink | null,
): [any, boolean] => {
  const output = asDict(get(block, "output"));
  if (!truthy(output)) {
    return [
      resultContent(get(block, "result"), media),
      get(block, "isError") === true,
    ];
  }
  const kind = get(output, "type");
  if (kind === "execution-denied") {
    return [pyStr(or(get(output, "reason"), "")), false];
  }
  if (kind === "json" || kind === "error-json") {
    // A JSON value, not content parts; providers send it serialized.
    const value = pyJsonDumps(get(output, "value"));
    return [value, kind === "error-json"];
  }
  return [resultContent(get(output, "value"), media), kind === "error-text"];
};

/** An AI SDK `file` part. `data` is base64 or a URL string, or (v7)
 * `{type: "data", data}` / `{type: "url", url}`. */
const aiSdkFile = (block: JsonObject, media: MediaSink | null): JsonObject => {
  let data = get(block, "data");
  let url = null;
  if (isDict(data)) {
    const source = asDict(data);
    url = get(source, "type") === "url" ? get(source, "url") : null;
    data = get(source, "type") === "data" ? get(source, "data") : null;
  } else if (
    typeof data === "string" &&
    ["http://", "https://", "data:"].some((p) => data.startsWith(p))
  ) {
    url = data;
    data = null;
  }
  const mediaType = get(block, "mediaType");
  if (typeof mediaType === "string" && mediaType.startsWith("image/")) {
    return mediaPart(mediaType, data, url, media);
  }
  return textPart(`[file: ${pyStr(or(get(block, "filename"), ""))}]`);
};

/** Typed parts of the OpenTelemetry GenAI semantic conventions. */
const semconvParts = (
  partsRaw: unknown,
  media: MediaSink | null,
  sink: Sink,
): JsonObject[] => {
  const result: JsonObject[] = [];
  for (const part of dicts(partsRaw)) {
    const kind = get(part, "type");
    if (kind === "text") {
      result.push(textPart(pyStr(or(get(part, "content"), ""))));
    } else if (kind === "reasoning" || kind === "thinking") {
      if (truthy(get(part, "content"))) {
        sinkPush(sink, "reasoning", pyStr(part.content));
      }
    } else if (kind === "tool_call") {
      sinkPush(
        sink,
        "tool_calls",
        toolCall(get(part, "id"), get(part, "name"), get(part, "arguments")),
      );
    } else if (kind === "tool_call_response") {
      // The conventions name the payload `response`; the Cohere
      // instrumentations (both SDKs) write `result`.
      const response = has(part, "response")
        ? get(part, "response")
        : get(part, "result");
      sinkPush(sink, "tool_results", {
        role: "tool",
        tool_call_id: pyStr(or(get(part, "id"), "")),
        content: resultContent(response, media),
      });
    } else if (kind === "blob") {
      result.push(
        mediaPart(get(part, "mime_type"), get(part, "content"), null, media),
      );
    } else if (kind === "uri") {
      result.push(
        mediaPart(get(part, "mime_type"), null, get(part, "uri"), media),
      );
    } else if (kind === "file") {
      result.push(textPart(`[file: ${pyStr(or(get(part, "file_id"), ""))}]`));
    } else {
      result.push(textPart(pyJsonDumps(part)));
    }
  }
  return result;
};

const geminiParts = (
  partsRaw: unknown,
  media: MediaSink | null,
  sink: Sink,
): JsonObject[] => {
  const result: JsonObject[] = [];
  for (const part of dicts(partsRaw)) {
    const call = asDict(getAny(part, "function_call", "functionCall"));
    const response = asDict(
      getAny(part, "function_response", "functionResponse"),
    );
    const inline = asDict(getAny(part, "inline_data", "inlineData"));
    const fileData = asDict(getAny(part, "file_data", "fileData"));
    if (truthy(call)) {
      sinkPush(sink, "gemini_calls", call);
    } else if (truthy(response)) {
      sinkPush(sink, "gemini_responses", response);
    } else if (truthy(inline)) {
      result.push(
        mediaPart(
          getAny(inline, "mime_type", "mimeType"),
          get(inline, "data"),
          null,
          media,
        ),
      );
    } else if (truthy(fileData)) {
      result.push(
        mediaPart(
          getAny(fileData, "mime_type", "mimeType"),
          null,
          getAny(fileData, "file_uri", "fileUri"),
          media,
        ),
      );
    } else if (has(part, "text")) {
      if (get(part, "thought") === true) {
        sinkPush(sink, "reasoning", pyStr(or(get(part, "text"), "")));
      } else {
        result.push(textPart(pyStr(or(get(part, "text"), ""))));
      }
    }
  }
  return result;
};

/**
 * Normalizes the messages of one LLM call, input then output.
 *
 * Keeps the per-conversation state Gemini needs: generated ids for calls
 * without one, and the queue matching responses to them by name.
 */
class Conversation {
  messages: Message[] = [];
  private geminiCount = 0;
  private geminiPending = new Map<string, string[]>();

  constructor(readonly media: MediaSink | null) {}

  private geminiCall(call: JsonObject): JsonObject {
    const name = pyStr(or(get(call, "name"), ""));
    let callId = get(call, "id");
    const synthetic = !truthy(callId);
    if (synthetic) {
      this.geminiCount += 1;
      callId = `${name}_${this.geminiCount}`;
    }
    if (!this.geminiPending.has(name)) {
      this.geminiPending.set(name, []);
    }
    this.geminiPending.get(name)!.push(pyStr(callId));
    return toolCall(callId, name, get(call, "args"), synthetic);
  }

  private geminiResponse(response: JsonObject): Message {
    const name = pyStr(or(get(response, "name"), ""));
    let callId = get(response, "id");
    const pending = this.geminiPending.get(name) ?? [];
    if (truthy(callId) && pending.includes(pyStr(callId))) {
      pending.splice(pending.indexOf(pyStr(callId)), 1);
    } else if (!truthy(callId) && pending.length > 0) {
      callId = pending.shift();
    }
    let value: any = get(response, "response");
    const wrapper = asDict(value);
    if (
      truthy(wrapper) &&
      Object.keys(wrapper).every((k) => k === "output" || k === "result")
    ) {
      const inner = getAny(wrapper, "output", "result");
      value = !isNone(inner) ? inner : value;
    }
    return {
      role: "tool",
      tool_call_id: pyStr(or(callId, "")),
      content: resultContent(value, this.media),
    };
  }

  /** Merge into the trailing assistant message (Responses items split one
   * turn into several), or start a new one. */
  private appendAssistant(message: Message): void {
    const last =
      this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
    if (
      last !== null &&
      get(last, "role") === "assistant" &&
      !truthy(get(last, "_closed"))
    ) {
      if (truthy(get(message, "reasoning_content"))) {
        const joined = [
          get(last, "reasoning_content"),
          message.reasoning_content,
        ]
          .filter((t) => truthy(t))
          .join("\n");
        last.reasoning_content = joined;
      }
      if (!isNoneOrEmpty(get(message, "content"))) {
        if (isNoneOrEmpty(get(last, "content"))) {
          last.content = message.content;
        } else {
          last.content = simplifyContent([
            ...asParts(last.content),
            ...asParts(message.content),
          ]);
        }
      }
      if (truthy(get(message, "tool_calls"))) {
        setdefault<unknown[]>(last, "tool_calls", []).push(
          ...message.tool_calls,
        );
      }
      return;
    }
    this.messages.push(message);
  }

  closeAssistant(): void {
    const last = this.messages[this.messages.length - 1];
    if (last !== undefined && get(last, "role") === "assistant") {
      last._closed = true;
    }
  }

  /** Normalize one raw message / item and append the result. */
  add(raw: unknown, mergeAssistant: boolean = false): void {
    if (typeof raw === "string") {
      this.closeAssistant();
      this.messages.push({ role: "user", content: raw });
      return;
    }
    const item = asDict(raw);
    if (!truthy(item)) {
      return;
    }
    const kind = get(item, "type");

    // OpenAI Responses items.
    if (kind === "function_call") {
      this.appendAssistant({
        role: "assistant",
        content: "",
        tool_calls: [
          toolCall(
            or(get(item, "call_id"), get(item, "id")),
            get(item, "name"),
            get(item, "arguments"),
          ),
        ],
      });
      return;
    }
    if (kind === "function_call_output") {
      this.messages.push({
        role: "tool",
        tool_call_id: pyStr(or(get(item, "call_id"), "")),
        content: resultContent(get(item, "output"), this.media),
      });
      return;
    }
    if (kind === "reasoning") {
      const sink: Sink = {};
      parts([item], this.media, sink);
      const reasoning = (sink.reasoning ?? []).map((r) => pyStr(r)).join("\n");
      this.appendAssistant({
        role: "assistant",
        content: "",
        reasoning_content: reasoning,
      });
      return;
    }

    let role = get(item, "role");
    role = !isNone(role) ? (ROLE_ALIASES.get(pyStr(role)) ?? role) : null;
    if (isNone(role) && !(isNone(kind) || kind === "message")) {
      // Built-in tool calls (web_search_call, ...) and other items.
      return;
    }
    role = or(role, "user");

    const sink: Sink = {};
    let contentParts: JsonObject[];
    if (has(item, "parts")) {
      const partsRaw: unknown = or(get(item, "parts"), []);
      if (dicts(partsRaw).some((p) => has(p, "type"))) {
        contentParts = semconvParts(partsRaw, this.media, sink);
      } else {
        contentParts = geminiParts(partsRaw, this.media, sink);
      }
    } else {
      const content = get(item, "content");
      if (Array.isArray(content)) {
        contentParts = parts(content, this.media, sink);
      } else if (isNone(content)) {
        contentParts = [];
      } else {
        contentParts = [
          textPart(
            typeof content === "string"
              ? content
              : pyJsonDumps(content, { ensureAscii: true }),
          ),
        ];
      }
    }

    const toolCalls: JsonObject[] = [...(sink.tool_calls ?? [])];
    for (const call of dicts(get(item, "tool_calls"))) {
      const fn = asDict(get(call, "function"));
      toolCalls.push(
        toolCall(
          get(call, "id"),
          or(get(fn, "name"), get(call, "name")),
          has(fn, "arguments") ? get(fn, "arguments") : get(call, "arguments"),
        ),
      );
    }
    for (const call of sink.gemini_calls ?? []) {
      toolCalls.push(this.geminiCall(call));
    }
    const reasoning = [...(sink.reasoning ?? [])];
    const reasoningContent = get(item, "reasoning_content");
    if (typeof reasoningContent === "string" && reasoningContent) {
      reasoning.push(reasoningContent);
    }

    if (role === "tool") {
      this.closeAssistant();
      if (truthy(sink.tool_results) && contentParts.length === 0) {
        // AI SDK and semconv tool messages hold their results as parts.
        this.messages.push(...sink.tool_results);
        return;
      }
      const message: Message = {
        role: "tool",
        tool_call_id: pyStr(
          or(get(item, "tool_call_id"), get(item, "name"), ""),
        ),
        content: simplifyContent(contentParts),
      };
      this.messages.push(message);
      return;
    }

    const results: Message[] = [
      ...(sink.gemini_responses ?? []).map((r) => this.geminiResponse(r)),
      ...(sink.tool_results ?? []),
    ];
    if (role !== "assistant") {
      this.closeAssistant();
      // Tool results come first: they answer the previous assistant turn.
      this.messages.push(...results);
      if (contentParts.length > 0 || results.length === 0) {
        this.messages.push({ role, content: simplifyContent(contentParts) });
      }
      return;
    }

    const message: Message = {
      role: "assistant",
      content: simplifyContent(contentParts),
    };
    if (reasoning.length > 0) {
      message.reasoning_content = reasoning.join("\n");
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    if (mergeAssistant) {
      this.appendAssistant(message);
    } else {
      this.closeAssistant();
      this.messages.push(message);
    }
    this.messages.push(...results);
  }

  finish(): Message[] {
    for (const message of this.messages) {
      delete message._closed;
    }
    return this.messages;
  }
}

/** `value in (None, "")`. */
const isNoneOrEmpty = (value: unknown): boolean =>
  isNone(value) || value === "";

const asParts = (content: unknown): JsonObject[] => {
  if (typeof content === "string") {
    return content ? [textPart(content)] : [];
  }
  return dicts(content);
};

/**
 * Normalize one LLM call: `[input messages, output message, finish reason]`.
 *
 * The output is one assistant message (null when the call produced no output,
 * e.g. it failed). Input and output are normalized together because Gemini's
 * generated call ids continue from the input into the output.
 */
export const normalizeCall = (
  inputRawArg: unknown,
  outputRawArg: unknown,
  media: MediaSink | null = null,
): [Message[], Message | null, string | null] => {
  const conversation = new Conversation(media);
  let inputRaw = inputRawArg;
  if (typeof inputRaw === "string") {
    inputRaw = [{ role: "user", content: inputRaw }];
  }
  for (const raw of Array.isArray(inputRaw) ? inputRaw : []) {
    conversation.add(raw, !isNone(get(asDict(raw), "type")));
  }
  // Copies: the output is appended to the same conversation below. `finish`
  // drops the closed marks, so close again: an input that ends on an
  // assistant turn (an Anthropic prefill) must not absorb the output.
  const inputMessages = conversation.finish().map((m) => ({ ...m }));
  conversation.closeAssistant();
  const count = inputMessages.length;

  let finishReason: string | null = null;
  let outputRaw = outputRawArg;
  if (typeof outputRaw === "string") {
    outputRaw = [{ role: "assistant", content: outputRaw }];
  } else if (isDict(outputRaw)) {
    outputRaw = [outputRaw];
  }
  const outputItems: JsonObject[] = [];
  for (const raw of Array.isArray(outputRaw) ? outputRaw : []) {
    const item = asDict(raw);
    if (!truthy(item)) {
      continue;
    }
    // OpenAI choices and Gemini candidates wrap the message.
    if (
      has(item, "message") ||
      (has(item, "content") && isDict(get(item, "content")))
    ) {
      const reason = getAny(item, "finish_reason", "finishReason");
      finishReason = or(finishReason, truthy(reason) ? pyStr(reason) : null);
      const wrapped = asDict(or(get(item, "message"), get(item, "content")));
      outputItems.push({
        ...wrapped,
        role: or(get(wrapped, "role"), "assistant"),
      });
      if (has(item, "message")) {
        break; // first choice only
      }
      continue;
    }
    const reason = getAny(item, "stop_reason", "finish_reason");
    finishReason = or(finishReason, truthy(reason) ? pyStr(reason) : null);
    outputItems.push(
      truthy(get(item, "type")) || truthy(get(item, "role"))
        ? item
        : { ...item, role: "assistant" },
    );
  }
  for (const item of outputItems) {
    if (
      isNone(get(item, "type")) &&
      !isNone(get(item, "role")) &&
      !["assistant", "model"].includes(get(item, "role"))
    ) {
      continue;
    }
    conversation.add(
      isNone(get(item, "type")) ? { ...item, role: "assistant" } : item,
      true,
    );
  }
  const messages = conversation.finish();
  const produced = messages
    .slice(count)
    .filter((m) => get(m, "role") === "assistant");
  if (produced.length === 0) {
    return [inputMessages, null, finishReason];
  }
  const output: Message = { role: "assistant", content: "" };
  for (const message of produced) {
    if (!isNoneOrEmpty(get(message, "content"))) {
      output.content =
        output.content === ""
          ? message.content
          : simplifyContent([
              ...asParts(output.content),
              ...asParts(message.content),
            ]);
    }
    if (truthy(get(message, "reasoning_content"))) {
      output.reasoning_content = [
        get(output, "reasoning_content"),
        message.reasoning_content,
      ]
        .filter((t) => truthy(t))
        .join("\n");
    }
    if (truthy(get(message, "tool_calls"))) {
      setdefault<unknown[]>(output, "tool_calls", []).push(
        ...message.tool_calls,
      );
    }
  }
  return [inputMessages, output, finishReason];
};

/** Tool definitions in ATIF's OpenAI function shape, minus transport keys. */
export const normalizeTools = (raw: unknown): JsonObject[] => {
  const tools: JsonObject[] = [];
  for (const tool of dicts(raw)) {
    const fn = asDict(get(tool, "function"));
    if (truthy(fn)) {
      tools.push({ type: "function", function: without(fn, TRANSPORT_KEYS) });
      continue;
    }
    const declarations = getAny(
      tool,
      "function_declarations",
      "functionDeclarations",
    );
    if (Array.isArray(declarations)) {
      tools.push(...normalizeTools(declarations));
      continue;
    }
    const kind = get(tool, "type");
    const schemaKey = SCHEMA_KEYS.find((k) => has(tool, k));
    const schema = schemaKey !== undefined ? tool[schemaKey] : null;
    if (
      truthy(get(tool, "name")) &&
      (isNone(kind) ||
        kind === "function" ||
        kind === "custom" ||
        !isNone(schema))
    ) {
      const definition: JsonObject = { name: tool.name };
      if (truthy(get(tool, "description"))) {
        definition.description = tool.description;
      }
      if (!isNone(schema)) {
        definition.parameters = schema;
      }
      tools.push({ type: "function", function: definition });
      continue;
    }
    if (truthy(kind)) {
      tools.push(without(tool, TRANSPORT_KEYS));
    }
  }
  return tools;
};
