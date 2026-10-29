/**
 * Build an lmnr-atif trajectory (`spec/lmnr-atif/lmnr-atif.md`) from spans.
 *
 * `buildTrajectory` is a pure function from finished spans (`SpanRecord`s) to
 * the trajectory object. It doesn't touch the tracing stack: the span
 * processor that collects records and the file writer live elsewhere, so this
 * can be tested from JSON fixtures shared with the Python SDK.
 *
 * Overview (spec §6):
 *
 * 1. Spans form a tree per trace; all traces go into one trajectory.
 * 2. The tree is cut into agent scopes. A span is a scope boundary if it marks
 *    a new agent (`gen_ai.agent.name` or `gen_ai.operation.name ==
 *    "invoke_agent"`, with a different name from the enclosing agent), or if
 *    it is a TOOL span that runs LLM calls itself (an implicit subagent). A
 *    lone agent at the top with nothing else beside it is the root agent, not
 *    a subagent. Each boundary becomes an embedded subagent trajectory.
 * 3. Within a scope, each LLM span is one agent step. Messages new in a call's
 *    input become user/system steps before it; tool results in the next
 *    call's input become the observation of the call that made them. When a
 *    call's input isn't the previous call's input + output + new messages,
 *    the step gets an `input_messages` override.
 * 4. TOOL spans are matched to the tool calls the LLM made (by call id, then
 *    name and arguments, then name). Unmatched ones become synthetic
 *    `llm_call_count: 0` steps.
 *
 * Line-comparable port of the Python SDK's `lmnr/sdk/trajectory/builder.py`.
 * Keep the two in step: the shared golden suite pins the output. Times are
 * integer microseconds since the epoch here (nanoseconds don't fit in a
 * Number); Python keeps nanoseconds but every value is a whole microsecond.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { version as SDK_VERSION } from "../../package.json";
import {
  contentText,
  MediaSink,
  Message,
  normalizeCall,
  normalizeTools,
  toolCall,
} from "./normalize";
import {
  canonicalJson,
  compareCodePoints,
  compareTuples,
  counter,
  get,
  has,
  isDict,
  isNone,
  JsonObject,
  jsonLoads,
  or,
  pyEquals,
  pyIn,
  pyJsonDumps,
  pyRound,
  pyStr,
  setdefault,
  truthy,
} from "./py";
import { asDict, dicts } from "./reader";
import { ATIF_SCHEMA_VERSION, SPEC_VERSION } from "./spec";

// `gen_ai.request.*` attributes that describe the transport, or that have
// their own place in ATIF, rather than request parameters.
const NOT_REQUEST_PARAMS = new Set([
  "model",
  "base_url",
  "api_type",
  "api_version",
  "reasoning_effort",
]);
const SYSTEM_ROLES = ["system", "developer"];

export interface SpanError {
  type: string;
  message: string;
  stacktrace?: string;
}

/**
 * A finished span, as much of it as the builder needs.
 *
 * Fields are the language-neutral JSON form (`spec/lmnr-atif/writer-golden/
 * README.md`), hence snake_case: ids are Laminar UUID strings, times are ISO
 * 8601 strings with microseconds, and attributes are the span's raw OTel
 * attribute values.
 */
export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string;
  start_time: string;
  end_time: string;
  attributes: Record<string, unknown>;
  // `{type, message[, stacktrace]}` from the span's `exception` event.
  error?: SpanError | null;
}

export const spanRecordFromJson = (value: JsonObject): SpanRecord => ({
  trace_id: pyStr(value.trace_id),
  span_id: pyStr(value.span_id),
  parent_span_id: get(value, "parent_span_id") ?? null,
  name: pyStr(or(get(value, "name"), "")),
  span_type: pyStr(or(get(value, "span_type"), "DEFAULT")),
  start_time: pyStr(value.start_time),
  end_time: pyStr(value.end_time),
  attributes: { ...or(get(value, "attributes"), {}) },
  error: get(value, "error") ?? null,
});

export const spanRecordToJson = (record: SpanRecord): JsonObject => {
  const result: JsonObject = {
    trace_id: record.trace_id,
    span_id: record.span_id,
    parent_span_id: record.parent_span_id,
    name: record.name,
    span_type: record.span_type,
    start_time: record.start_time,
    end_time: record.end_time,
    attributes: record.attributes,
  };
  if (!isNone(record.error)) {
    result.error = record.error;
  }
  return result;
};

export interface BuildOptions {
  // Defaults to `{name: "lmnr-ts", version: <this package's version>}`.
  producer?: { name: string; version: string };
  // `agent.version`; falls back to the spans' `lmnr.span.release`.
  release?: string | null;
  projectId?: string | null;
  exported?: boolean;
  // False while spans of the run are still open (a snapshot).
  complete?: boolean;
  // Stores inline media; without it, images become text placeholders.
  media?: MediaSink | null;
}

export const DEFAULT_PRODUCER = { name: "lmnr-ts", version: SDK_VERSION };

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?$/;

/** Microseconds since the epoch of an ISO 8601 time (UTC when no offset). */
export const parseTimeUs = (value: string): number => {
  const match = ISO_TIME.exec(value);
  if (match === null) {
    throw new Error(`Invalid isoformat string: ${JSON.stringify(value)}`);
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  let us = ms * 1000 + Number((fraction ?? "").slice(0, 6).padEnd(6, "0"));
  if (zone !== undefined && zone !== "Z") {
    const digits = zone.slice(1).replace(/:/g, "");
    const offset =
      Number(digits.slice(0, 2)) * 3600 +
      Number(digits.slice(2, 4)) * 60 +
      Number(digits.slice(4, 6) || 0);
    us -= (zone[0] === "-" ? -1 : 1) * offset * 1_000_000;
  }
  return us;
};

/** ISO 8601 with microseconds and a `Z` suffix. */
export const formatTime = (us: number): string => {
  const seconds = Math.floor(us / 1_000_000);
  const rest = us - seconds * 1_000_000;
  const iso = new Date(seconds * 1000).toISOString(); // ...:SS.000Z
  return `${iso.slice(0, 19)}.${String(rest).padStart(6, "0")}Z`;
};

export { canonicalJson };

export const defKey = (value: unknown): string =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalJson(value))))}`;

const jsonAttribute = (value: unknown): any => {
  if (typeof value === "string") {
    const parsed = jsonLoads(value);
    return parsed === undefined ? value : parsed.value;
  }
  return value;
};

const number = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

/** Identity of a message across calls: what the model sees, minus reasoning
 * (often not sent back) and writer metadata. */
const messageKey = (message: Message): string => {
  const calls = dicts(get(message, "tool_calls")).map((c) => [
    get(c, "tool_call_id"),
    get(c, "function_name"),
    get(c, "arguments"),
  ]);
  return canonicalJson([
    get(message, "role"),
    !isNone(get(message, "content")) ? message.content : "",
    calls,
    get(message, "tool_call_id"),
  ]);
};

/** A normalized message without the normalizer's internal `_` keys. */
const toPublic = (message: Message): Message =>
  Object.fromEntries(
    Object.entries(message).filter(([k]) => !k.startsWith("_")),
  );

/** A `(index, id)` tuple as a Map key. */
const pair = (index: number, id: string): string => JSON.stringify([index, id]);

/** A `(override name, canonical value)` tuple as a Map key. */
const usageKey = (name: string, value: unknown): string =>
  JSON.stringify([name, canonicalJson(value)]);

class Span {
  readonly id: string;
  readonly attrs: Record<string, unknown>;
  readonly start: number;
  readonly end: number;
  parent: Span | null = null;
  readonly children: Span[] = [];
  isLlm: boolean;
  readonly isTool: boolean;

  constructor(readonly record: SpanRecord) {
    this.id = record.span_id;
    this.attrs = record.attributes;
    this.start = parseTimeUs(record.start_time);
    this.end = Math.max(parseTimeUs(record.end_time), this.start);
    this.isLlm = record.span_type === "LLM";
    this.isTool = record.span_type === "TOOL";
  }

  get agentMarker(): string | null {
    const name = get(this.attrs, "gen_ai.agent.name");
    if (typeof name === "string" && name) {
      return name;
    }
    if (get(this.attrs, "gen_ai.operation.name") === "invoke_agent") {
      return this.record.name || "agent";
    }
    return null;
  }

  *descendants(): Generator<Span> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  /** An LLM call runs below this span with no agent marker in between. */
  hostsLlm(): boolean {
    const stack = [...this.children];
    while (stack.length > 0) {
      const span = stack.pop()!;
      if (span.agentMarker !== null) {
        continue;
      }
      if (span.isLlm) {
        return true;
      }
      stack.push(...span.children);
    }
    return false;
  }

  jsonAttr(key: string): any {
    return jsonAttribute(get(this.attrs, key));
  }
}

interface Call {
  span: Span;
  system: Message[];
  conversation: Message[];
  output: Message | null;
  finishReason: string | null;
  tools: JsonObject[];
}

class Totals {
  cost: number | null = null;
  start: number | null = null;
  end: number | null = null;

  constructor(
    public llmCalls = 0,
    public toolCalls = 0,
    public errors = 0,
  ) {}

  addCost(value: number | null): void {
    if (value !== null) {
      this.cost = (this.cost ?? 0) + value;
    }
  }

  addTime(start: number, end: number): void {
    this.start = this.start === null ? start : Math.min(this.start, start);
    this.end = this.end === null ? end : Math.max(this.end, end);
  }

  merge(other: Totals): void {
    this.llmCalls += other.llmCalls;
    this.toolCalls += other.toolCalls;
    this.errors += other.errors;
    this.addCost(other.cost);
    if (other.start !== null && other.end !== null) {
      this.addTime(other.start, other.end);
    }
  }
}

type Matched = Map<string, [Span, JsonObject]>;
// (time, call index, group, position), then the step.
type Entry = [number, number, number, number, JsonObject];

class Builder {
  readonly spans: Span[];
  readonly byId: Map<string, Span>;
  readonly roots: Span[];
  readonly traceIds: string[];
  readonly multiTrace: boolean;
  readonly release: string;
  readonly sessionId: string | null;
  scope = new Map<string, string | null>();
  boundaries = new Map<string, "agent" | "implicit">();

  constructor(
    records: SpanRecord[],
    readonly options: Required<BuildOptions>,
  ) {
    const spans = new Map<string, Span>();
    for (const record of records) {
      spans.set(record.span_id, new Span(record));
    }
    this.spans = [...spans.values()].sort((a, b) =>
      compareTuples([a.start, a.end], [b.start, b.end]),
    );
    this.byId = spans;
    for (const span of this.spans) {
      const parentId = span.record.parent_span_id;
      span.parent = parentId ? (spans.get(parentId) ?? null) : null;
      if (span.parent !== null) {
        span.parent.children.push(span);
      }
    }
    this.roots = this.spans.filter((s) => s.parent === null);
    // When frameworks nest LLM spans (a LangChain run around the provider
    // call), the innermost one has the provider's exact messages.
    for (const span of this.spans) {
      if (span.isLlm && [...span.descendants()].some((d) => d.isLlm)) {
        span.isLlm = false;
      }
    }

    this.traceIds = [...new Set(this.spans.map((s) => s.record.trace_id))];
    this.multiTrace = this.traceIds.length > 1;
    this.release = or(
      options.release,
      this.spans
        .map((s) => get(s.attrs, "lmnr.span.release"))
        .find((r) => typeof r === "string" && r),
      "unknown",
    );
    this.sessionId =
      (this.spans
        .map((s) => get(s.attrs, "lmnr.association.properties.session_id"))
        .find((v) => typeof v === "string" && v) as string | undefined) ?? null;
    this.assignScopes();
  }

  // -- scopes ---------------------------------------------------------------

  private assignScopes(): void {
    const collapsed = new Set<string>();
    while (true) {
      this.scope = new Map();
      this.boundaries = new Map();
      for (const root of this.roots) {
        this.visit(root, null, null, collapsed);
      }
      const own = this.spans.filter(
        (s) => (s.isLlm || s.isTool) && this.scope.get(s.id) === null,
      );
      const top = this.boundaryScopes()
        .filter(([, scope]) => scope === null)
        .map(([b]) => b);
      if (
        own.length > 0 ||
        top.length !== 1 ||
        this.boundaries.get(top[0]) !== "agent"
      ) {
        return;
      }
      collapsed.add(top[0]);
    }
  }

  private boundaryScopes(): [string, string | null][] {
    return [...this.boundaries.keys()].map((b) => [
      b,
      this.scope.get(b) ?? null,
    ]);
  }

  private visit(
    span: Span,
    scope: string | null,
    agent: string | null,
    collapsed: Set<string>,
  ): void {
    this.scope.set(span.id, scope);
    const marker = span.agentMarker;
    let [childScope, childAgent] = [scope, agent];
    if (marker !== null && marker !== agent && !collapsed.has(span.id)) {
      this.boundaries.set(span.id, "agent");
      [childScope, childAgent] = [span.id, marker];
    } else if (span.isTool && span.hostsLlm()) {
      this.boundaries.set(span.id, "implicit");
      [childScope, childAgent] = [span.id, span.record.name];
    } else if (marker !== null) {
      childAgent = marker;
    }
    for (const child of span.children) {
      this.visit(child, childScope, childAgent, collapsed);
    }
  }

  // -- calls ----------------------------------------------------------------

  private call(span: Span): Call {
    let inputRaw = span.jsonAttr("gen_ai.input.messages");
    if (isNone(inputRaw)) {
      inputRaw = span.jsonAttr("lmnr.span.input");
    }
    let outputRaw = span.jsonAttr("gen_ai.output.messages");
    if (isNone(outputRaw)) {
      outputRaw = span.jsonAttr("lmnr.span.output");
    }
    const normalized = normalizeCall(inputRaw, outputRaw, this.options.media);
    const [messages, output] = normalized;
    let finishReason = normalized[2];

    let system: Message[] = [];
    while (messages.length > 0 && SYSTEM_ROLES.includes(messages[0].role)) {
      system.push(messages.shift()!);
    }
    // The OpenAI Responses API records its system prompt (`instructions`)
    // only in the legacy indexed attributes.
    if (
      system.length === 0 &&
      get(span.attrs, "gen_ai.prompt.0.role") === "system"
    ) {
      const content = get(span.attrs, "gen_ai.prompt.0.content");
      if (typeof content === "string" && content) {
        system = [{ role: "system", content }];
      }
    }

    const reasons = get(span.attrs, "gen_ai.response.finish_reasons");
    if (Array.isArray(reasons) && reasons.length > 0) {
      finishReason = pyStr(reasons[0]);
    } else if (typeof reasons === "string" && reasons) {
      finishReason = reasons;
    }

    // Calls whose tool calls have no id get one, so results can point at it.
    if (output !== null) {
      dicts(get(output, "tool_calls")).forEach((call, index) => {
        if (!truthy(get(call, "tool_call_id"))) {
          call.tool_call_id = `lmnr-${span.id}-${index}`;
          const extra = setdefault<JsonObject>(call, "extra", {});
          setdefault<JsonObject>(extra, "lmnr", {}).synthetic_id = true;
        }
      });
    }
    const tools = normalizeTools(span.jsonAttr("gen_ai.tool.definitions"));
    return {
      span,
      system,
      conversation: messages,
      output,
      finishReason,
      tools,
    };
  }

  // -- trajectories ---------------------------------------------------------

  build(): JsonObject | null {
    const [trajectory] = this.trajectory(null);
    if (!truthy(trajectory.steps)) {
      return null;
    }
    return trajectory;
  }

  private trajectory(scope: string | null): [JsonObject, Totals] {
    const spans = this.spans.filter(
      (s) => (this.scope.get(s.id) ?? null) === scope,
    );
    const calls = spans.filter((s) => s.isLlm).map((s) => this.call(s));
    const toolSpans = spans.filter((s) => s.isTool);
    const children = this.boundaryScopes()
      .filter(([, parent]) => parent === scope)
      .map(([b]) => b);
    const totals = new Totals();

    const subTrajectories = new Map<string, JsonObject>();
    for (const child of children) {
      const [sub, subTotals] = this.trajectory(child);
      subTrajectories.set(child, sub);
      totals.merge(subTotals);
    }

    const defaultSystem = calls.length > 0 ? calls[0].system : [];
    // A system message right after the default system prompt (a compaction
    // note, injected context) is part of the conversation, not the prompt.
    // Without a default system prompt, a later call's leading system
    // messages are its own system prompt.
    const defaultKeys = defaultSystem.map(messageKey);
    for (const call of defaultSystem.length > 0 ? calls.slice(1) : []) {
      const extra = call.system.length - defaultSystem.length;
      if (
        extra > 0 &&
        pyEquals(
          call.system.slice(0, defaultSystem.length).map(messageKey),
          defaultKeys,
        )
      ) {
        call.conversation = [
          ...call.system.slice(defaultSystem.length),
          ...call.conversation,
        ];
        call.system = call.system.slice(0, defaultSystem.length);
      }
    }
    const toolKeys = calls.map((c) => canonicalJson(c.tools));
    let defaultTools: JsonObject[] = [];
    if (toolKeys.length > 0) {
      const counts = counter(toolKeys);
      const best = Math.max(...counts.values());
      defaultTools = calls.find(
        (c) => counts.get(canonicalJson(c.tools)) === best,
      )!.tools;
    }

    // Overrides are collected first so values used twice can go in defs.
    const overrides: JsonObject[] = calls.map(() => ({}));
    // (time, call index, group, position, step): a call's new messages, then
    // the call, then steps without an LLM call.
    const entries: Entry[] = [];
    const matched = this.matchTools(calls, toolSpans);
    // Tool results seen in the next call's input, by (index of the call that
    // made the tool call, tool call id). Ids alone can repeat across
    // conversations (Gemini's generated `<name>_<k>`).
    const resultsFromInput = new Map<string, Message>();
    let base: Message[] = [];
    let prevCallIds: string[] = [];
    calls.forEach((call, k) => {
      const conversation = call.conversation;
      const keys = conversation.map(messageKey);
      const baseKeys = base.map(messageKey);
      let common = 0;
      while (
        common < Math.min(keys.length, baseKeys.length) &&
        keys[common] === baseKeys[common]
      ) {
        common += 1;
      }
      const fresh = conversation.slice(common);
      const results = fresh.filter(
        (m) =>
          get(m, "role") === "tool" &&
          prevCallIds.includes(get(m, "tool_call_id")),
      );
      const others = fresh.filter((m) => !results.includes(m));
      const resultIds = results.map((m) => pyStr(get(m, "tool_call_id")));
      // A reader rebuilds this input as: the previous input and output, that
      // call's tool results in tool-call order (from the input, or else from
      // the tool spans), then the new messages as steps. Any other shape
      // needs the exact input written out.
      const rebuilt = [...results].sort(
        (a, b) =>
          prevCallIds.indexOf(pyStr(get(a, "tool_call_id"))) -
          prevCallIds.indexOf(pyStr(get(b, "tool_call_id"))),
      );
      const fromSpans = prevCallIds.filter(
        (i) => !resultIds.includes(i) && matched.has(pair(k - 1, i)),
      );
      const extends_ =
        common === base.length &&
        new Set(resultIds).size === resultIds.length &&
        fromSpans.length === 0 &&
        pyEquals([...rebuilt, ...others].map(messageKey), keys.slice(common)) &&
        others.every((m) => !["assistant", "tool"].includes(get(m, "role")));
      if (!extends_) {
        overrides[k].input_messages = conversation.map(toPublic);
      }
      fresh.forEach((message, j) => {
        const role = get(message, "role");
        if (results.includes(message)) {
          const key = pair(k - 1, pyStr(message.tool_call_id));
          if (!resultsFromInput.has(key)) {
            resultsFromInput.set(key, message);
          }
          return;
        }
        if (role === "assistant") {
          return;
        }
        const step: JsonObject = {
          timestamp: formatTime(call.span.start),
          source: SYSTEM_ROLES.includes(role) ? "system" : "user",
          message: or(
            role !== "tool"
              ? get(message, "content")
              : contentText(get(message, "content")),
            "",
          ),
          extra: { lmnr: { source_span_id: call.span.id } },
        };
        if (role === "developer") {
          step.extra.lmnr.role = "developer";
        }
        entries.push([call.span.start, k, 0, j, step]);
      });

      if (
        !pyEquals(call.system.map(messageKey), defaultSystem.map(messageKey))
      ) {
        if (call.system.length === 0) {
          overrides[k].system_prompt = "";
        } else if (call.system.length === 1) {
          overrides[k].system_prompt = or(get(call.system[0], "content"), "");
        } else {
          overrides[k].system_prompt = call.system
            .map((m) => contentText(get(m, "content")))
            .join("\n\n");
        }
      }
      if (canonicalJson(call.tools) !== canonicalJson(defaultTools)) {
        overrides[k].tool_definitions = call.tools;
      }

      base = [...conversation, ...(call.output !== null ? [call.output] : [])];
      prevCallIds = dicts(get(call.output ?? {}, "tool_calls")).map((c) =>
        pyStr(get(c, "tool_call_id")),
      );
    });

    // Defs: override values used by more than one step.
    const defs: Record<string, JsonObject> = {};
    const kinds: Record<string, string> = {
      system_prompt: "system_prompts",
      tool_definitions: "tool_definitions",
      input_messages: "input_messages",
    };
    const usage = counter(
      overrides.flatMap((override) =>
        Object.entries(override)
          .filter(([, value]) => !pyIn(value, ["", []]))
          .map(([name, value]) => usageKey(name, value)),
      ),
    );
    for (const override of overrides) {
      for (const [name, value] of Object.entries(override)) {
        if (
          pyIn(value, ["", []]) ||
          (usage.get(usageKey(name, value)) ?? 0) < 2
        ) {
          continue;
        }
        const key = defKey(value);
        setdefault<JsonObject>(defs, kinds[name], {})[key] = value;
        override[name] = { $ref: key };
      }
    }

    const matchedSpans = new Set(
      [...matched.values()].map(([span]) => span.id),
    );

    // Which observation result (call index, tool call id) or synthetic step
    // (span id) references each subagent.
    const refsByCall = new Map<string, string[]>();
    const refsBySpan = new Map<string, string[]>();
    const unspawned: string[] = [];
    const spanToCall = new Map(
      [...matched.entries()].map(([key, [span]]) => [span.id, key]),
    );
    for (const child of children) {
      const spawner = this.spawner(child, scope);
      if (spawner === null) {
        unspawned.push(child);
      } else if (spanToCall.has(spawner.id)) {
        const key = spanToCall.get(spawner.id)!;
        refsByCall.set(key, [...(refsByCall.get(key) ?? []), child]);
      } else {
        refsBySpan.set(spawner.id, [
          ...(refsBySpan.get(spawner.id) ?? []),
          child,
        ]);
      }
    }

    calls.forEach((call, k) => {
      const [step, stepTotals] = this.agentStep(
        call,
        k,
        overrides[k],
        matched,
        resultsFromInput,
        refsByCall,
        subTrajectories,
      );
      totals.merge(stepTotals);
      entries.push([call.span.start, k, 1, 0, step]);
    });

    // Steps without an LLM call sort after any call starting at the same time.
    const afterCalls = calls.length;
    for (const span of toolSpans) {
      if (matchedSpans.has(span.id)) {
        continue;
      }
      const [step, stepTotals] = this.syntheticToolStep(
        span,
        refsBySpan.get(span.id) ?? [],
        subTrajectories,
      );
      totals.merge(stepTotals);
      entries.push([span.start, afterCalls, 2, 0, step]);
    }
    for (const child of unspawned) {
      const span = this.byId.get(child)!;
      const step = this.syntheticAgentStep(span, subTrajectories.get(child)!);
      totals.toolCalls += 1;
      if (truthy(span.record.error)) {
        totals.errors += 1;
      }
      entries.push([span.start, afterCalls, 2, 0, step]);
    }

    entries.sort((a, b) =>
      compareTuples([a[0], a[1], a[2], a[3]], [b[0], b[1], b[2], b[3]]),
    );
    const steps = [
      ...defaultSystem.map((m) => this.systemStep(m, calls[0])),
      ...entries.map((e) => e[4]),
    ].map((step, i) => ({ step_id: i + 1, ...step }));
    const document = this.document(
      scope,
      steps,
      calls,
      defaultTools,
      defs,
      totals,
      subTrajectories,
    );
    return [document, totals];
  }

  /** The TOOL span in `scope` that started subagent `child`, if any. */
  private spawner(child: string, scope: string | null): Span | null {
    const span = this.byId.get(child)!;
    if (this.boundaries.get(child) === "implicit") {
      return span;
    }
    let node = span.parent;
    while (node !== null && node.id !== scope) {
      if (node.isTool) {
        return node;
      }
      node = node.parent;
    }
    return null;
  }

  private systemStep(message: Message, firstCall: Call): JsonObject {
    const lmnr: JsonObject = { source_span_id: firstCall.span.id };
    if (get(message, "role") === "developer") {
      lmnr.role = "developer";
    }
    return {
      timestamp: formatTime(firstCall.span.start),
      source: "system",
      message: or(get(message, "content"), ""),
      extra: { lmnr },
    };
  }

  /** TOOL spans that executed each LLM call's tool calls, by (call, id). */
  private matchTools(calls: Call[], toolSpans: Span[]): Matched {
    const matched: Matched = new Map();
    const used = new Set<string>();
    const windows: Span[][] = [];
    calls.forEach((call, k) => {
      // A call's tools start after it does, and before the next call that
      // started after it ended (and so could have seen their results). Calls
      // running at the same time (fan-out) don't cut the window.
      const windowEnd =
        calls.slice(k + 1).find((c) => c.span.start >= call.span.end)?.span
          .start ?? null;
      windows.push(
        toolSpans.filter(
          (s) =>
            s.start >= call.span.start &&
            (windowEnd === null || s.start < windowEnd),
        ),
      );
    });
    // By call id (exact, so not limited to the window), then by name and
    // arguments, then by name alone. Each strategy runs over every call
    // before the next, weaker one, so a name-only match can't take a span
    // that a concurrent call matches more precisely.
    for (let strategy = 0; strategy < 3; strategy++) {
      calls.forEach((call, k) => {
        const window =
          strategy === 0
            ? toolSpans.filter((s) => s.start >= call.span.start)
            : windows[k];
        for (const tool of dicts(get(call.output ?? {}, "tool_calls"))) {
          const key = pair(k, pyStr(get(tool, "tool_call_id")));
          if (matched.has(key)) {
            continue;
          }
          const span = window.find(
            (s) => !used.has(s.id) && toolMatches(strategy, s, tool),
          );
          if (span !== undefined) {
            matched.set(key, [span, tool]);
            used.add(span.id);
          }
        }
      });
    }
    return matched;
  }

  private spanExtra(span: Span): JsonObject {
    const extra: JsonObject = { span_id: span.id };
    if (this.multiTrace) {
      extra.trace_id = span.record.trace_id;
    }
    return extra;
  }

  private toolOutput(span: Span): string {
    const value = span.jsonAttr("lmnr.span.output");
    if (isNone(value)) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return pyJsonDumps(value);
  }

  private resultExtra(
    span: Span | null,
    fromInput: Message | null,
  ): JsonObject {
    if (span !== null) {
      if (truthy(span.record.error)) {
        return { status: "error", error: toError(span.record.error) };
      }
      return { status: "ok" };
    }
    if (fromInput !== null && truthy(get(fromInput, "_is_error"))) {
      return { status: "error", error: { type: "ToolError", message: "" } };
    }
    return {};
  }

  private refs(
    children: string[],
    subTrajectories: Map<string, JsonObject>,
  ): JsonObject[] {
    return children.map((child) => ({
      trajectory_id: subTrajectories.get(child)!.trajectory_id,
      extra: { lmnr: { span_id: child } },
    }));
  }

  private agentStep(
    call: Call,
    k: number,
    overrides: JsonObject,
    matched: Matched,
    resultsFromInput: Map<string, Message>,
    refsByCall: Map<string, string[]>,
    subTrajectories: Map<string, JsonObject>,
  ): [JsonObject, Totals] {
    const [span, attrs] = [call.span, call.span.attrs];
    const totals = new Totals(1);
    totals.addTime(span.start, span.end);
    const output = call.output ?? {};
    const step: JsonObject = {
      timestamp: formatTime(span.end),
      source: "agent",
    };
    const model = or(
      get(attrs, "gen_ai.response.model"),
      get(attrs, "gen_ai.request.model"),
    );
    if (typeof model === "string" && model) {
      step.model_name = model;
    }
    const effort = get(attrs, "gen_ai.request.reasoning_effort");
    if (typeof effort === "string" || typeof effort === "number") {
      step.reasoning_effort = effort;
    }
    step.message = or(get(output, "content"), "");
    if (truthy(get(output, "reasoning_content"))) {
      step.reasoning_content = output.reasoning_content;
    }

    const toolCalls: JsonObject[] = [];
    const results: JsonObject[] = [];
    for (const tool of dicts(get(output, "tool_calls"))) {
      const callId = pyStr(get(tool, "tool_call_id"));
      const entry: JsonObject = { ...tool };
      const lmnr: JsonObject = {
        ...asDict(get(asDict(get(tool, "extra")), "lmnr")),
      };
      const toolSpan = matched.get(pair(k, callId))?.[0] ?? null;
      if (toolSpan !== null) {
        lmnr.span_id = toolSpan.id;
        lmnr.start_time = formatTime(toolSpan.start);
        lmnr.end_time = formatTime(toolSpan.end);
      }
      if (truthy(lmnr)) {
        entry.extra = { lmnr };
      }
      toolCalls.push(entry);
      totals.toolCalls += 1;

      const fromInput = resultsFromInput.get(pair(k, callId)) ?? null;
      const refs = refsByCall.get(pair(k, callId)) ?? [];
      if (fromInput === null && toolSpan === null && refs.length === 0) {
        continue;
      }
      const result: JsonObject = { source_call_id: callId };
      if (fromInput !== null) {
        result.content = or(get(fromInput, "content"), "");
      } else if (toolSpan !== null) {
        result.content = this.toolOutput(toolSpan);
      } else {
        result.content = finalMessage(subTrajectories.get(refs[0])!);
      }
      if (refs.length > 0) {
        result.subagent_trajectory_ref = this.refs(refs, subTrajectories);
      }
      const resultExtra = this.resultExtra(toolSpan, fromInput);
      if (truthy(resultExtra)) {
        result.extra = { lmnr: resultExtra };
        if (resultExtra.status === "error") {
          totals.errors += 1;
        }
      }
      results.push(result);
    }
    if (toolCalls.length > 0) {
      step.tool_calls = toolCalls;
    }
    if (results.length > 0) {
      step.observation = { results };
    }

    const metrics: JsonObject = {};
    for (const [key, attribute] of [
      ["prompt_tokens", "gen_ai.usage.input_tokens"],
      ["completion_tokens", "gen_ai.usage.output_tokens"],
      ["cached_tokens", "gen_ai.usage.cache_read_input_tokens"],
    ]) {
      const value = number(get(attrs, attribute));
      if (value !== null) {
        metrics[key] = Math.trunc(value);
      }
    }
    const inputCost = number(get(attrs, "gen_ai.usage.input_cost"));
    const outputCost = number(get(attrs, "gen_ai.usage.output_cost"));
    let cost = number(get(attrs, "gen_ai.usage.cost"));
    if (cost === null && inputCost !== null && outputCost !== null) {
      cost = inputCost + outputCost;
    }
    if (cost !== null) {
      metrics.cost_usd = cost;
      totals.addCost(cost);
    }
    const metricsExtra: JsonObject = {};
    for (const [key, attribute] of [
      ["reasoning_tokens", "gen_ai.usage.reasoning_tokens"],
      ["cache_creation_tokens", "gen_ai.usage.cache_creation_input_tokens"],
    ]) {
      const value = number(get(attrs, attribute));
      if (value !== null && value > 0) {
        metricsExtra[key] = Math.trunc(value);
      }
    }
    if (inputCost !== null) {
      metricsExtra.input_cost_usd = inputCost;
    }
    if (outputCost !== null) {
      metricsExtra.output_cost_usd = outputCost;
    }
    if (truthy(metricsExtra)) {
      metrics.extra = { lmnr: metricsExtra };
    }
    if (truthy(metrics)) {
      step.metrics = metrics;
    }
    step.llm_call_count = 1;

    const lmnrStep: JsonObject = {
      ...this.spanExtra(span),
      start_time: formatTime(span.start),
      end_time: formatTime(span.end),
    };
    const provider = or(
      get(attrs, "gen_ai.provider.name"),
      get(attrs, "gen_ai.system"),
    );
    if (typeof provider === "string" && provider) {
      lmnrStep.provider = provider;
    }
    const prefix = "gen_ai.request.";
    const request = Object.entries(attrs)
      .filter(
        ([key, value]) =>
          key.startsWith(prefix) &&
          !NOT_REQUEST_PARAMS.has(key.slice(prefix.length)) &&
          !pyIn(value, [null, "", []]),
      )
      .map(([key, value]): [string, unknown] => [
        key.slice(prefix.length),
        key.endsWith("_schema") ? jsonAttribute(value) : value,
      ]);
    if (request.length > 0) {
      lmnrStep.request = Object.fromEntries(
        request.sort(([a], [b]) => compareCodePoints(a, b)),
      );
    }
    if (truthy(call.finishReason)) {
      lmnrStep.finish_reason = call.finishReason;
    }
    if (typeof get(attrs, "gen_ai.response.id") === "string") {
      lmnrStep.response_id = attrs["gen_ai.response.id"];
    }
    if (truthy(span.record.error)) {
      lmnrStep.status = "error";
      lmnrStep.error = toError(span.record.error);
      totals.errors += 1;
    } else {
      lmnrStep.status = "ok";
    }
    Object.assign(lmnrStep, overrides);
    step.extra = { lmnr: lmnrStep };
    return [step, totals];
  }

  private syntheticToolStep(
    span: Span,
    children: string[],
    subTrajectories: Map<string, JsonObject>,
  ): [JsonObject, Totals] {
    const totals = new Totals(0, 1);
    totals.addTime(span.start, span.end);
    const callId = `lmnr-${span.id}`;
    const args = span.jsonAttr("lmnr.span.input");
    const call = toolCall(callId, span.record.name || "tool", args, true);
    Object.assign(call.extra.lmnr, {
      span_id: span.id,
      start_time: formatTime(span.start),
      end_time: formatTime(span.end),
    });
    const result: JsonObject = {
      source_call_id: callId,
      content: this.toolOutput(span),
    };
    if (children.length > 0) {
      result.subagent_trajectory_ref = this.refs(children, subTrajectories);
    }
    result.extra = { lmnr: this.resultExtra(span, null) };
    if (truthy(span.record.error)) {
      totals.errors += 1;
    }
    return [this.syntheticStep(span, call, result), totals];
  }

  private syntheticAgentStep(span: Span, sub: JsonObject): JsonObject {
    const callId = `lmnr-${span.id}`;
    const args = span.jsonAttr("lmnr.span.input");
    const name = span.agentMarker || span.record.name || "subagent";
    const call = toolCall(callId, name, isDict(args) ? args : {}, true);
    Object.assign(call.extra.lmnr, {
      span_id: span.id,
      start_time: formatTime(span.start),
      end_time: formatTime(span.end),
    });
    const result = {
      source_call_id: callId,
      content: finalMessage(sub),
      subagent_trajectory_ref: this.refs([span.id], new Map([[span.id, sub]])),
      extra: truthy(span.record.error)
        ? { lmnr: { status: "error", error: toError(span.record.error) } }
        : { lmnr: { status: "ok" } },
    };
    return this.syntheticStep(span, call, result);
  }

  private syntheticStep(
    span: Span,
    call: JsonObject,
    result: JsonObject,
  ): JsonObject {
    return {
      timestamp: formatTime(span.end),
      source: "agent",
      message: "",
      tool_calls: [call],
      observation: { results: [result] },
      llm_call_count: 0,
      extra: {
        lmnr: {
          synthetic: true,
          ...this.spanExtra(span),
          start_time: formatTime(span.start),
          end_time: formatTime(span.end),
        },
      },
    };
  }

  private document(
    scope: string | null,
    steps: JsonObject[],
    calls: Call[],
    defaultTools: JsonObject[],
    defs: Record<string, JsonObject>,
    totals: Totals,
    subTrajectories: Map<string, JsonObject>,
  ): JsonObject {
    const boundary = this.spans.find((s) => s.id === scope) ?? null;
    let name: string | null;
    if (boundary === null) {
      name = this.roots.length > 0 ? this.roots[0].record.name : "agent";
    } else if (this.boundaries.get(boundary.id) === "agent") {
      name = boundary.agentMarker || boundary.record.name;
    } else {
      name = boundary.record.name;
    }
    const agent: JsonObject = { name: name || "agent", version: this.release };
    const models = counter(
      calls
        .filter((c) => modelOf(c.span))
        .map((c) =>
          [providerOf(c.span), modelOf(c.span)].filter((p) => p).join("/"),
        ),
    );
    if (models.size > 0) {
      const best = Math.max(...models.values());
      agent.model_name = [...models.keys()].find((m) => models.get(m) === best);
    }
    if (defaultTools.length > 0) {
      agent.tool_definitions = defaultTools;
    }

    const document: JsonObject = { schema_version: ATIF_SCHEMA_VERSION };
    const session =
      this.sessionId || (this.traceIds.length > 0 ? this.traceIds[0] : null);
    if (session) {
      document.session_id = session;
    }
    if (boundary !== null) {
      document.trajectory_id = `lmnr-${boundary.id}`;
    } else if (!this.multiTrace && this.traceIds.length > 0) {
      document.trajectory_id = this.traceIds[0];
    }
    document.agent = agent;
    document.steps = steps;

    const ownSteps = steps.filter((s) => get(s, "source") === "agent");
    const final: JsonObject = {};
    for (const [key, metric] of [
      ["total_prompt_tokens", "prompt_tokens"],
      ["total_completion_tokens", "completion_tokens"],
      ["total_cached_tokens", "cached_tokens"],
    ]) {
      const values = ownSteps
        .filter((s) => has(asDict(get(s, "metrics")), metric))
        .map((s) => s.metrics[metric] as number);
      if (values.length > 0) {
        final[key] = values.reduce((a, b) => a + b, 0);
      }
    }
    // ATIF defines token totals over this trajectory's steps, but
    // `total_cost_usd` as including subagents, so only the cost is merged.
    if (totals.cost !== null) {
      final.total_cost_usd = pyRound(totals.cost, 10);
    }
    final.total_steps = steps.length;
    const finalExtra: JsonObject = {};
    if (totals.start !== null && totals.end !== null) {
      finalExtra.duration_ms = pyRound((totals.end - totals.start) / 1000, 3);
    }
    Object.assign(finalExtra, {
      llm_calls: totals.llmCalls,
      tool_calls: totals.toolCalls,
      errors: totals.errors,
    });
    final.extra = { lmnr: finalExtra };
    document.final_metrics = final;

    const lmnr: JsonObject = { spec_version: SPEC_VERSION };
    if (boundary === null) {
      lmnr.producer = { ...this.options.producer };
      lmnr.trace_ids = [...this.traceIds];
      if (!this.multiTrace && this.roots.length > 0) {
        lmnr.root_span_id = this.roots[0].id;
      }
      if (this.options.projectId) {
        lmnr.project_id = this.options.projectId;
      }
      lmnr.exported = this.options.exported;
      lmnr.complete = this.options.complete;
    } else {
      lmnr.agent_span_id = boundary.id;
      if (this.boundaries.get(boundary.id) === "implicit") {
        lmnr.implicit_subagent = true;
      }
    }
    if (Object.keys(defs).length > 0) {
      lmnr.defs = Object.fromEntries(
        Object.keys(defs)
          .sort(compareCodePoints)
          .map((kind) => [
            kind,
            Object.fromEntries(
              Object.keys(defs[kind])
                .sort(compareCodePoints)
                .map((key) => [key, defs[kind][key]]),
            ),
          ]),
      );
    }
    document.extra = { lmnr };
    if (subTrajectories.size > 0) {
      document.subagent_trajectories = [...subTrajectories.values()];
    }
    return document;
  }
}

const toolMatches = (
  strategy: number,
  span: Span,
  tool: JsonObject,
): boolean => {
  if (strategy === 0) {
    return pyEquals(
      get(span.attrs, "gen_ai.tool.call.id"),
      get(tool, "tool_call_id"),
    );
  }
  if (span.record.name !== get(tool, "function_name")) {
    return false;
  }
  return (
    strategy === 2 ||
    pyEquals(span.jsonAttr("lmnr.span.input"), get(tool, "arguments"))
  );
};

const providerOf = (span: Span): string | null => {
  const value = or(
    get(span.attrs, "gen_ai.provider.name"),
    get(span.attrs, "gen_ai.system"),
  );
  return typeof value === "string" && value ? value : null;
};

const modelOf = (span: Span): string | null => {
  const value = or(
    get(span.attrs, "gen_ai.response.model"),
    get(span.attrs, "gen_ai.request.model"),
  );
  return typeof value === "string" && value ? value : null;
};

const toError = (value: unknown): SpanError => {
  const error = asDict(value);
  const result: SpanError = {
    type: pyStr(or(get(error, "type"), "Error")),
    message: pyStr(or(get(error, "message"), "")),
  };
  if (truthy(get(error, "stacktrace"))) {
    result.stacktrace = pyStr(error.stacktrace);
  }
  return result;
};

const finalMessage = (trajectory: JsonObject): string => {
  for (const step of dicts(get(trajectory, "steps")).reverse()) {
    if (get(step, "source") === "agent" && get(step, "llm_call_count") !== 0) {
      const text = contentText(get(step, "message"));
      if (text) {
        return text;
      }
    }
  }
  return "";
};

/** Build the trajectory for a set of finished spans, or null if they hold no
 * LLM or tool calls. */
export const buildTrajectory = (
  records: Iterable<SpanRecord>,
  options: BuildOptions = {},
): JsonObject | null =>
  new Builder([...records], {
    producer: options.producer ?? DEFAULT_PRODUCER,
    release: options.release ?? null,
    projectId: options.projectId ?? null,
    exported: options.exported ?? false,
    complete: options.complete ?? true,
    media: options.media ?? null,
  }).build();
