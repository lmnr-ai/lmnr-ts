/**
 * AI SDK prompt → `input_chat_messages_from_json` reshape (debug-replay v2).
 *
 * The server hashes the RECONSTRUCTED message array it stores for an AI SDK
 * span, not the raw `options.prompt`. That reconstruction is:
 *
 *   ai.prompt.messages = stringifyPromptForTelemetry(options.prompt)   // a JSON string
 *   reconstructed      = input_chat_messages_from_json(parse(ai.prompt.messages))
 *   input_hash         = hex(blake3(canonical_json(reconstructed_without_system)))
 *
 * For the SDK's `input_hash` to match the server's, we apply the SAME reshape to
 * `options.prompt` before hashing. This is a faithful port of the app-server
 * primitives (keep byte-comparable):
 *   - `input_chat_messages_from_json`      — `app-server/src/traces/spans.rs`
 *   - `ChatMessageContentPart::from_instrumentation_content_part`
 *                                          — `app-server/src/language_model/chat_message.rs`
 *   - `json_value_to_string` / `is_url` / `infer_image_type`
 *                                          — `app-server/src/utils/mod.rs`
 *
 * Parity hazard: the server's serde uses `preserve_order`, so the Text-fallback
 * (`json_value_to_string`) emits keys in insertion order — `JSON.stringify` over a
 * `JSON.parse`d value matches that. Object-keyed parts are re-sorted later by
 * `canonicalJson`, so only key NAMES and presence (serde `skip_serializing_if`)
 * matter here, never key order.
 *
 * TS-only: Python providers already send the stored shape, so there is no
 * `aisdk-normalize.py` counterpart.
 */

import { type LanguageModelV3Prompt } from "@ai-sdk/provider";
import { type LanguageModelV2Prompt } from "@ai-sdk/provider-v2";

import { stringifyPromptForTelemetry } from "../opentelemetry-lib/instrumentation/aisdk/utils";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Mirror Rust `is_url`. */
const isUrl = (data: string): boolean =>
  data.startsWith("http://") ||
  data.startsWith("https://") ||
  data.startsWith("data:");

/** Mirror Rust `infer_image_type`. */
const inferImageType = (base64: string): string => {
  if (base64.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (base64.startsWith("iVBORw0KGgo")) {
    return "image/png";
  }
  if (base64.startsWith("R0lGODlh")) {
    return "image/gif";
  }
  if (base64.startsWith("UklGR")) {
    return "image/webp";
  }
  if (base64.startsWith("PHN2Zz")) {
    return "image/svg+xml";
  }
  return "image/png";
};

const base64FromBytes = (bytes: number[]): string => {
  let latin1 = "";
  for (const b of bytes) {
    latin1 += String.fromCharCode(b & 0xff);
  }
  return btoa(latin1);
};

/**
 * Mirror Rust `json_value_to_string`: a JSON string stays itself; anything else
 * is compact-serialized. With serde `preserve_order` on, `JSON.stringify` matches
 * `serde_json::Value::to_string()` byte-for-byte for object key order.
 */
const jsonValueToString = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** First string among the candidates (ports serde field aliases). */
const firstString = (...candidates: unknown[]): string | undefined => {
  for (const c of candidates) {
    if (typeof c === "string") {
      return c;
    }
  }
  return undefined;
};

/**
 * Port of `InstrumentationChatMessageImage` (untagged) →
 * `from_instrumentation_content_part`'s `Image` arm. Returns the output
 * `ChatMessageContentPart` object, or `null` if no untagged variant matches.
 */
const parseImage = (e: Record<string, unknown>): Record<string, unknown> | null => {
  // WithSource { source: { media_type, data } } → Image { mediaType, data }
  if (isRecord(e.source)) {
    const src = e.source;
    if (typeof src.media_type === "string" && typeof src.data === "string") {
      return { type: "image", mediaType: src.media_type, data: src.data };
    }
    // AnthropicImageUrl { source: { url, detail? } } → ImageUrl { url, detail }
    if (typeof src.url === "string") {
      return {
        type: "image_url",
        url: src.url,
        detail: typeof src.detail === "string" ? src.detail : null,
      };
    }
  }
  // AISDKRawBytes { image: number[], mime_type? } → ImageUrl(data: URL)
  if (Array.isArray(e.image) && e.image.every((n) => typeof n === "number")) {
    const b64 = base64FromBytes(e.image);
    const mime =
      typeof e.mime_type === "string" ? e.mime_type : inferImageType(b64);
    return { type: "image_url", url: `data:${mime};base64,${b64}`, detail: null };
  }
  // AISDKImageData { image: string, mime_type? }
  if (typeof e.image === "string") {
    if (isUrl(e.image)) {
      return { type: "image_url", url: e.image, detail: null };
    }
    return {
      type: "image",
      data: e.image,
      mediaType: typeof e.mime_type === "string" ? e.mime_type : "image/png",
    };
  }
  return null;
};

/** Port of the `Document` arm (only the Base64 source shape exists). */
const parseDocument = (e: Record<string, unknown>): Record<string, unknown> | null => {
  if (!isRecord(e.source) || e.source.type !== "base64") {
    return null;
  }
  const data = e.source.data;
  if (typeof data !== "string") {
    return null;
  }
  const mediaType = firstString(e.source.media_type, e.source.mediaType);
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: mediaType ?? "application/octet-stream",
      data,
    },
  };
};

const DATA_URL_RE = /^data:((?:application|image)\/[a-zA-Z-]+);base64,/;

/** Port of the `File` arm (OpenAI file-id / base64, AI SDK v1/v2). */
const parseFile = (e: Record<string, unknown>): Record<string, unknown> | null => {
  // OpenAI: { file: { file_id } | { filename, file_data } }
  if (isRecord(e.file)) {
    const file = e.file;
    if (typeof file.file_id === "string") {
      return { type: "text", text: JSON.stringify({ file_id: file.file_id }) };
    }
    if (typeof file.file_data === "string") {
      const m = DATA_URL_RE.exec(file.file_data.slice(0, 50));
      const mediaType = m ? m[1] : "application/octet-stream";
      const data = m
        ? file.file_data.slice(file.file_data.indexOf(",") + 1)
        : file.file_data;
      return {
        type: "document",
        source: { type: "base64", media_type: mediaType, data },
      };
    }
    return null;
  }
  // AI SDK: { data, mediaType (v2) | mime_type (v1) }
  if (typeof e.data === "string") {
    const mediaType = firstString(e.media_type, e.mediaType, e.mime_type);
    if (mediaType === undefined) {
      return null;
    }
    if (mediaType.startsWith("image/")) {
      return { type: "image", data: e.data, mediaType };
    }
    return {
      type: "document",
      source: { type: "base64", media_type: mediaType, data: e.data },
    };
  }
  return null;
};

/**
 * Port of `serde_json::from_value::<InstrumentationChatMessageContentPart>` for a
 * single part, returning the mapped output `ChatMessageContentPart` object or
 * `null` when no variant matches (an unrecognized `type`, or a recognized tag
 * whose inner shape fails). `null` propagates to an all-or-nothing Text fallback.
 *
 * Output objects carry serde's serialized field names; `skip_serializing_if` is
 * reproduced by omitting the field (ChatMessage.tool_call_id only), and `Option`
 * fields WITHOUT skip (`detail`, tool-call `id`/`arguments`) always emit `null`.
 */
const parsePart = (el: unknown): Record<string, unknown> | null => {
  if (!isRecord(el)) {
    return null;
  }
  switch (el.type) {
    case "text": {
      const text = firstString(el.text, el.input_text, el.output_text);
      return text === undefined ? null : { type: "text", text };
    }
    case "image_url": {
      // OpenAIImageUrl { image_url: { url, detail? } }
      if (!isRecord(el.image_url) || typeof el.image_url.url !== "string") {
        return null;
      }
      const detail = el.image_url.detail;
      return {
        type: "image_url",
        url: el.image_url.url,
        detail: typeof detail === "string" ? detail : null,
      };
    }
    case "image":
      return parseImage(el);
    case "document":
      return parseDocument(el);
    case "file":
      return parseFile(el);
    case "tool-call": {
      // AISDKToolCall { toolName, toolCallId?, input (alias "args")? }
      // Server reads camelCase (`#[serde(rename_all = "camelCase")]`); `args` is
      // the AI SDK v4 alias for `input`.
      if (typeof el.toolName !== "string") {
        return null;
      }
      const rawInput = "input" in el ? el.input : el.args;
      return {
        type: "tool_call",
        name: el.toolName,
        id: typeof el.toolCallId === "string" ? el.toolCallId : null,
        arguments: rawInput === undefined || rawInput === null ? null : rawInput,
      };
    }
    case "tool-result": {
      // AISDKToolResult { toolCallId, output (alias "result"), toolName }
      // Server reads camelCase; `result` is the AI SDK v4 alias for `output`.
      if (typeof el.toolCallId !== "string" || typeof el.toolName !== "string") {
        return null;
      }
      const hasOutput = "output" in el || "result" in el;
      if (!hasOutput) {
        return null;
      }
      return {
        type: "tool-result",
        toolCallId: el.toolCallId,
        output: "output" in el ? el.output : el.result,
        toolName: el.toolName,
      };
    }
    default:
      return null;
  }
};

/**
 * Port of `input_chat_messages_from_json`. `input` is the parsed
 * `ai.prompt.messages` array. Each message's `content` becomes either a
 * `ContentPartList` (when EVERY element parses as an instrumentation part) or a
 * Text blob (`json_value_to_string` of the whole content) otherwise. A message
 * missing `role`/`content` would be a server error; we skip it defensively so the
 * hash is still computed over the well-formed remainder.
 */
export const inputChatMessagesFromJson = (input: unknown): unknown[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: unknown[] = [];
  for (const message of input) {
    if (!isRecord(message)) {
      continue;
    }
    const role = message.role;
    if (typeof role !== "string" || !("content" in message)) {
      continue;
    }
    const otelContent = message.content;

    let parts: Record<string, unknown>[] | null = null;
    if (Array.isArray(otelContent)) {
      parts = [];
      for (const el of otelContent) {
        const parsed = parsePart(el);
        if (parsed === null) {
          parts = null;
          break;
        }
        parts.push(parsed);
      }
    }
    const content = parts !== null ? parts : jsonValueToString(otelContent);

    const out: Record<string, unknown> = { role, content };
    if (typeof message.tool_call_id === "string") {
      out.tool_call_id = message.tool_call_id;
    }
    messages.push(out);
  }
  return messages;
};

/**
 * Reshape an AI SDK call's `options.prompt` into the reconstructed message array
 * the server hashes. Version-agnostic: `stringifyPromptForTelemetry` already
 * normalizes V2/V3/V4 prompts (Uint8Array file `data` → base64) into the stored
 * `ai.prompt.messages` JSON, and the reshape operates on that JSON identically
 * across versions.
 *
 * Returns `null` when the prompt cannot be reshaped at all (a `stringify` /
 * `JSON.parse` failure). The caller MUST treat `null` as "can't compute a real
 * key" and degrade to a live call WITHOUT latching: hashing a default/empty
 * payload here would key the lookup off the wrong bytes, force a spurious MISS,
 * and wrongly latch live mode for the rest of the replay.
 */
export const extractInputMessages = (options: {
  prompt: LanguageModelV2Prompt | LanguageModelV3Prompt;
}): unknown[] | null => {
  let aiPromptMessages: unknown;
  try {
    aiPromptMessages = JSON.parse(stringifyPromptForTelemetry(options.prompt));
  } catch {
    return null;
  }
  return inputChatMessagesFromJson(aiPromptMessages);
};
