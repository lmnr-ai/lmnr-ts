/**
 * pi-ai messages → Laminar `gen_ai.*` attributes. Ported from
 * `@lmnr-ai/pi-extension` (`src/messages.ts`, `src/attributes.ts`), which maps
 * the Pi coding agent's messages the same way.
 *
 * Messages are reported as Anthropic-style `{ role, content: blocks[] }`:
 *
 *   pi block                                  Anthropic block
 *   {type:"text",     text}                →  {type:"text",     text}
 *   {type:"thinking", thinking}            →  {type:"thinking", thinking}
 *   {type:"toolCall", id, name, arguments} →  {type:"tool_use",  id, name, input}
 *   {type:"image", mimeType}               →  {type:"text", text:"[image <mime>]"}
 *   role "toolResult"                      →  role "user" + {type:"tool_result", …}
 *
 * Laminar's parser matches a CLOSED union of Anthropic block types with no
 * passthrough branch: one unknown block fails its message, which fails the
 * whole array. Only emit shapes in that union.
 */
import { LaminarAttributes } from "../../tracing/attributes";
import type {
  PiAssistantMessage,
  PiMessage,
  PiSystemMessage,
  PiTool,
  PiUsage,
} from "./types";

type Block = Record<string, unknown>;

export interface ChatMessage {
  role: string;
  content: Block[];
}

const blockToContent = (block: any): Block | null => {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      return typeof block.text === "string"
        ? { type: "text", text: block.text }
        : null;
    case "thinking":
      return typeof block.thinking === "string"
        ? { type: "thinking", thinking: block.thinking }
        : null;
    case "toolCall":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments ?? {},
      };
    case "image":
      // Pi keeps an image in context for the rest of the run; re-embedding
      // the base64 would repeat it on every later LLM span.
      return {
        type: "text",
        text: `[image${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""}]`,
      };
    default:
      return null;
  }
};

export const contentToBlocks = (content: unknown): Block[] => {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.map(blockToContent).filter((b): b is Block => b !== null);
};

/** The text blocks of a content array (or a bare string), joined. */
export const contentText = (content: unknown, separator = "\n"): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(separator);
};

/**
 * One pi message as a chat message, or null when it carries nothing. System
 * messages are left out here: they are replayed into one leading system
 * message by `buildInputMessages`.
 */
export const toChatMessage = (message: PiMessage): ChatMessage | null => {
  if (!message || typeof message !== "object") return null;
  switch (message.role) {
    case "user":
    case "assistant": {
      const content = contentToBlocks(message.content);
      return content.length > 0 ? { role: message.role, content } : null;
    }
    case "toolResult": {
      const block: Block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: contentToBlocks(message.content),
      };
      if (message.isError) block.is_error = true;
      // Anthropic carries tool results on a USER message; Laminar's parser
      // accepts only user / assistant / system.
      return { role: "user", content: [block] };
    }
    default:
      return null;
  }
};

const isSystemMessage = (message: unknown): message is PiSystemMessage =>
  (message as PiMessage | undefined)?.role === "system";

/**
 * The tools in effect after replaying every system message, like pi-ai's
 * `getCurrentTools`.
 */
export const currentTools = (messages: readonly PiMessage[]): PiTool[] => {
  const tools = new Map<string, PiTool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
};

/**
 * The system prompt text after replaying every system message, like pi-ai's
 * `getCurrentSystemPrompt`: content of every system message, then the
 * current named sections.
 */
export const currentSystemPrompt = (messages: readonly PiMessage[]): string => {
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [content.join("\n\n"), ...sections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
};

/**
 * `gen_ai.input.messages` for one request: the replayed system prompt (or
 * `systemPrompt`, when the host supplies one) leads, then the chat messages.
 */
export const buildInputMessages = (
  messages: readonly PiMessage[],
  systemPrompt?: string,
): ChatMessage[] => {
  const out: ChatMessage[] = [];
  const prompt = systemPrompt ?? currentSystemPrompt(messages);
  if (prompt) {
    out.push({ role: "system", content: [{ type: "text", text: prompt }] });
  }
  for (const message of messages) {
    const mapped = toChatMessage(message);
    if (mapped) out.push(mapped);
  }
  return out;
};

/**
 * Tool definitions for `gen_ai.tool.definitions`, in the
 * `{ name, description, parameters }` shape Laminar extracts.
 */
export const buildToolDefinitions = (tools: readonly PiTool[]) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));

/** The text of the newest user turn: the trailing run of user messages. */
export const lastUserText = (messages: readonly PiMessage[]): string => {
  let end = messages.length - 1;
  while (end >= 0 && messages[end].role !== "user") end--;
  let start = end;
  while (start > 0 && messages[start - 1].role === "user") start--;
  const parts: string[] = [];
  for (let i = start; i <= end && i >= 0; i++) {
    const text = contentText(messages[i].content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
};

const KNOWN_VENDORS = [
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "cohere",
  "qwen",
  "deepseek",
  "amazon",
];

/** The model vendor for `gen_ai.system`, from the model id, else provider. */
export const inferVendor = (
  model: string | undefined,
  provider: string | undefined,
): string => {
  const haystack = (model ?? "").toLowerCase();
  const vendor = KNOWN_VENDORS.find((v) => haystack.includes(v));
  return vendor ?? ((provider ?? "").toLowerCase() || "unknown");
};

const positive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Token counts as `gen_ai.usage.*`, kept only when > 0. */
export const usageAttributes = (
  usage: PiUsage | undefined,
): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!usage) return out;
  const pairs: [string, number | undefined][] = [
    [LaminarAttributes.INPUT_TOKEN_COUNT, usage.input],
    [LaminarAttributes.OUTPUT_TOKEN_COUNT, usage.output],
    ["gen_ai.usage.cache_read_input_tokens", usage.cacheRead],
    ["gen_ai.usage.cache_creation_input_tokens", usage.cacheWrite],
    [
      "gen_ai.usage.cache_creation.input_tokens.ephemeral_1h",
      usage.cacheWrite1h,
    ],
    ["gen_ai.usage.reasoning_tokens", usage.reasoning],
    [LaminarAttributes.TOTAL_TOKEN_COUNT, usage.totalTokens],
  ];
  for (const [key, value] of pairs) {
    if (positive(value)) out[key] = value;
  }
  return out;
};

/**
 * pi-ai's cost as `gen_ai.usage.*cost`, only when its total is > 0. pi-ai
 * reports 0 for models missing from its catalog; leaving the cost out lets
 * Laminar price those from the token counts. Cache reads and writes fold
 * into `input_cost`, Laminar's breakdown being three-way.
 */
export const costAttributes = (
  usage: PiUsage | undefined,
): Record<string, number> => {
  const cost = usage?.cost;
  if (!cost || !positive(cost.total)) return {};
  const num = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    [LaminarAttributes.TOTAL_COST]: cost.total,
    [LaminarAttributes.INPUT_COST]:
      num(cost.input) + num(cost.cacheRead) + num(cost.cacheWrite),
    [LaminarAttributes.OUTPUT_COST]: num(cost.output),
  };
};

/** The assistant message as `gen_ai.output.messages`' single message. */
export const buildOutputMessage = (
  message: PiAssistantMessage,
): ChatMessage => ({
  role: "assistant",
  content: contentToBlocks(message.content),
});
