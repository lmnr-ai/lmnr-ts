import { errorMessage } from "@lmnr-ai/types";
import {
  AttributeValue,
  Context,
  context as contextApi,
  Span,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";

import { version as SDK_VERSION } from "../../../../package.json";
import {
  initializeLogger,
  normalizeOtelSpanId,
  normalizeOtelTraceId,
  otelSpanIdToUUID,
} from "../../../utils";
import { getLangVersion } from "../../../version";
import {
  ASSOCIATION_PROPERTIES,
  LaminarAttributes,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INPUT,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_OUTPUT,
  SPAN_PATH,
  SPAN_SDK_VERSION,
  SPAN_TYPE,
  USER_ID,
} from "../../tracing/attributes";
import { LaminarContextManager } from "../../tracing/context";
import { getSpanProcessor, getTracerProvider } from "../../tracing/index";
import {
  BraintrustBridgeOptions,
  BraintrustLogInternalArgs,
  BraintrustLogPartial,
  BraintrustSpanLike,
} from "./types";
import {
  extractLlmMetadata,
  extractSpanName,
  formatMetrics,
  mapBraintrustSpanType,
  mergeLogPartial,
  serializeJSON,
  toAttributeValue,
  unixSecondsToHrTime,
} from "./utils";

const logger = initializeLogger();

// Module-level state so the bridge is idempotent — repeated
// `wrapBraintrust(...)` calls (e.g. hot-reload, multiple `initLogger()`
// invocations) don't re-wrap prototype methods. Guarded by a symbol key so
// it survives even if a second copy of the module is loaded.
const PATCHED_KEY = Symbol.for("lmnr.braintrust.bridge.patched");
// Per-SpanImpl-instance companion OTel span + accumulated log data.
const COMPANION_KEY = Symbol.for("lmnr.braintrust.bridge.companion");

interface CompanionState {
  otelSpan: Span;
  // Accumulated log data from every `span.log(...)` call + initial construct
  // event. Folded together at end-time into a single attribute set.
  accumulated: BraintrustLogPartial;
  // Mastra-style path info written once in onStart and re-applied at end to
  // survive any upstream setAttribute overwrite. Keyed for cleanup at end.
  spanPath: string[];
  spanIdsPath: string[];
  // When the creating call was inside a parent Braintrust span (spanParents
  // non-empty), we resolve that parent to its companion at construct time
  // and reuse its path. Null means Braintrust root ⇒ link to caller's outer
  // Laminar/OTel span if any.
  parentCompanion: CompanionState | null;
}

// Per-rootSpanId state — lets us register Braintrust-id → companion and
// resolve parentSpanIds → OTel span for nesting.
interface RootState {
  // Key: Braintrust span id (the short base58 id).
  companionBySpanId: Map<string, CompanionState>;
  // Outer span context captured at first-span-start time, for linking.
  outerTraceId?: string;
  outerSpanId?: string;
  outerSpanPath?: string[];
  outerSpanIdsPath?: string[];
}

// Keyed by Braintrust rootSpanId. Kept at module level so multiple
// wrapped Braintrust spans across a process share a single picture of the
// trace tree — matches how Braintrust itself tracks rootSpanId globally.
const rootStateByRootSpanId: Map<string, RootState> = new Map();

// Resolve-OTel-span-for-attribute helper. LaminarSpan is our wrapper around
// the SDK span; access the underlying attributes map via the `attributes`
// getter that exists on both OTel v1 ReadableSpan and our LaminarSpan.
const readAttributeArray = (
  span: Span | undefined,
  key: string,
): string[] | undefined => {
  if (!span) return undefined;
  const attrs = (span as unknown as { attributes?: Record<string, unknown> })
    .attributes;
  if (!attrs) return undefined;
  const value = attrs[key];
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
    return value;
  }
  return undefined;
};

let bridgeOptions: Required<BraintrustBridgeOptions> = {
  realtime: false,
  linkToActiveContext: true,
};

/**
 * Patch Braintrust's `SpanImpl` prototype so every span it creates — via
 * `logger.traced`, `wrapOpenAI`, `wrapAISDK`, `wrapAnthropic`, or manual
 * `span.startSpan(...)` — also flows into Laminar's OTel pipeline.
 *
 * Idempotent. Pass the module/object that exports `SpanImpl`; if the caller
 * doesn't have it handy they can pass a `Logger` (which exposes `.startSpan`
 * on its prototype chain — we walk up to find `SpanImpl`). In practice the
 * cleanest path is to import `{ SpanImpl }` from `braintrust` and pass that.
 */
export const installBraintrustBridge = (
  ctx: {
    // One of these three — whichever the user can most easily get.

    SpanImpl?: any;

    logger?: any;

    braintrust?: any;
  },
  options: BraintrustBridgeOptions = {},
): void => {
  const SpanImpl = resolveSpanImpl(ctx);
  if (!SpanImpl) {
    logger.warn(
      "[Laminar.wrapBraintrust] Could not locate braintrust's SpanImpl. " +
        "Import `SpanImpl` from `braintrust` and pass it explicitly, " +
        "e.g. `Laminar.wrapBraintrust({ SpanImpl })`.",
    );
    return;
  }


  if (SpanImpl.prototype[PATCHED_KEY]) return;

  // Only latch options on the first successful install — repeat calls are
  // no-ops and must not silently mutate the already-active configuration.
  bridgeOptions = {
    realtime: options.realtime ?? false,
    linkToActiveContext: options.linkToActiveContext ?? true,
  };

  SpanImpl.prototype[PATCHED_KEY] = true;


  const originalLogInternal = SpanImpl.prototype.logInternal;
  if (typeof originalLogInternal !== "function") {
    logger.warn(
      "[Laminar.wrapBraintrust] braintrust's SpanImpl.prototype.logInternal " +
        "is not a function — Braintrust internals may have changed. " +
        "Skipping bridge install.",
    );

    SpanImpl.prototype[PATCHED_KEY] = false;
    return;
  }


  SpanImpl.prototype.logInternal = function patchedLogInternal(
    this: BraintrustSpanLike,
    args: BraintrustLogInternalArgs,
  ): unknown {
    // Call the original first so Braintrust's own bookkeeping
    // (loggedEndTime, spanCache queueing, bgLogger) happens exactly as
    // before — we are purely a side-channel observer.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const retval: unknown = originalLogInternal.call(this, args);
    try {
      handleLogInternal(this, args);
    } catch (err) {
      logger.error(
        `[Laminar.wrapBraintrust] failed on logInternal: ${errorMessage(err)}`,
      );
    }
    return retval;
  };
};

// Walk common locations to find the SpanImpl class reference.

const resolveSpanImpl = (ctx: any): any => {
  if (!ctx) return undefined;

  if (ctx.SpanImpl?.prototype) return ctx.SpanImpl;

  if (ctx.braintrust?.SpanImpl?.prototype) return ctx.braintrust.SpanImpl;
  // Caller passed a Logger instance: walk up its prototype chain looking for
  // `startSpan` and then peek at what `startSpan` returns. Braintrust's
  // `Logger.prototype.startSpan` in turn calls `new SpanImpl(...)` — we can't
  // extract the class without actually invoking it, which is too invasive.
  // So we also accept `ctx.logger` as a nudge: if it has a `_state` we can
  // read `state.spanImplClass` — Braintrust doesn't expose it, so in practice
  // users pass the class directly.
  return undefined;
};

const handleLogInternal = (
  span: BraintrustSpanLike,
  args: BraintrustLogInternalArgs,
): void => {
  // Ignore non-real spans (NoopSpan etc.) — they don't have the fields we
  // need and they're intentionally skipped by Braintrust itself.
  if (!span.kind || span.kind !== "span") return;
  if (!span.id || !span.spanId) return;

  const holder = span as unknown as Record<symbol, CompanionState | undefined>;
  const existing = holder[COMPANION_KEY];

  // Fold `event` + `internalData` through `mergeLogPartial` rather than a
  // shallow spread: both sides can carry `metadata` / `metrics` /
  // `span_attributes`, and a shallow spread silently drops the event-side
  // map when the same top-level key is present on both.
  const event: BraintrustLogPartial = {};
  if (args.event) mergeLogPartial(event, args.event);
  if (args.internalData) mergeLogPartial(event, args.internalData);

  // End detection: Braintrust's `SpanImpl.end(...)` sends the end marker
  // via `internalData.metrics.end`. A user call to
  // `span.log({ metrics: { end: ... } })` instead routes through
  // `args.event.metrics.end`. Read from the merged `event` above so either
  // path finalizes the companion span.
  const endTime =
    typeof event.metrics?.end === "number" ? event.metrics.end : undefined;

  if (!existing) {
    // First event for this SpanImpl — this is the constructor-driven
    // `logInternal` call. Spin up the companion OTel span.
    const companion = createCompanion(span, event);
    if (!companion) return;
    holder[COMPANION_KEY] = companion;
    // If Braintrust called `log` and `end` in the same event (uncommon but
    // possible for zero-duration callers), fall through to finalize.
    if (endTime !== undefined) {
      finalizeCompanion(span, companion, endTime);
      holder[COMPANION_KEY] = undefined;
    }
    return;
  }

  // Subsequent merge event on an existing span — accumulate and (maybe)
  // finalize.
  mergeLogPartial(existing.accumulated, event);

  if (endTime !== undefined) {
    finalizeCompanion(span, existing, endTime);
    holder[COMPANION_KEY] = undefined;
  }
};

const createCompanion = (
  span: BraintrustSpanLike,
  initialEvent: BraintrustLogPartial,
): CompanionState | null => {
  const rootState = getOrCreateRootState(span.rootSpanId);

  const accumulated: BraintrustLogPartial = {};
  mergeLogPartial(accumulated, initialEvent);

  const spanName = extractSpanName(accumulated.span_attributes);
  const startSecs =
    typeof accumulated.metrics?.start === "number"
      ? (accumulated.metrics.start)
      : Date.now() / 1000;

  // Resolve a parent Braintrust companion. `spanParents[0]` is the immediate
  // parent (see Braintrust SpanImpl._spanParents). If it doesn't exist yet
  // (out-of-order callbacks), we fall through to outer-context linking.
  const immediateParentId =
    span.spanParents && span.spanParents.length > 0
      ? span.spanParents[0]
      : undefined;
  const parentCompanion = immediateParentId
    ? rootState.companionBySpanId.get(immediateParentId) ?? null
    : null;

  const tracer = getTracerProvider().getTracer("@lmnr-ai/lmnr", SDK_VERSION);
  const parentCtx = buildParentContext(parentCompanion, rootState);

  const otelSpan = tracer.startSpan(
    spanName,
    {
      startTime: unixSecondsToHrTime(startSecs),
      kind: SpanKind.INTERNAL,
    },
    parentCtx,
  );

  if (!otelSpan.isRecording()) {
    warnNotInitializedOnce();
    return null;
  }

  // Stamp Braintrust-derived ids over the SDK-allocated ones so (a) every
  // Braintrust span under one root shares one OTel trace id (derived from
  // rootSpanId), and (b) the OTel span id matches Braintrust's `spanId`.
  // This keeps Braintrust's own ids navigable in Laminar's UI.
  const sdkSpanId = otelSpan.spanContext().spanId;
  const normalizedTraceId = rootState.outerTraceId ?? braintrustToOtelTraceId(
    span.rootSpanId,
  );
  const normalizedSpanId = braintrustToOtelSpanId(span.spanId);
  Object.assign(otelSpan.spanContext(), {
    traceId: normalizedTraceId,
    spanId: normalizedSpanId,
  });
  if (sdkSpanId !== normalizedSpanId) {
    getSpanProcessor()?.dropPathInfo(sdkSpanId);
  }

  // Patch parent reference fields (OTel SDK v1 alias + v2 context).
  const parentSpanIdNormalized = parentCompanion
    ? parentCompanion.otelSpan.spanContext().spanId
    : rootState.outerSpanId;
  if (parentSpanIdNormalized) {
    const parentSpanContext: SpanContext = {
      traceId: normalizedTraceId,
      spanId: parentSpanIdNormalized,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    Object.assign(otelSpan, {
      parentSpanId: parentSpanIdNormalized,
      parentSpanContext,
    });
  } else {
    Object.assign(otelSpan, {
      parentSpanId: undefined,
      parentSpanContext: undefined,
    });
  }

  // Rewrite the path attributes the processor's `onStart` stamped using the
  // SDK-allocated span id. Laminar's UI uses SPAN_IDS_PATH, not OTel
  // parent-links, so this is how the subtree ends up nested correctly.
  const spanUuid = otelSpanIdToUUID(normalizedSpanId);
  const parentSpanPath = parentCompanion?.spanPath ?? rootState.outerSpanPath;
  const parentSpanIdsPath =
    parentCompanion?.spanIdsPath ?? rootState.outerSpanIdsPath;
  const spanPath = parentSpanPath
    ? [...parentSpanPath, spanName]
    : [spanName];
  const spanIdsPath = parentSpanIdsPath
    ? [...parentSpanIdsPath, spanUuid]
    : [spanUuid];
  otelSpan.setAttribute(SPAN_PATH, spanPath);
  otelSpan.setAttribute(SPAN_IDS_PATH, spanIdsPath);

  const companion: CompanionState = {
    otelSpan,
    accumulated,
    spanPath,
    spanIdsPath,
    parentCompanion,
  };
  rootState.companionBySpanId.set(span.spanId, companion);
  return companion;
};

// Braintrust span ids are ~22-char base58 (ksuid-like) — hash them down to
// a deterministic 16-hex OTel span id so every Braintrust span under one
// rootSpanId nests under the same OTel trace, and sibling spans get distinct
// ids.
const braintrustToOtelSpanId = (bt: string): string => normalizeOtelSpanId(hashToHex(bt, 16));

const braintrustToOtelTraceId = (bt: string): string => normalizeOtelTraceId(hashToHex(bt, 32));

// FNV-1a 32-bit, repeated / mixed to reach `hexChars`. Not crypto — just a
// stable, collision-resistant-enough mapping for trace/span ids derived from
// Braintrust's own base58 ids. Avoids a `crypto` import to keep this module
// usable in edge runtimes.
const hashToHex = (input: string, hexChars: number): string => {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x9e3779b1) >>> 0;
  }
  let out = "";
  let x = a;
  let y = b;
  while (out.length < hexChars) {
    out += x.toString(16).padStart(8, "0");
    if (out.length >= hexChars) break;
    out += y.toString(16).padStart(8, "0");
    // Re-mix so the next round isn't just a repeat.
    x = Math.imul(x ^ (y + 0x9e3779b1), 0x85ebca6b) >>> 0;
    y = Math.imul(y ^ (x + 0xc2b2ae35), 0xcc9e2d51) >>> 0;
  }
  return out.slice(0, hexChars);
};

const getOrCreateRootState = (rootSpanId: string): RootState => {
  const existing = rootStateByRootSpanId.get(rootSpanId);
  if (existing) return existing;
  const created: RootState = {
    companionBySpanId: new Map(),
  };
  if (bridgeOptions.linkToActiveContext) {
    const activeSpan =
      trace.getSpan(LaminarContextManager.getContext()) ??
      trace.getActiveSpan();
    const ctx = activeSpan?.spanContext();
    if (ctx && ctx.traceId && ctx.spanId) {
      created.outerTraceId = normalizeOtelTraceId(ctx.traceId);
      created.outerSpanId = normalizeOtelSpanId(ctx.spanId);
      const parentPath = readAttributeArray(activeSpan, SPAN_PATH);
      if (parentPath) created.outerSpanPath = parentPath;
      const parentIdsPath = readAttributeArray(activeSpan, SPAN_IDS_PATH);
      if (parentIdsPath) created.outerSpanIdsPath = parentIdsPath;
    }
  }
  rootStateByRootSpanId.set(rootSpanId, created);
  return created;
};

const buildParentContext = (
  parentCompanion: CompanionState | null,
  rootState: RootState,
): Context => {
  const baseCtx =
    LaminarContextManager.getContext() ?? contextApi.active();
  if (parentCompanion) {
    return trace.setSpan(baseCtx, parentCompanion.otelSpan);
  }
  if (rootState.outerTraceId && rootState.outerSpanId) {
    const wrapped = trace.wrapSpanContext({
      traceId: rootState.outerTraceId,
      spanId: rootState.outerSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    return trace.setSpan(baseCtx, wrapped);
  }
  return baseCtx;
};

const finalizeCompanion = (
  span: BraintrustSpanLike,
  companion: CompanionState,
  endTimeSecs: number,
): void => {
  const { otelSpan, accumulated } = companion;
  try {
    applyEndAttributes(span, accumulated, companion);
    if (accumulated.error !== undefined) {
      const errString =
        typeof accumulated.error === "string"
          ? accumulated.error
          : errorMessage(accumulated.error);
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: errString });
    }
    otelSpan.end(unixSecondsToHrTime(endTimeSecs));
    if (bridgeOptions.realtime) {
      // Fire and forget — don't block Braintrust's end() on our flush.
      void getSpanProcessor()?.forceFlush();
    }
  } catch (err) {
    logger.error(
      `[Laminar.wrapBraintrust] finalize failed for span ${span.spanId}: ${errorMessage(err)}`,
    );
  } finally {
    const rootState = rootStateByRootSpanId.get(span.rootSpanId);
    if (rootState) {
      rootState.companionBySpanId.delete(span.spanId);
      if (rootState.companionBySpanId.size === 0) {
        rootStateByRootSpanId.delete(span.rootSpanId);
      }
    }
  }
};

const applyEndAttributes = (
  span: BraintrustSpanLike,
  accumulated: BraintrustLogPartial,
  companion: CompanionState,
): void => {
  const { otelSpan } = companion;
  const spanAttributes = accumulated.span_attributes ?? {};
  const btType =
    typeof spanAttributes.type === "string"
      ? (spanAttributes.type)
      : undefined;
  const laminarType = mapBraintrustSpanType(btType);

  const attrs: Record<string, AttributeValue> = {
    [SPAN_TYPE]: laminarType,
    [SPAN_INSTRUMENTATION_SOURCE]: "javascript",
    [SPAN_SDK_VERSION]: SDK_VERSION,
  };
  const langVersion = getLangVersion();
  if (langVersion) attrs[SPAN_LANGUAGE_VERSION] = langVersion;

  // Preserve the Braintrust type for downstream tooling that wants to
  // distinguish e.g. `function` (Braintrust traced fn) vs `tool` (tool call)
  // even though both map to different Laminar types.
  if (btType) attrs["lmnr.internal.braintrust.span_type"] = btType;

  const metadata = accumulated.metadata ?? {};
  const sessionId = metadata.sessionId ?? metadata.session_id;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    attrs[SESSION_ID] = sessionId;
  }
  const userId = metadata.userId ?? metadata.user_id;
  if (typeof userId === "string" && userId.length > 0) {
    attrs[USER_ID] = userId;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (
      key === "sessionId" ||
      key === "session_id" ||
      key === "userId" ||
      key === "user_id" ||
      // LLM call metadata — we project it into gen_ai.* below rather than
      // flattening into generic association properties.
      (laminarType === "LLM" && key === "provider") ||
      (laminarType === "LLM" && key === "model") ||
      (laminarType === "LLM" && key === "response_model") ||
      value === undefined ||
      value === null
    ) {
      continue;
    }
    const av = toAttributeValue(value);
    if (av !== undefined) {
      attrs[`${ASSOCIATION_PROPERTIES}.metadata.${key}`] = av;
    }
  }

  if (Array.isArray(accumulated.tags) && accumulated.tags.length > 0) {
    attrs[`${ASSOCIATION_PROPERTIES}.tags`] = accumulated.tags;
  }

  if (laminarType === "LLM") {
    applyLlmAttributes(accumulated, attrs);
  } else if (laminarType === "TOOL") {
    if (accumulated.input !== undefined) {
      attrs[SPAN_INPUT] = serializeJSON(accumulated.input);
    }
    if (accumulated.output !== undefined) {
      attrs[SPAN_OUTPUT] = serializeJSON(accumulated.output);
    }
    if (typeof spanAttributes.name === "string") {
      attrs["ai.toolCall.name"] = spanAttributes.name;
    }
  } else {
    if (accumulated.input !== undefined) {
      attrs[SPAN_INPUT] = serializeJSON(accumulated.input);
    }
    if (accumulated.output !== undefined) {
      attrs[SPAN_OUTPUT] = serializeJSON(accumulated.output);
    }
  }

  // Re-assert path attributes in case an upstream processor / instrumentation
  // overwrote them between construct and end. Downstream consumers nest on
  // these, so they must be final.
  otelSpan.setAttributes(attrs);
  otelSpan.setAttribute(SPAN_PATH, companion.spanPath);
  otelSpan.setAttribute(SPAN_IDS_PATH, companion.spanIdsPath);
};

const applyLlmAttributes = (
  accumulated: BraintrustLogPartial,
  attrs: Record<string, AttributeValue>,
): void => {
  const { provider, model, responseModel } = extractLlmMetadata(
    accumulated.metadata,
  );
  if (provider) attrs[LaminarAttributes.PROVIDER] = provider;
  if (model) attrs[LaminarAttributes.REQUEST_MODEL] = model;
  if (responseModel) attrs[LaminarAttributes.RESPONSE_MODEL] = responseModel;
  else if (model) attrs[LaminarAttributes.RESPONSE_MODEL] = model;

  Object.assign(attrs, formatMetrics(accumulated.metrics));

  // Braintrust OpenAI plugin passes `input` = the messages array (see
  // `extractInput` in openai-plugin.ts: `const { messages, ...metadata }`);
  // output = `result.choices`. Anthropic / AI SDK follow similar shapes.
  // Emit both the legacy Laminar generic input/output AND the AI SDK
  // semconv attributes Laminar's LLM renderer prefers.
  if (accumulated.input !== undefined) {
    const inputStr = serializeJSON(accumulated.input);
    attrs[SPAN_INPUT] = inputStr;
    if (
      Array.isArray(accumulated.input) &&
      accumulated.input.every((m) => m && typeof m === "object")
    ) {
      attrs["ai.prompt.messages"] = inputStr;
    }
  }

  if (accumulated.output !== undefined) {
    const outputStr = serializeJSON(accumulated.output);
    attrs[SPAN_OUTPUT] = outputStr;
    const { responseText, toolCallsStr } = extractAssistantFromOutput(
      accumulated.output,
    );
    if (responseText) attrs["ai.response.text"] = responseText;
    if (toolCallsStr) attrs["ai.response.toolCalls"] = toolCallsStr;
  }
};

// Braintrust's openai plugin logs `output = result.choices` (an array of
// `{ index, message: { role, content, tool_calls }, finish_reason }`). Pull
// out the first choice's message content + tool calls to surface in Laminar's
// AI SDK message renderer.
const extractAssistantFromOutput = (
  output: unknown,
): { responseText?: string; toolCallsStr?: string } => {
  if (!Array.isArray(output) || output.length === 0) return {};
  const first = output[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return {};
  const message = first.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return {};
  const content = message.content;
  const toolCalls = message.tool_calls;
  const result: { responseText?: string; toolCallsStr?: string } = {};
  if (typeof content === "string" && content.length > 0) {
    result.responseText = content;
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const normalized = (toolCalls as Array<Record<string, unknown>>).map(
      (tc) => {
        const fn = tc.function as Record<string, unknown> | undefined;
        return {
          toolCallType: "function",
          toolCallId: tc.id,
          toolName: fn?.name,
          args: typeof fn?.arguments === "string" ? fn.arguments : serializeJSON(fn?.arguments),
        };
      },
    );
    result.toolCallsStr = JSON.stringify(normalized);
  }
  return result;
};

let warnedNotInitialized = false;
const warnNotInitializedOnce = (): void => {
  if (warnedNotInitialized) return;
  warnedNotInitialized = true;
  logger.warn(
    "[Laminar.wrapBraintrust] Laminar tracer is not initialized — " +
      "Braintrust spans will NOT be bridged to Laminar. Call " +
      "`Laminar.initialize({ projectApiKey: ... })` before calling " +
      "`Laminar.wrapBraintrust(...)`.",
  );
};

// For tests: clear module-level state so a new `wrapBraintrust` call on a
// fresh tracer provider starts from zero. Not exported from the public
// surface — kept on the internal bridge module.
export const _resetBraintrustBridgeForTests = (): void => {
  rootStateByRootSpanId.clear();
  warnedNotInitialized = false;
};
