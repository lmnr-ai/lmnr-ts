/**
 * Read lmnr-atif fields (`spec/lmnr-atif/lmnr-atif.md`) from an ATIF
 * trajectory.
 *
 * Works on plain objects (the parsed JSON file), so it depends on neither
 * Harbor nor the tracing stack. Every helper takes the trajectory's
 * `TrajectoryExtension`, or null for a plain ATIF file, and falls back to what
 * plain ATIF says when there is no compatible extension. That makes this
 * module the single place that decides whether `extra.lmnr` can be trusted.
 *
 * Messages returned here are `LmnrMessage` objects (spec §3): `role`,
 * `content` (a string or ATIF content parts), plus `reasoning_content` /
 * `tool_calls` on assistant messages and `tool_call_id` on tool messages.
 * Tool calls keep ATIF's shape.
 *
 * Line-comparable port of the Python SDK's `lmnr/sdk/trajectory/reader.py`.
 */

import { logger } from "./log";
import {
  get,
  has,
  isDict,
  isNone,
  JsonObject,
  or,
  pyEquals,
  pyStr,
  truthy,
} from "./py";
import { DefKind, MIN_ATIF_VERSION, NAMESPACE, SPEC_VERSION } from "./spec";

export type Message = JsonObject;

// Python's `$` also matches before a trailing newline.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\n?$/;
const ATIF_VERSION = /^ATIF-v(\d+)\.(\d+)\n?$/;

// Spec versions already reported as unreadable, so each is logged once.
const reportedVersions = new Set<string>();

/** `value` if it is a JSON object, else {}. */
export const asDict = (value: unknown): JsonObject =>
  isDict(value) ? value : {};

/** The JSON objects in `value` if it is a list, else []. */
export const dicts = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter(isDict) : [];

/** `obj["extra"]["lmnr"]` as an object, or {} when absent or malformed. */
const lmnrExtra = (obj: unknown): JsonObject =>
  asDict(get(asDict(get(asDict(obj), "extra")), NAMESPACE));

const parseSpecVersion = (value: unknown): [number, number, number] | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = SEMVER.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Whether a reader of `reference` can read a file of `version` (spec §2).
 *
 * Same major version and, while the major is 0, the same minor version.
 */
export const isCompatible = (
  version: unknown,
  reference: string = SPEC_VERSION,
): boolean => {
  const ours = parseSpecVersion(reference);
  const theirs = parseSpecVersion(version);
  if (ours === null || theirs === null || ours[0] !== theirs[0]) {
    return false;
  }
  return ours[0] !== 0 || ours[1] === theirs[1];
};

const atifVersionOk = (trajectory: JsonObject): boolean => {
  const value = get(trajectory, "schema_version");
  if (isNone(value)) {
    // Harbor's model defaults a missing schema_version to the latest.
    return true;
  }
  const match = typeof value === "string" ? ATIF_VERSION.exec(value) : null;
  if (match === null) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return (
    major > MIN_ATIF_VERSION[0] ||
    (major === MIN_ATIF_VERSION[0] && minor >= MIN_ATIF_VERSION[1])
  );
};

/**
 * The lmnr-atif fields of one trajectory document.
 *
 * Build it with `read`, which returns null for plain ATIF. Embedded or
 * file-referenced subagents pass their parent, which they inherit a missing
 * `spec_version` from and resolve `$ref`s against when their own `defs`
 * don't have the key (spec §6.6).
 */
export class TrajectoryExtension {
  constructor(
    public readonly fields: JsonObject,
    public readonly specVersion: string,
    public readonly parent: TrajectoryExtension | null = null,
  ) {}

  static read(
    trajectory: unknown,
    parent: TrajectoryExtension | null = null,
  ): TrajectoryExtension | null {
    if (!isDict(trajectory)) {
      return null;
    }
    const fields = lmnrExtra(trajectory);
    if (!truthy(fields) && parent === null) {
      return null;
    }
    let version = get(fields, "spec_version");
    if (isNone(version) && parent !== null) {
      version = parent.specVersion;
    }
    if (!isCompatible(version)) {
      if (typeof version === "string" && !reportedVersions.has(version)) {
        reportedVersions.add(version);
        logger.info(
          `Ignoring Laminar fields of an lmnr-atif ${version} trajectory: ` +
            `this SDK reads lmnr-atif ${SPEC_VERSION}`,
        );
      }
      return null;
    }
    if (!atifVersionOk(trajectory)) {
      return null;
    }
    return new TrajectoryExtension(fields, pyStr(version), parent);
  }

  /**
   * Resolve an override value, following a `{"$ref": key}` into `defs`.
   *
   * Returns undefined when the override is absent or its `$ref` doesn't
   * resolve, which readers treat the same way.
   */
  resolve(value: unknown, kind: DefKind): any {
    const ref = get(asDict(value), "$ref");
    if (isNone(ref)) {
      return value;
    }
    let ext: TrajectoryExtension | null = this;
    while (ext !== null) {
      const table = asDict(get(asDict(get(ext.fields, "defs")), kind));
      if (typeof ref === "string" && has(table, ref)) {
        return table[ref];
      }
      ext = ext.parent;
    }
    logger.debug(
      `Unresolved ${kind} $ref ${JSON.stringify(ref)} in trajectory`,
    );
    return undefined;
  }

  /** A step's resolved `extra.lmnr.<key>` override, or undefined if absent. */
  override(step: JsonObject, key: string, kind: DefKind): any {
    return this.resolve(get(lmnrExtra(step), key), kind);
  }
}

/** `obj.extra.lmnr`, but only when the trajectory's extension is readable. */
export const fields = (
  obj: unknown,
  ext: TrajectoryExtension | null,
): JsonObject => (ext !== null ? lmnrExtra(obj) : {});

export const stepsOf = (trajectory: JsonObject): JsonObject[] =>
  dicts(get(trajectory, "steps"));

/** Number of `system` steps before the first `user` or `agent` step. */
export const leadingSystemCount = (steps: JsonObject[]): number => {
  let count = 0;
  for (const step of steps) {
    if (get(step, "source") !== "system") {
      break;
    }
    count += 1;
  }
  return count;
};

const messageContent = (value: unknown): any => (isNone(value) ? "" : value);

const systemMessage = (
  step: JsonObject,
  ext: TrajectoryExtension | null,
): Message => {
  const role = get(fields(step, ext), "role");
  return {
    role: typeof role === "string" && role ? role : "system",
    content: messageContent(get(step, "message")),
  };
};

/** System messages agent step `index` was configured with (spec §6.3). */
export const systemPrompt = (
  steps: JsonObject[],
  index: number,
  ext: TrajectoryExtension | null,
): Message[] => {
  const override = ext
    ? ext.override(steps[index], "system_prompt", "system_prompts")
    : undefined;
  if (!isNone(override)) {
    if (pyEquals(override, "") || pyEquals(override, [])) {
      return [];
    }
    return [{ role: "system", content: override }];
  }
  return steps
    .slice(0, leadingSystemCount(steps))
    .map((s) => systemMessage(s, ext));
};

/** Tools offered to an agent step (spec §6.5); null when unknown. */
export const toolDefinitions = (
  trajectory: JsonObject,
  step: JsonObject,
  ext: TrajectoryExtension | null,
): JsonObject[] | null => {
  const override = ext
    ? ext.override(step, "tool_definitions", "tool_definitions")
    : undefined;
  if (Array.isArray(override)) {
    return dicts(override);
  }
  const fallback = get(asDict(get(trajectory, "agent")), "tool_definitions");
  return Array.isArray(fallback) ? dicts(fallback) : null;
};

export const isSynthetic = (
  step: JsonObject,
  ext: TrajectoryExtension | null,
): boolean => get(fields(step, ext), "synthetic") === true;

export const observationResults = (step: JsonObject): JsonObject[] =>
  dicts(get(asDict(get(step, "observation")), "results"));

/** Messages a step adds to the conversation (spec §6.4). */
export const stepMessages = (
  step: JsonObject,
  ext: TrajectoryExtension | null,
): Message[] => {
  const source = get(step, "source");
  if (source === "system") {
    return [systemMessage(step, ext)];
  }
  if (source !== "agent") {
    return [{ role: "user", content: messageContent(get(step, "message")) }];
  }
  if (isSynthetic(step, ext)) {
    return [];
  }

  const assistant: Message = {
    role: "assistant",
    content: messageContent(get(step, "message")),
  };
  if (truthy(get(step, "reasoning_content"))) {
    assistant.reasoning_content = step.reasoning_content;
  }
  const toolCalls = dicts(get(step, "tool_calls"));
  if (toolCalls.length > 0) {
    assistant.tool_calls = toolCalls;
  }
  const messages = [assistant];
  for (const result of observationResults(step)) {
    const content = messageContent(get(result, "content"));
    if (truthy(get(result, "source_call_id"))) {
      messages.push({
        role: "tool",
        tool_call_id: result.source_call_id,
        content,
      });
    } else {
      messages.push({ role: "user", content });
    }
  }
  return messages;
};

/**
 * The full input of agent step `index`: system prompt, then conversation.
 *
 * The conversation is the step's own `input_messages` override, or the latest
 * earlier override plus every step since, or the whole history (spec §6.4).
 */
export const inputMessages = (
  steps: JsonObject[],
  index: number,
  ext: TrajectoryExtension | null,
): Message[] => {
  const prompt = systemPrompt(steps, index, ext);
  let start = leadingSystemCount(steps);
  let history: Message[] = [];
  if (ext !== null) {
    for (let j = index; j > start - 1; j--) {
      if (get(steps[j], "source") !== "agent") {
        continue;
      }
      const override = ext.override(
        steps[j],
        "input_messages",
        "input_messages",
      );
      if (Array.isArray(override)) {
        if (j === index) {
          return [...prompt, ...dicts(override).map((m) => ({ ...m }))];
        }
        history = dicts(override).map((m) => ({ ...m }));
        start = j;
        break;
      }
    }
  }
  history = [
    ...history,
    ...steps.slice(start, index).flatMap((step) => stepMessages(step, ext)),
  ];
  return [...prompt, ...history];
};

const toError = (value: unknown): Record<string, string> => {
  const error = asDict(value);
  const result: Record<string, string> = {
    type: pyStr(or(get(error, "type"), "Error")),
    message: pyStr(or(get(error, "message"), "")),
  };
  if (truthy(get(error, "stacktrace"))) {
    result.stacktrace = pyStr(error.stacktrace);
  }
  return result;
};

/** `{type, message[, stacktrace]}` if the step's LLM call failed, else null. */
export const stepError = (
  step: JsonObject,
  ext: TrajectoryExtension | null,
): Record<string, string> | null => {
  const lmnr = fields(step, ext);
  if (get(lmnr, "status") !== "error") {
    return null;
  }
  return toError(get(lmnr, "error"));
};

/**
 * `{type, message[, stacktrace]}` if a tool call failed, else null (spec §7).
 *
 * Also understands the flags Harbor's own agents write, so it works on plain
 * ATIF from claude-code (`tool_result_is_error`) and kimi (`is_error`).
 */
export const resultError = (
  result: JsonObject,
  ext: TrajectoryExtension | null,
): Record<string, string> | null => {
  const lmnr = fields(result, ext);
  const status = get(lmnr, "status");
  if (status === "error") {
    return toError(get(lmnr, "error"));
  }
  if (status === "ok") {
    return null;
  }
  const extra = asDict(get(result, "extra"));
  if (
    get(extra, "tool_result_is_error") === true ||
    get(extra, "is_error") === true
  ) {
    return { type: "ToolError", message: "" };
  }
  return null;
};

/**
 * Usage fields without an ATIF core field (spec §4.7), with fallbacks.
 *
 * Keys: `reasoning_tokens`, `cache_creation_tokens`, `input_cost_usd`,
 * `output_cost_usd`. Only present ones are returned.
 */
export const usageExtension = (
  metrics: unknown,
  ext: TrajectoryExtension | null,
): Record<string, number> => {
  const bare = asDict(get(asDict(metrics), "extra"));
  const lmnr = fields(metrics, ext);
  const candidates: [string, unknown[]][] = [
    [
      "reasoning_tokens",
      [get(lmnr, "reasoning_tokens"), get(bare, "reasoning_tokens")],
    ],
    [
      "cache_creation_tokens",
      [
        get(lmnr, "cache_creation_tokens"),
        get(bare, "cache_creation_input_tokens"),
      ],
    ],
    ["input_cost_usd", [get(lmnr, "input_cost_usd")]],
    ["output_cost_usd", [get(lmnr, "output_cost_usd")]],
  ];
  const usage: Record<string, number> = {};
  for (const [key, values] of candidates) {
    for (const value of values) {
      if (typeof value === "number") {
        usage[key] = value;
        break;
      }
    }
  }
  return usage;
};
