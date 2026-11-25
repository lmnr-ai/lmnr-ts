/**
 * Pure conversions from LangSmith run payloads to Laminar span attributes.
 *
 * A run's fields are what LangSmith's client is about to send (after sampling
 * and redaction), already reduced to JSON data. No LangSmith or LangChain
 * import here; `runs.ts` calls into these. Port of lmnr-python's
 * `bridges/langsmith/translate.py`; keep the two in step.
 */
import { type AttributeValue } from "@opentelemetry/api";

import { toJson } from "../../../utils";
import { smallState } from "../../instrumentation/langchain/span-utils";
import {
  ASSOCIATION_PROPERTIES,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
  LaminarAttributes,
  SESSION_ID,
  SPAN_INPUT,
  SPAN_OUTPUT,
  USER_ID,
} from "../../tracing/attributes";
import {
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  LS_PROVIDER_ALIASES,
  normalizeMessages,
  requestParameterAttributes,
} from "../langfuse/translate";

type Json = Record<string, any>;
type Attrs = Record<string, AttributeValue>;

// LangSmith run types recorded as LLM / TOOL spans; the rest are DEFAULT.
export const LLM_RUN_TYPES = new Set(["llm", "embedding"]);
const TOOL_RUN_TYPES = new Set(["tool"]);

// Metadata keys LangSmith reads as a thread id, in the order its UI does.
const SESSION_METADATA_KEYS = ["session_id", "thread_id", "conversation_id"];
const USER_METADATA_KEY = "user_id";

// Metadata that LangSmith, LangChain and LangGraph add themselves. Not the
// user's trace metadata, so it is left out of Laminar's. `versions` is
// LangChain JS's package versions.
const INTERNAL_METADATA_PREFIXES = [
  "ls_",
  "langgraph_",
  "LANGSMITH_",
  "LANGCHAIN_",
  "__",
];
const INTERNAL_METADATA_KEYS = new Set([
  "revision_id",
  "lc_versions",
  "versions",
  "_type",
  "usage_metadata",
  "checkpoint_ns",
  "checkpoint_id",
  ...SESSION_METADATA_KEYS,
  USER_METADATA_KEY,
]);

// Run tags LangChain and LangGraph add to mark steps (`seq:step:1`,
// `graph:step:2`, `map:key:...`) and LangSmith's own `langsmith:*` markers.
const INTERNAL_TAG = /^(seq:step:\d+|graph:step:\d+|map:key:.*|langsmith:.*)$/s;
const HIDDEN_TAG = "langsmith:hidden";

// Nested LangChain runs that only glue steps together; the LangChain
// instrumentation records no span for them either (see `langchain/AGENTS.md`).
const GLUE_RUN_NAMES = new Set(["RunnableSequence", "RunnableLambda"]);

const LC_ROLE_BY_TYPE: Record<string, string> = {
  human: "user",
  ai: "assistant",
  system: "system",
  developer: "developer",
  tool: "tool",
  function: "tool",
};
const LC_ROLE_BY_CLASS: Record<string, string> = {
  HumanMessage: "user",
  HumanMessageChunk: "user",
  AIMessage: "assistant",
  AIMessageChunk: "assistant",
  SystemMessage: "system",
  SystemMessageChunk: "system",
  ToolMessage: "tool",
  ToolMessageChunk: "tool",
  FunctionMessage: "tool",
  FunctionMessageChunk: "tool",
};

// Request parameters LangSmith's wrappers and LangChain record as metadata.
const LS_REQUEST_PARAMETERS: [string, string][] = [
  ["ls_temperature", "gen_ai.request.temperature"],
  ["ls_max_tokens", "gen_ai.request.max_tokens"],
];
const REQUEST_STOP_SEQUENCES = "gen_ai.request.stop_sequences";

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asObject = (value: unknown): Json | undefined =>
  isObject(value) ? value : undefined;

const asList = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (isObject(value) && Object.keys(value).length === 0);

/**
 * Whether LangChain's tracer recorded the run (LangChain, LangGraph): it
 * stamps its own runtime (`langchain-js`) over LangSmith's.
 */
export const isLangchainRun = (extra: unknown): boolean => {
  const library = asObject(asObject(extra)?.runtime)?.library;
  return typeof library === "string" && library.startsWith("langchain");
};

export const spanType = (runType: unknown): string => {
  if (typeof runType === "string" && LLM_RUN_TYPES.has(runType)) return "LLM";
  if (typeof runType === "string" && TOOL_RUN_TYPES.has(runType)) return "TOOL";
  return "DEFAULT";
};

// --- messages ----------------------------------------------------------------

/**
 * A serialized LangChain message as a `{role, content, ...}` object, or
 * undefined if `message` isn't one.
 *
 * LangChain's tracer sends its `Serializable` form (`{lc: 1, type:
 * "constructor", id: [..., "AIMessage"], kwargs: {...}}`; LangChain JS leaves
 * `type` out of a human message's kwargs, so the class name decides);
 * `mapChatMessagesToStoredMessages` gives `{type: "ai", data: {...}}`.
 */
export const lcMessage = (message: unknown): Json | undefined => {
  const msg = asObject(message);
  if (!msg) return undefined;
  const kwargs = asObject(msg.kwargs);
  const data = asObject(msg.data);
  let role: string | undefined;
  let fields: Json;
  if (msg.lc === 1 && kwargs) {
    const ids = asList(msg.id) ?? [];
    const className = ids[ids.length - 1];
    role =
      (typeof className === "string"
        ? LC_ROLE_BY_CLASS[className]
        : undefined) ??
      (typeof kwargs.type === "string"
        ? LC_ROLE_BY_TYPE[kwargs.type]
        : undefined);
    fields = kwargs;
  } else if (data && typeof msg.type === "string") {
    role = LC_ROLE_BY_TYPE[msg.type];
    fields = data;
  } else {
    return undefined;
  }
  // `ChatMessage` carries its own role.
  role ??= typeof fields.role === "string" ? fields.role : "user";
  const out: Json = { role, content: fields.content };
  const additional = asObject(fields.additional_kwargs) ?? {};
  let toolCalls = asList(fields.tool_calls);
  if (!toolCalls?.length) {
    // Older LangChain kept OpenAI's tool calls only here.
    toolCalls = asList(additional.tool_calls);
  }
  if (toolCalls?.length) out.tool_calls = toolCalls;
  if (!toolCalls?.length && isObject(additional.function_call)) {
    out.function_call = additional.function_call;
  }
  if (fields.tool_call_id !== undefined && fields.tool_call_id !== null) {
    out.tool_call_id = fields.tool_call_id;
  }
  return out;
};

/** Messages with LangChain's serialized ones unpacked; others as given. */
const asMessages = (items: unknown[]): unknown[] =>
  items.map((item) => lcMessage(item) ?? item);

const withSystem = (messages: unknown[], system: unknown): unknown[] =>
  (typeof system === "string" || Array.isArray(system)) && system.length > 0
    ? [{ role: "system", content: system }, ...messages]
    : messages;

/**
 * Split an LLM run's inputs into messages and tool definitions.
 *
 * Shapes:
 * - LangChain chat models: `{messages: [[<serialized message>, ...]]}` (one
 *   list per prompt in the batch; the first is used), tools in the run's
 *   `invocation_params`;
 * - LangChain completion models: `{prompts: ["..."]}`;
 * - `wrapOpenAI` / `wrapAnthropic` / hand-written `traceable` runs: the
 *   request kwargs, `{messages, tools, model, ...}`, or a `traceable`'s one
 *   argument as `{input: [...]}`;
 * - the OpenAI Responses API through `wrapOpenAI`: `{input, instructions}`;
 * - a bare `{prompt: "..."}` or string.
 * Undefined for anything else; the caller keeps the raw inputs.
 */
export const llmInput = (
  inputs: unknown,
  invocationParams?: unknown,
): { messages: unknown[]; tools: unknown } | undefined => {
  if (typeof inputs === "string") {
    return inputs
      ? { messages: [{ role: "user", content: inputs }], tools: undefined }
      : undefined;
  }
  const data = asObject(inputs);
  if (!data) return undefined;
  const params = asObject(invocationParams) ?? {};
  const tools =
    nonEmpty(data.tools) ??
    nonEmpty(data.functions) ??
    nonEmpty(params.tools) ??
    nonEmpty(params.functions);

  let messages = asList(data.messages);
  if (messages !== undefined) {
    if (messages.length > 0 && messages.every((m) => Array.isArray(m))) {
      messages = messages[0] as unknown[];
    }
    return { messages: withSystem(asMessages(messages), data.system), tools };
  }
  const prompts = asList(data.prompts);
  if (prompts?.length && typeof prompts[0] === "string") {
    return { messages: [{ role: "user", content: prompts[0] }], tools };
  }
  if ("input" in data) {
    const input = data.input;
    let items: unknown[];
    if (typeof input === "string") items = [{ role: "user", content: input }];
    else if (Array.isArray(input)) items = asMessages(input);
    else return undefined;
    if (typeof data.instructions === "string" && data.instructions) {
      items.unshift({ role: "system", content: data.instructions });
    }
    return { messages: items, tools };
  }
  if (typeof data.prompt === "string" && data.prompt) {
    return { messages: [{ role: "user", content: data.prompt }], tools };
  }
  return undefined;
};

/** A truthy value as Python reads it (non-empty list / object / string). */
const nonEmpty = (value: unknown): unknown => {
  if (value === undefined || value === null || value === "" || value === false)
    return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (isObject(value) && Object.keys(value).length === 0) return undefined;
  return value;
};

const firstGeneration = (outputs: Json): Json | undefined => {
  const generations = asList(outputs.generations);
  if (!generations?.length) return undefined;
  let first = generations[0];
  if (Array.isArray(first)) first = first.length > 0 ? first[0] : undefined;
  return asObject(first);
};

/** The fields of the AI message in LangChain's first generation. */
const generationMessageFields = (outputs: Json): Json | undefined => {
  const generation = firstGeneration(outputs);
  if (!generation) return undefined;
  const message = asObject(generation.message) ?? {};
  return asObject(message.kwargs) ?? asObject(message.data) ?? {};
};

/**
 * An LLM run's outputs as a message list, before `normalizeMessages`.
 *
 * Shapes: LangChain's `{generations: [[{message | text}]]}`; an OpenAI chat
 * completion (`choices[].message`, also what `wrapOpenAI` reduces a stream
 * to); a Responses API response (`output` items); a message object
 * (`wrapAnthropic`, hand-written runs); `{messages: [...]}`; or a string
 * (`{output: "..."}` from a `traceable` that returned one).
 */
export const llmOutput = (outputs: unknown): unknown[] | undefined => {
  if (typeof outputs === "string") {
    return outputs ? [{ role: "assistant", content: outputs }] : undefined;
  }
  const data = asObject(outputs);
  if (!data) return undefined;
  if ("generations" in data) {
    const generations = asList(data.generations) ?? [];
    const first = generations.length > 0 ? generations[0] : [];
    const batch = Array.isArray(first) ? first : [first];
    const messages: unknown[] = [];
    for (const generation of batch) {
      const gen = asObject(generation) ?? {};
      const message = lcMessage(gen.message);
      if (message) messages.push(message);
      else if (typeof gen.text === "string") {
        messages.push({ role: "assistant", content: gen.text });
      }
    }
    return messages.length > 0 ? messages : undefined;
  }
  const choices = asList(data.choices);
  if (choices !== undefined) {
    const messages: unknown[] = [];
    for (const choice of choices) {
      const c = asObject(choice) ?? {};
      const message = asObject(c.message);
      if (message) messages.push(message);
      else if (typeof c.text === "string") {
        messages.push({ role: "assistant", content: c.text });
      }
    }
    return messages.length > 0 ? messages : undefined;
  }
  const output = data.output;
  if (Array.isArray(output) && data.object === "response") {
    return asMessages(output);
  }
  if ("role" in data || ("content" in data && "tool_calls" in data)) {
    return [data];
  }
  const listed = asList(data.messages);
  if (listed !== undefined) return asMessages(listed);
  if (typeof data.content === "string" || Array.isArray(data.content)) {
    return [{ role: "assistant", content: data.content }];
  }
  if (typeof output === "string" && output) {
    return [{ role: "assistant", content: output }];
  }
  const message = lcMessage(output);
  return message ? [message] : undefined;
};

/**
 * `gen_ai.input.messages` / `gen_ai.tool.definitions` for an LLM run with a
 * recognized shape, `lmnr.span.input` otherwise.
 *
 * LangChain chain runs (graphs, nodes, sequences) carry whole graph state as
 * input and output, so only its known-small keys are kept, as the LangChain
 * instrumentation does.
 */
export const inputAttributes = (
  runType: unknown,
  inputs: unknown,
  invocationParams: unknown,
  isLangchain: boolean,
): Attrs => {
  if (isEmpty(inputs)) return {};
  if (typeof runType === "string" && LLM_RUN_TYPES.has(runType)) {
    const split = llmInput(inputs, invocationParams);
    if (split) {
      const out: Attrs = {};
      setJson(
        out,
        GEN_AI_INPUT_MESSAGES,
        normalizeMessages(split.messages, false),
      );
      if (split.tools) setJson(out, GEN_AI_TOOL_DEFINITIONS, split.tools);
      return out;
    }
  }
  if (isLangchain && runType === "chain") {
    const kept = smallState(inputs);
    return Object.keys(kept).length > 0 ? jsonAttrs(SPAN_INPUT, kept) : {};
  }
  return jsonAttrs(SPAN_INPUT, inputs);
};

/** `gen_ai.output.messages` for an LLM run, `lmnr.span.output` otherwise. */
export const outputAttributes = (
  runType: unknown,
  outputs: unknown,
  isLangchain: boolean,
): Attrs => {
  if (isEmpty(outputs)) return {};
  if (typeof runType === "string" && LLM_RUN_TYPES.has(runType)) {
    const messages = llmOutput(outputs);
    if (messages) {
      return jsonAttrs(
        GEN_AI_OUTPUT_MESSAGES,
        normalizeMessages(messages, true),
      );
    }
  }
  if (isLangchain && runType === "chain") {
    const kept = smallState(outputs);
    return Object.keys(kept).length > 0 ? jsonAttrs(SPAN_OUTPUT, kept) : {};
  }
  return jsonAttrs(SPAN_OUTPUT, outputs);
};

const setJson = (out: Attrs, key: string, value: unknown): void => {
  const json = toJson(value);
  if (json !== undefined) out[key] = json;
};

const jsonAttrs = (key: string, value: unknown): Attrs => {
  const out: Attrs = {};
  setJson(out, key, value);
  return out;
};

// --- model, provider, usage --------------------------------------------------

/**
 * LangSmith's `usage_metadata`, where its backend looks for it: in the
 * outputs, in the run's metadata (streamed / integration runs), or on
 * LangChain's AI message.
 */
const usageMetadata = (outputs: unknown, metadata: Json): Json | undefined => {
  const data = asObject(outputs) ?? {};
  const usage =
    asObject(data.usage_metadata) ?? asObject(metadata.usage_metadata);
  if (usage) return usage;
  return asObject(generationMessageFields(data)?.usage_metadata);
};

/**
 * A provider's raw usage object as LangSmith's `usage_metadata`, for runs
 * whose outputs carry one but no `usage_metadata`: OpenAI's `usage`,
 * Anthropic's `usage` (input excludes cache tokens), LangChain's
 * `llm_output.token_usage` (Python) / `llmOutput.tokenUsage` (JS).
 */
const providerUsage = (outputs: unknown): Json | undefined => {
  const data = asObject(outputs) ?? {};
  const usage =
    asObject(data.usage) ??
    asObject(asObject(data.llm_output)?.token_usage) ??
    asObject(asObject(data.llmOutput)?.tokenUsage);
  if (!usage) return undefined;
  if ("prompt_tokens" in usage || "completion_tokens" in usage) {
    const prompt = asObject(usage.prompt_tokens_details) ?? {};
    const completion = asObject(usage.completion_tokens_details) ?? {};
    return {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      input_token_details: { cache_read: prompt.cached_tokens },
      output_token_details: { reasoning: completion.reasoning_tokens },
    };
  }
  if ("promptTokens" in usage || "completionTokens" in usage) {
    return {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    };
  }
  if ("input_tokens" in usage) {
    const cacheRead = asNumber(usage.cache_read_input_tokens);
    const cacheWrite = asNumber(usage.cache_creation_input_tokens);
    let inputTokens = asNumber(usage.input_tokens);
    if (inputTokens !== undefined && (cacheRead || cacheWrite)) {
      inputTokens += (cacheRead ?? 0) + (cacheWrite ?? 0);
    }
    return {
      input_tokens: inputTokens,
      output_tokens: usage.output_tokens,
      input_token_details: {
        cache_read: cacheRead,
        cache_creation: cacheWrite,
      },
    };
  }
  return undefined;
};

/**
 * Token counts and costs from LangSmith's `usage_metadata`.
 *
 * Unlike Langfuse's usage details, LangSmith's are inclusive like Laminar's:
 * `input_tokens` already counts cached tokens and `output_tokens` reasoning
 * ones, so they map one to one.
 */
export const usageAttributes = (outputs: unknown, metadata: Json): Attrs => {
  const usage = usageMetadata(outputs, metadata) ?? providerUsage(outputs);
  if (!usage) return {};
  const inputDetails = asObject(usage.input_token_details) ?? {};
  const outputDetails = asObject(usage.output_token_details) ?? {};
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  let totalTokens = asNumber(usage.total_tokens);
  if (
    totalTokens === undefined &&
    (inputTokens !== undefined || outputTokens !== undefined)
  ) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  const out: Attrs = {};
  const tokens: [string, number | undefined][] = [
    [LaminarAttributes.INPUT_TOKEN_COUNT, inputTokens],
    [LaminarAttributes.OUTPUT_TOKEN_COUNT, outputTokens],
    [LaminarAttributes.TOTAL_TOKEN_COUNT, totalTokens],
    [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, asNumber(inputDetails.cache_read)],
    [
      GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
      asNumber(inputDetails.cache_creation),
    ],
    [GEN_AI_USAGE_REASONING_OUTPUT_TOKENS, asNumber(outputDetails.reasoning)],
  ];
  for (const [key, value] of tokens) {
    if (value !== undefined) out[key] = Math.trunc(value);
  }
  // Costs a run reports itself (`usage_metadata.{input,output,total}_cost`).
  const inputCost = asNumber(usage.input_cost);
  const outputCost = asNumber(usage.output_cost);
  let totalCost = asNumber(usage.total_cost);
  if (
    totalCost === undefined &&
    (inputCost !== undefined || outputCost !== undefined)
  ) {
    totalCost = (inputCost ?? 0) + (outputCost ?? 0);
  }
  const costs: [string, number | undefined][] = [
    [LaminarAttributes.INPUT_COST, inputCost],
    [LaminarAttributes.OUTPUT_COST, outputCost],
    [LaminarAttributes.TOTAL_COST, totalCost],
  ];
  for (const [key, value] of costs) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/**
 * Model, provider and request parameters of an LLM run, from LangSmith's
 * `ls_*` metadata (what its own cost tracking reads), then the request.
 */
export const requestAttributes = (
  inputs: unknown,
  metadata: Json,
  invocationParams: unknown,
): Attrs => {
  const out: Attrs = {};
  const data = asObject(inputs) ?? {};
  const params = asObject(invocationParams) ?? {};
  const model =
    nonEmpty(metadata.ls_model_name) ??
    nonEmpty(data.model) ??
    nonEmpty(params.model) ??
    nonEmpty(params.model_name);
  if (typeof model === "string") out[LaminarAttributes.REQUEST_MODEL] = model;
  const provider = metadata.ls_provider;
  if (typeof provider === "string" && provider) {
    out[LaminarAttributes.PROVIDER] = LS_PROVIDER_ALIASES[provider] ?? provider;
  }
  // The request's own parameters: LangChain's invocation params, or the
  // kwargs a wrapper recorded as inputs.
  const { attributes } = requestParameterAttributes(
    Object.keys(params).length > 0 ? params : data,
  );
  Object.assign(out, attributes);
  for (const [key, attr] of LS_REQUEST_PARAMETERS) {
    const value = asNumber(metadata[key]);
    if (value !== undefined && !(attr in out)) out[attr] = value;
  }
  const stop = metadata.ls_stop;
  if (
    !(REQUEST_STOP_SEQUENCES in out) &&
    Array.isArray(stop) &&
    stop.length > 0 &&
    stop.every((s) => typeof s === "string")
  ) {
    out[REQUEST_STOP_SEQUENCES] = stop;
  }
  return out;
};

/**
 * Response model and id: OpenAI / Anthropic response fields, or the
 * `response_metadata` on LangChain's AI message. LangChain JS keeps the
 * provider's response id as the message id instead (`chatcmpl-...`), next to
 * its own `run-...` ids for streamed chunks.
 */
export const responseAttributes = (outputs: unknown): Attrs => {
  const data = asObject(outputs) ?? {};
  let model: unknown = data.model;
  let responseId: unknown = data.id;
  const fields = generationMessageFields(data);
  if (fields) {
    const responseMetadata = asObject(fields.response_metadata) ?? {};
    model =
      nonEmpty(responseMetadata.model_name) ?? nonEmpty(responseMetadata.model);
    responseId = responseMetadata.id;
    if (
      responseId === undefined &&
      typeof fields.id === "string" &&
      !/^(lc_)?run-/.test(fields.id)
    ) {
      responseId = fields.id;
    }
    if (!model) {
      const llmOutputData =
        asObject(data.llm_output) ?? asObject(data.llmOutput) ?? {};
      model = llmOutputData.model_name;
    }
  }
  const out: Attrs = {};
  if (typeof model === "string" && model) {
    out[LaminarAttributes.RESPONSE_MODEL] = model;
  }
  if (typeof responseId === "string" && responseId) {
    out["gen_ai.response.id"] = responseId;
  }
  return out;
};

// --- session, user, tags, metadata -------------------------------------------

const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value ? value : undefined;
};

const sameJson = (a: unknown, b: unknown): boolean =>
  a === b || (toJson(a) !== undefined && toJson(a) === toJson(b));

/**
 * Session, user, tags and (on the root run) trace metadata.
 *
 * LangSmith groups runs into threads by the `session_id`, `thread_id` or
 * `conversation_id` metadata key (LangGraph sets `thread_id`), which becomes
 * Laminar's session. Metadata is inherited by child runs in LangSmith, so
 * only the root run's becomes Laminar trace metadata, without the keys
 * LangSmith, LangChain and LangGraph add themselves.
 */
export const associationAttributes = (
  metadata: Json,
  tags: unknown,
  isRoot: boolean,
  invocationParams?: unknown,
): Attrs => {
  const out: Attrs = {};
  for (const key of SESSION_METADATA_KEYS) {
    const sessionId = text(metadata[key]);
    if (sessionId) {
      out[SESSION_ID] = sessionId;
      break;
    }
  }
  const userId = text(metadata[USER_METADATA_KEY]);
  if (userId) out[USER_ID] = userId;

  if (Array.isArray(tags)) {
    const kept = [
      ...new Set(
        tags.filter(
          (t): t is string => typeof t === "string" && !INTERNAL_TAG.test(t),
        ),
      ),
    ];
    if (kept.length > 0) out[`${ASSOCIATION_PROPERTIES}.tags`] = kept;
  }

  if (isRoot) {
    // LangChain copies a chat model's invocation params into its metadata.
    const params = asObject(invocationParams) ?? {};
    for (const [key, value] of Object.entries(metadata)) {
      if (
        INTERNAL_METADATA_KEYS.has(key) ||
        INTERNAL_METADATA_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        (key in params && sameJson(params[key], value)) ||
        value === undefined ||
        value === null
      ) {
        continue;
      }
      const v =
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number"
          ? value
          : toJson(value);
      if (v !== undefined) out[`${ASSOCIATION_PROPERTIES}.metadata.${key}`] = v;
    }
  }
  return out;
};

/**
 * Runs left out of Laminar's tree when nested, their children moving up to
 * the nearest recorded ancestor: LangChain's unnamed sequences and lambdas
 * (as the LangChain instrumentation does) and runs LangSmith's UI hides
 * (`langsmith:hidden`).
 */
export const isGlueRun = (
  name: unknown,
  tags: unknown,
  isLangchain: boolean,
): boolean => {
  if (Array.isArray(tags) && tags.includes(HIDDEN_TAG)) return true;
  return isLangchain && typeof name === "string" && GLUE_RUN_NAMES.has(name);
};

// --- errors ------------------------------------------------------------------

const EXCEPTION_REPR = /^([A-Za-z_][\w.]*)\((.*)\)$/s;
const EXCEPTION_PREFIX = /^[A-Za-z_][\w.]*:/;

/**
 * An `exception` event's attributes from LangSmith's error string: the
 * thrown value as text (JS: `Error: message`), or Python's `repr(exc)`, a
 * blank line, then the traceback.
 */
export const exceptionAttributes = (error: string): Attrs => {
  const separator = error.indexOf("\n\n");
  const head = (separator >= 0 ? error.slice(0, separator) : error).trim();
  const stacktrace = separator >= 0 ? error.slice(separator + 2).trim() : "";
  let type = "Error";
  let message = head;
  const match = EXCEPTION_REPR.exec(head);
  if (match) {
    type = match[1];
    message = match[2].trim();
    if (
      message.length >= 2 &&
      message[0] === message[message.length - 1] &&
      (message[0] === "'" || message[0] === '"')
    ) {
      message = message.slice(1, -1);
    }
  } else if (EXCEPTION_PREFIX.test(head)) {
    const colon = head.indexOf(":");
    type = head.slice(0, colon);
    message = head.slice(colon + 1).trim();
  }
  const out: Attrs = {
    "exception.type": type,
    "exception.message": message,
  };
  if (stacktrace) out["exception.stacktrace"] = stacktrace;
  return out;
};
