/**
 * Turns the runs LangSmith's client sends into Laminar spans.
 *
 * LangSmith sends each run in two halves: a create when it starts and an
 * update when it ends. `LangSmithRunRecorder` keeps the create half (its
 * inputs already converted, so later mutations of the caller's objects don't
 * leak in) and emits one finished span on Laminar's pipeline when the update
 * arrives. A run sent complete in its create (deferred inputs, hand-built
 * `RunTree`s posted after `end()`) is emitted right away, and a later update
 * for it is ignored.
 *
 * IDs are deterministic, so a run's children (and the other half of a
 * distributed trace) find it without coordination: the trace id is the
 * LangSmith trace UUID, the span id the FNV-1a hash of the run UUID. A
 * LangSmith root started under a Laminar span joins that span's trace instead.
 * Port of lmnr-python's `bridges/langsmith/runs.py`; keep the two in step.
 */
import { errorMessage } from "@lmnr-ai/types";
import {
  type AttributeValue,
  type Context,
  context as contextApi,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";

import { initializeLogger, otelSpanIdToUUID } from "../../../utils";
import {
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SPAN_BRIDGE_NAME,
  SPAN_BRIDGE_VERSION,
  SPAN_IDS_PATH,
  SPAN_PATH,
  SPAN_TYPE,
} from "../../tracing/attributes";
import { getSpanProcessor, getTracerProvider } from "../../tracing/index";
import {
  associationAttributes,
  exceptionAttributes,
  inputAttributes,
  isGlueRun,
  isLangchainRun,
  LLM_RUN_TYPES,
  outputAttributes,
  requestAttributes,
  responseAttributes,
  spanType,
  usageAttributes,
} from "./translate";

const logger = initializeLogger();

// The LangSmith run a span came from, to find it in LangSmith.
export const LANGSMITH_RUN_ID = "langsmith.run.id";
export const LANGSMITH_RUN_TYPE = "langsmith.run.type";
// Set on a run that had not ended when Laminar shut down or the process
// exited; its span ends then (`endOpenRuns`).
export const LANGSMITH_RUN_INCOMPLETE = "langsmith.run.incomplete";

// Open runs, and recently finished ones (for children that start after their
// parent ended, and updates that follow a complete create). Both bounded: a
// run whose update never comes is dropped when evicted. At shutdown and
// process exit, the runs still open are emitted as incomplete.
export const MAX_OPEN_RUNS = 10_000;
export const MAX_FINISHED_RUNS = 10_000;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const UUID =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

type Json = Record<string, any>;
type Attrs = Record<string, AttributeValue>;

/**
 * 64-bit FNV-1a of the run UUID's lowercase text, as 16 hex chars. Same as
 * lmnr-python's `span_id_for` (cross-language vectors in
 * `test/langsmith-bridge.test.ts`).
 */
export const spanIdFor = (runId: string): string => {
  let value = FNV_OFFSET;
  for (const byte of Buffer.from(String(runId).toLowerCase(), "utf8")) {
    value = ((value ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return (value || 1n).toString(16).padStart(16, "0");
};

/** A LangSmith trace UUID as a 128-bit OTel trace id (32 hex chars). */
export const traceIdFor = (traceUuid: string): string => {
  const text = String(traceUuid).toLowerCase();
  if (!UUID.test(text)) return spanIdFor(traceUuid).padStart(32, "0");
  const hex = text.replace(/-/g, "");
  return /^0+$/.test(hex) ? "1".padStart(32, "0") : hex;
};

const asObject = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};

/**
 * Epoch milliseconds (fractional). LangSmith JS sends start times as ISO
 * strings, whose last three microsecond digits are an ordering counter, and
 * end times as epoch milliseconds; Python sends ISO strings for both.
 */
const timeMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  // `Date.parse` keeps milliseconds only.
  const micros = /\.\d{3}(\d{1,3})/.exec(value)?.[1];
  return micros ? ms + Number(micros.padEnd(3, "0")) / 1000 : ms;
};

/**
 * Where a run sits in Laminar's tree; what its children need. A skipped
 * (glue) run takes its parent's place, so its children nest under the
 * nearest recorded ancestor.
 */
interface RunNode {
  traceId: string;
  spanId: string;
  path: string[];
  idsPath: string[];
}

interface OpenRun {
  node: RunNode;
  parentSpanId: string | undefined;
  parentPath: string[];
  parentIdsPath: string[];
  context: Context;
  skipped: boolean;
  run: Json;
  bridgeVersion: string | undefined;
  inputAttributes: Attrs;
}

/** Insert into an insertion-ordered map, evicting the oldest past `max`. */
const setBounded = <V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
): V | undefined => {
  map.set(key, value);
  if (map.size <= max) return undefined;
  const oldest = map.keys().next().value as string;
  const evicted = map.get(oldest);
  map.delete(oldest);
  return evicted;
};

/** A run's `extra.metadata`. */
const metadataOf = (run: Json): Json => asObject(asObject(run.extra).metadata);

/** Merges each run's create and update halves into one Laminar span. */
export class LangSmithRunRecorder {
  private readonly open = new Map<string, OpenRun>();
  private readonly finished = new Map<string, RunNode>();

  private nodeOf(runId: string): RunNode | undefined {
    return this.open.get(runId)?.node ?? this.finished.get(runId);
  }

  /**
   * A run started (or arrived complete). `run` is a JSON snapshot of what
   * LangSmith sends; `context` is Laminar's context where it started.
   */
  onCreate(
    run: Json,
    context: Context,
    bridgeVersion: string | undefined,
  ): void {
    const runId = run.id ? String(run.id) : "";
    if (!runId || this.open.has(runId) || this.finished.has(runId)) return;
    const name = String(run.name || "run");
    const runType = run.run_type;
    const extra = asObject(run.extra);
    const isLangchain = isLangchainRun(extra);
    const parentRunId = run.parent_run_id ? String(run.parent_run_id) : "";

    const parent = parentRunId ? this.nodeOf(parentRunId) : undefined;
    let traceId: string;
    let parentSpanId: string | undefined;
    let parentPath: string[] = [];
    let parentIdsPath: string[] = [];
    if (parent) {
      traceId = parent.traceId;
      parentSpanId = parent.spanId;
      parentPath = [...parent.path];
      parentIdsPath = [...parent.idsPath];
    } else if (parentRunId) {
      // Continued from another service (`langsmith-trace` headers), or the
      // parent started before the bridge was installed: the same ids it got
      // (or will get) there, without its path.
      traceId = traceIdFor(String(run.trace_id || runId));
      parentSpanId = spanIdFor(parentRunId);
    } else {
      const laminarSpan = trace.getSpan(context);
      const spanContext = laminarSpan?.spanContext();
      if (laminarSpan && spanContext && trace.isSpanContextValid(spanContext)) {
        // A LangSmith trace started under a Laminar span joins its trace.
        traceId = spanContext.traceId;
        parentSpanId = spanContext.spanId;
        const attrs = asObject((laminarSpan as any).attributes);
        if (Array.isArray(attrs[SPAN_PATH])) {
          parentPath = attrs[SPAN_PATH].map(String);
        }
        if (Array.isArray(attrs[SPAN_IDS_PATH])) {
          parentIdsPath = attrs[SPAN_IDS_PATH].map(String);
        }
      } else {
        traceId = traceIdFor(String(run.trace_id || runId));
      }
    }

    const skipped =
      parent !== undefined && isGlueRun(name, run.tags, isLangchain);
    let node: RunNode;
    if (skipped) {
      node = {
        traceId,
        spanId: parent.spanId,
        path: parentPath,
        idsPath: parentIdsPath,
      };
    } else {
      const spanId = spanIdFor(runId);
      node = {
        traceId,
        spanId,
        path: [...parentPath, name],
        idsPath: [...parentIdsPath, otelSpanIdToUUID(spanId)],
      };
    }
    const openRun: OpenRun = {
      node,
      parentSpanId,
      parentPath,
      parentIdsPath,
      context,
      skipped,
      run,
      bridgeVersion,
      inputAttributes: {},
    };
    if (!skipped) {
      const invocationParams = extra.invocation_params;
      openRun.inputAttributes = inputAttributes(
        runType,
        run.inputs,
        invocationParams,
        isLangchain,
      );
      if (LLM_RUN_TYPES.has(runType)) {
        Object.assign(
          openRun.inputAttributes,
          requestAttributes(run.inputs, metadataOf(run), invocationParams),
        );
      }
    }
    // Only the snapshot's other fields are needed from here on.
    delete run.inputs;

    if (setBounded(this.open, runId, openRun, MAX_OPEN_RUNS)) {
      logger.debug("LangSmith bridge: dropped a run that never ended");
    }
    if (run.end_time !== undefined && run.end_time !== null) {
      this.onUpdate(run);
    }
  }

  /**
   * A run ended: merge the update into its create and emit the span.
   * `knownOnly` drops an update whose create wasn't seen (the tap can't tell
   * a sampled-out run's update from one that started before the bridge).
   */
  onUpdate(update: Json, bridgeVersion?: string, knownOnly = false): void {
    const runId = update.id ? String(update.id) : "";
    if (!runId) return;
    const openRun = this.open.get(runId);
    if (!openRun) {
      // Already emitted from a complete create.
      if (this.finished.has(runId) || knownOnly) return;
      // The create came before the bridge was installed (or was never
      // seen): the update carries the rest of the run in current LangSmith
      // versions.
      this.onCreate({ ...update }, ROOT_CONTEXT, bridgeVersion);
      return;
    }
    this.open.delete(runId);
    setBounded(this.finished, runId, openRun.node, MAX_FINISHED_RUNS);
    if (openRun.skipped) return;
    const run = openRun.run;
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined && value !== null) run[key] = value;
    }
    try {
      this.emit(runId, openRun, run);
    } catch (e) {
      logger.debug(
        `LangSmith bridge failed to record a run: ${errorMessage(e)}`,
      );
    }
  }

  /**
   * Emit every run that hasn't ended, ending now and marked
   * `langsmith.run.incomplete`. For shutdown and process exit, after which
   * its update can't arrive: LangSmith keeps such a run as in progress, and
   * without this Laminar would have no span for it. Latest first, so
   * children end before their parents. Returns how many spans were emitted.
   */
  endOpenRuns(): number {
    const runs = [...this.open].reverse();
    this.open.clear();
    let emitted = 0;
    for (const [runId, openRun] of runs) {
      setBounded(this.finished, runId, openRun.node, MAX_FINISHED_RUNS);
      if (openRun.skipped) continue;
      try {
        this.emit(runId, openRun, openRun.run, true);
        emitted += 1;
      } catch (e) {
        logger.debug(
          `LangSmith bridge failed to record an open run: ${errorMessage(e)}`,
        );
      }
    }
    return emitted;
  }

  private emit(
    runId: string,
    openRun: OpenRun,
    run: Json,
    incomplete = false,
  ): void {
    const runType = run.run_type;
    const extra = asObject(run.extra);
    const metadata = asObject(extra.metadata);
    const invocationParams = extra.invocation_params;
    const isLangchain = isLangchainRun(extra);
    const outputs = run.outputs;

    const attributes: Attrs = {
      [SPAN_TYPE]: spanType(runType),
      [SPAN_BRIDGE_NAME]: "langsmith",
      [LANGSMITH_RUN_ID]: runId,
    };
    if (typeof runType === "string") attributes[LANGSMITH_RUN_TYPE] = runType;
    if (incomplete) attributes[LANGSMITH_RUN_INCOMPLETE] = true;
    if (openRun.bridgeVersion) {
      attributes[SPAN_BRIDGE_VERSION] = openRun.bridgeVersion;
    }
    if (openRun.parentPath.length > 0) {
      attributes[PARENT_SPAN_PATH] = openRun.parentPath;
      attributes[PARENT_SPAN_IDS_PATH] = openRun.parentIdsPath;
    }
    let inputAttrs = openRun.inputAttributes;
    if (Object.keys(inputAttrs).length === 0 && run.inputs) {
      // LangChain sends deferred inputs (streamed into a runnable) with the
      // update.
      inputAttrs = inputAttributes(
        runType,
        run.inputs,
        invocationParams,
        isLangchain,
      );
      if (LLM_RUN_TYPES.has(runType)) {
        Object.assign(
          inputAttrs,
          requestAttributes(run.inputs, metadata, invocationParams),
        );
      }
    }
    Object.assign(
      attributes,
      inputAttrs,
      outputAttributes(runType, outputs, isLangchain),
    );
    if (LLM_RUN_TYPES.has(runType)) {
      Object.assign(
        attributes,
        responseAttributes(outputs),
        usageAttributes(outputs, metadata),
      );
    }
    Object.assign(
      attributes,
      associationAttributes(
        metadata,
        run.tags,
        !run.parent_run_id,
        invocationParams,
      ),
    );

    const startMs = timeMs(run.start_time) ?? Date.now();
    const endMs = timeMs(run.end_time) ?? Date.now();
    this.startAndEnd(
      String(run.name || "run"),
      openRun,
      attributes,
      startMs,
      Math.max(startMs, endMs),
      typeof run.error === "string" && run.error ? run.error : undefined,
    );
  }

  /**
   * A real span from Laminar's provider, with the run's ids stamped over the
   * SDK's (tracers can't take explicit ids), as the Mastra exporter does.
   * Started inside the run's Laminar context, because
   * `LaminarSpanProcessor.onStart` reads association properties
   * (`Laminar.setTraceSessionId`, metadata, ...) from the active context;
   * they are applied after the run's own attributes and win over them.
   */
  private startAndEnd(
    name: string,
    openRun: OpenRun,
    attributes: Attrs,
    startMs: number,
    endMs: number,
    error: string | undefined,
  ): void {
    const { node, parentSpanId } = openRun;
    const tracer = getTracerProvider().getTracer(
      "langsmith",
      openRun.bridgeVersion,
    );
    const parentContext =
      parentSpanId !== undefined
        ? trace.setSpanContext(ROOT_CONTEXT, {
            traceId: node.traceId,
            spanId: parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
          })
        : ROOT_CONTEXT;
    const span = contextApi.with(openRun.context, () =>
      tracer.startSpan(
        name,
        { startTime: startMs, kind: SpanKind.INTERNAL, attributes },
        parentContext,
      ),
    );
    if (!span.isRecording()) return;

    const allocatedSpanId = span.spanContext().spanId;
    Object.assign(span.spanContext(), {
      traceId: node.traceId,
      spanId: node.spanId,
    });
    if (allocatedSpanId !== node.spanId) {
      getSpanProcessor()?.dropPathInfo(allocatedSpanId);
    }
    if (parentSpanId !== undefined) {
      Object.assign(span, {
        parentSpanId,
        parentSpanContext: {
          traceId: node.traceId,
          spanId: parentSpanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
        },
      });
    } else {
      Object.assign(span, {
        parentSpanId: undefined,
        parentSpanContext: undefined,
      });
    }
    // `onStart` built the path from the SDK-allocated id.
    span.setAttribute(SPAN_PATH, node.path);
    span.setAttribute(SPAN_IDS_PATH, node.idsPath);
    if (error !== undefined) {
      // Laminar marks a span failed only by an `exception` event.
      span.addEvent("exception", exceptionAttributes(error), endMs);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.split("\n", 1)[0],
      });
    }
    span.end(endMs);
  }

  clear(): void {
    const dropped = this.open.size;
    this.open.clear();
    this.finished.clear();
    if (dropped > 0) {
      logger.debug(
        `LangSmith bridge: dropped ${dropped} runs that had not ended`,
      );
    }
  }
}
