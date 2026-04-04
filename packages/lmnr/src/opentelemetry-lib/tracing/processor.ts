import { LaminarClient } from "@lmnr-ai/client";
import { SpanType } from "@lmnr-ai/types";
import {
  AttributeValue,
  Context,
  context,
  INVALID_SPAN,
  trace,
} from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Logger } from "pino";

import { version as SDK_VERSION } from "../../../package.json";
import {
  initializeLogger,
  metadataToAttributes,
  otelSpanIdToUUID,
  StringUUID,
} from "../../utils";
import { getLangVersion } from "../../version";
import {
  ASSOCIATION_PROPERTIES,
  ASSOCIATION_PROPERTIES_OVERRIDES,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  ROLLOUT_SESSION_ID,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_PATH,
  SPAN_SDK_VERSION,
  SPAN_TYPE,
  TRACE_TYPE,
  USER_ID,
} from "./attributes";
import {
  getParentSpanId,
  makeSpanOtelV2Compatible,
  OTelSpanCompat,
} from "./compat";
import {
  ASSOCIATION_PROPERTIES_KEY,
  CONTEXT_SPAN_IDS_PATH_KEY,
  CONTEXT_SPAN_PATH_KEY,
} from "./context";
import { LaminarSpanExporter } from "./exporter";

// Maximum number of span-path entries kept in the bounded in-memory fallback.
const MAX_PATH_CACHE_ENTRIES = 50_000;

// Traces that have not had any new spans within this many seconds are eligible
// for eviction from the in-memory cache.
const TRACE_IDLE_TIMEOUT_SECONDS = 1800;

// Minimum interval (ms) between stale-trace eviction scans to avoid
// O(T) iteration on every span start.
const EVICTION_INTERVAL_MS = 60_000;

interface PathEntry {
  spanPath: string[];
  spanIdsPath: StringUUID[];
}

interface LaminarSpanProcessorOptions {
  /**
   * The base URL of the Laminar API. Optional.
   * Defaults to https://api.lmnr.ai.
   */
  baseUrl?: string;
  /**
   * The port of the Laminar API. Optional.
   * Defaults to 8443.
   */
  port?: number;
  /**
   * Laminar project API key. Optional.
   * If not provided, the LMNR_PROJECT_API_KEY environment variable will be used.
   */
  apiKey?: string;
  /**
   * The maximum number of spans to export at a time. Optional.
   * Defaults to 512.
   */
  maxExportBatchSize?: number;
  /**
   * Whether to disable batching. Optional.
   * Defaults to false.
   */
  disableBatch?: boolean;
  /**
   * Whether to force HTTP and use OpenTelemetry HTTP/protobuf exporter.
   * Not recommended with Laminar backends.
   * Optional.
   * Defaults to false.
   */
  forceHttp?: boolean;
  /**
   * The timeout for sending traces data. Optional.
   * Defaults to 30 seconds.
   */
  traceExportTimeoutMillis?: number;

  /**
   * The exporter to use. Optional. If specified, some of the other options will be ignored.
   * Defaults to a new LaminarSpanExporter.
   */
  exporter?: SpanExporter;

  /**
   * The span processor to use. If passed, some of the other options will be ignored.
   * If passed, wraps the underlying span processor.
   */
  spanProcessor?: SpanProcessor;

  /**
   * The HTTP port to use. Optional.
   * If not provided, the `port` option will be used.
   */
  httpPort?: number;
}

export class LaminarSpanProcessor implements SpanProcessor {
  private instance: BatchSpanProcessor | SimpleSpanProcessor;
  private client: LaminarClient | undefined;
  private logger: Logger;

  // Bounded in-memory fallback: spanId (hex string) -> PathEntry
  private readonly _pathCache: Map<string, PathEntry> = new Map();
  // traceId (hex string) -> set of spanIds belonging to this trace
  private readonly _traceSpans: Map<string, Set<string>> = new Map();
  // spanId (hex string) -> traceId (hex string) reverse mapping for O(1) eviction
  private readonly _spanTrace: Map<string, string> = new Map();
  // traceId (hex string) -> last access timestamp (ms, from performance.now())
  private readonly _traceLastAccess: Map<string, number> = new Map();
  // Timestamp of the last stale-trace eviction scan
  private _lastEvictionTime = 0;

  /**
   * @param {object} options - The options for the Laminar span processor.
   * @param {string} options.baseUrl - The base URL of the Laminar API.
   * @param {number} options.port - The port of the Laminar API.
   * @param {string} options.apiKey - Laminar project API key or any other
   * authorization set as bearer token.
   * @param {boolean} options.disableBatch - Whether to disable batching (uses SimpleSpanProcessor).
   * @param {number} options.maxExportBatchSize - The maximum number of spans to export at a time
   * if disableBatch is false.
   * @param {number} options.traceExportTimeoutMillis - The timeout for sending traces data.
   * Defaults to 30 seconds.
   * @param {boolean} options.forceHttp - Whether to force HTTP and use OpenTelemetry
   * HTTP/protobuf exporter.
   * Not recommended with Laminar backends.
   */
  constructor(options: LaminarSpanProcessorOptions = {}) {
    this.logger = initializeLogger();
    if (
      options.spanProcessor &&
      options.spanProcessor instanceof LaminarSpanProcessor
    ) {
      this.instance = options.spanProcessor.instance;
      // Set by reference, so that updates from the inside are reflected here.
      this._pathCache = options.spanProcessor._pathCache;
      this._traceSpans = options.spanProcessor._traceSpans;
      this._spanTrace = options.spanProcessor._spanTrace;
      this._traceLastAccess = options.spanProcessor._traceLastAccess;
    } else if (options.spanProcessor) {
      this.instance = options.spanProcessor as
        | BatchSpanProcessor
        | SimpleSpanProcessor;
    } else {
      const exporter = options.exporter ?? new LaminarSpanExporter(options);
      this.instance = options.disableBatch
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter, {
            maxExportBatchSize: options.maxExportBatchSize ?? 512,
            exportTimeoutMillis: options.traceExportTimeoutMillis ?? 30000,
          });
    }

    if (process.env.LMNR_ROLLOUT_SESSION_ID) {
      this.client = new LaminarClient({
        baseUrl: options.baseUrl,
        projectApiKey: options.apiKey,
        port: options.httpPort ?? options.port,
      });
    }
  }

  forceFlush(): Promise<void> {
    return this.instance.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.instance.shutdown();
  }

  private _evictStaleTraces(): void {
    const now = performance.now();
    if (now - this._lastEvictionTime < EVICTION_INTERVAL_MS) {
      return;
    }
    this._lastEvictionTime = now;

    const staleTraceIds: string[] = [];
    for (const [tid, ts] of this._traceLastAccess) {
      if (now - ts > TRACE_IDLE_TIMEOUT_SECONDS * 1000) {
        staleTraceIds.push(tid);
      }
    }
    for (const tid of staleTraceIds) {
      const spanIds = this._traceSpans.get(tid);
      if (spanIds) {
        for (const sid of spanIds) {
          this._pathCache.delete(sid);
          this._spanTrace.delete(sid);
        }
      }
      this._traceSpans.delete(tid);
      this._traceLastAccess.delete(tid);
    }
  }

  private _cachePut(spanId: string, traceId: string, entry: PathEntry): void {
    // Lazy eviction of stale traces (amortized, not on every write)
    this._evictStaleTraces();

    // Prune oldest entries if at cap (Map iterates in insertion order)
    while (this._pathCache.size >= MAX_PATH_CACHE_ENTRIES) {
      const firstKey = this._pathCache.keys().next().value;
      if (firstKey !== undefined) {
        this._pathCache.delete(firstKey);
        // O(1) cleanup via reverse mapping
        const evictedTid = this._spanTrace.get(firstKey);
        this._spanTrace.delete(firstKey);
        if (evictedTid !== undefined) {
          const sids = this._traceSpans.get(evictedTid);
          if (sids) {
            sids.delete(firstKey);
            if (sids.size === 0) {
              this._traceSpans.delete(evictedTid);
              this._traceLastAccess.delete(evictedTid);
            }
          }
        }
      } else {
        break;
      }
    }

    this._pathCache.set(spanId, entry);
    this._spanTrace.set(spanId, traceId);
    const traceSpans = this._traceSpans.get(traceId);
    if (traceSpans) {
      traceSpans.add(spanId);
    } else {
      this._traceSpans.set(traceId, new Set([spanId]));
    }
    this._traceLastAccess.set(traceId, performance.now());
  }

  private _cacheGet(spanId: string): PathEntry | undefined {
    return this._pathCache.get(spanId);
  }

  /**
   * Resolve the parent span path and ids path.
   *
   * Priority:
   *  1. OTel Context – read SPAN_PATH / SPAN_IDS_PATH from the parent
   *     span that lives in the context (normal nesting).
   *  2. OTel Context values – read CONTEXT_SPAN_PATH_KEY /
   *     CONTEXT_SPAN_IDS_PATH_KEY stored in the context (covers
   *     NonRecordingSpan parents, e.g. LMNR_SPAN_CONTEXT env var).
   *  3. Span attributes – read PARENT_SPAN_PATH / PARENT_SPAN_IDS_PATH
   *     set by the caller on the current span (remote / ended spans).
   *  4. Bounded in-memory cache – look up by parent span_id (covers raw
   *     OTel SpanContext being passed as parent).
   */
  private _resolveParentPath(
    span: OTelSpanCompat,
    parentContext: Context,
  ): { parentSpanPath: string[]; parentSpanIdsPath: StringUUID[] } {
    let parentSpanPath: string[] = [];
    let parentSpanIdsPath: StringUUID[] = [];

    // 1. Try the parent span from OTel context
    const parentSpan = trace.getSpan(parentContext);
    if (
      parentSpan &&
      parentSpan !== INVALID_SPAN &&
      "attributes" in parentSpan &&
      (parentSpan as any).attributes
    ) {
      const attrs = (parentSpan as any).attributes as Record<string, any>;
      if (attrs[SPAN_PATH]) {
        parentSpanPath = [...(attrs[SPAN_PATH] as string[])];
      }
      if (attrs[SPAN_IDS_PATH]) {
        parentSpanIdsPath = [...(attrs[SPAN_IDS_PATH] as StringUUID[])];
      }
    }

    // 2. Try context values (e.g. from LMNR_SPAN_CONTEXT env var)
    if (parentSpanPath.length === 0) {
      const ctxPath = parentContext.getValue(CONTEXT_SPAN_PATH_KEY) as
        | string[]
        | undefined;
      if (ctxPath && ctxPath.length > 0) {
        parentSpanPath = [...ctxPath];
      }
      const ctxIds = parentContext.getValue(CONTEXT_SPAN_IDS_PATH_KEY) as
        | StringUUID[]
        | undefined;
      if (ctxIds && ctxIds.length > 0) {
        parentSpanIdsPath = [...ctxIds];
      }
    }

    // 3. Fall back to span attributes set by the caller
    if (parentSpanPath.length === 0) {
      const attrPath = span.attributes?.[PARENT_SPAN_PATH] as
        | string[]
        | undefined;
      if (attrPath && attrPath.length > 0) {
        parentSpanPath = [...attrPath];
      }
      const attrIds = span.attributes?.[PARENT_SPAN_IDS_PATH] as
        | StringUUID[]
        | undefined;
      if (attrIds && attrIds.length > 0) {
        parentSpanIdsPath = [...attrIds];
      }
    }

    // 4. Bounded in-memory cache (last resort)
    if (parentSpanPath.length === 0) {
      const parentSpanId = getParentSpanId(span);
      if (parentSpanId) {
        const entry = this._cacheGet(parentSpanId);
        if (entry) {
          parentSpanPath = [...entry.spanPath];
          parentSpanIdsPath = [...entry.spanIdsPath];
        }
      }
    }

    return { parentSpanPath, parentSpanIdsPath };
  }

  onStart(spanArg: any, parentContext: Context): void {
    const span = spanArg as OTelSpanCompat;

    const { parentSpanPath, parentSpanIdsPath } = this._resolveParentPath(
      span,
      parentContext,
    );

    const spanId = span.spanContext().spanId;
    const traceId = span.spanContext().traceId;
    const spanPath =
      parentSpanPath.length > 0 ? [...parentSpanPath, span.name] : [span.name];

    const spanIdUuid = otelSpanIdToUUID(spanId);
    const spanIdsPath: StringUUID[] =
      parentSpanIdsPath.length > 0
        ? [...parentSpanIdsPath, spanIdUuid]
        : [spanIdUuid];

    span.setAttribute(SPAN_IDS_PATH, spanIdsPath);
    span.setAttribute(SPAN_PATH, spanPath);
    context.active().setValue(CONTEXT_SPAN_PATH_KEY, spanPath);
    this._cachePut(spanId, traceId, { spanPath, spanIdsPath });

    span.setAttribute(SPAN_INSTRUMENTATION_SOURCE, "javascript");
    span.setAttribute(SPAN_SDK_VERSION, SDK_VERSION);
    const langVersion = getLangVersion();
    if (langVersion) {
      span.setAttribute(SPAN_LANGUAGE_VERSION, langVersion);
    }

    // This sets the properties only if the context has them
    const associationProperties = context
      .active()
      .getValue(ASSOCIATION_PROPERTIES_KEY);
    if (associationProperties) {
      for (const [key, value] of Object.entries(associationProperties)) {
        if (Object.keys(ASSOCIATION_PROPERTIES_OVERRIDES).includes(key)) {
          span.setAttribute(ASSOCIATION_PROPERTIES_OVERRIDES[key], value);
        } else if (key === "tracing_level") {
          span.setAttribute("lmnr.internal.tracing_level", value);
        } else if (key === "rolloutSessionId") {
          span.setAttribute(ROLLOUT_SESSION_ID, value);
          span.setAttribute("lmnr.rollout.session_id", value);
        } else if (
          key === "metadata" &&
          typeof value === "object" &&
          value !== null
        ) {
          // Flatten metadata into individual attributes
          const metadataAttrs = metadataToAttributes(
            value as Record<string, unknown>,
          );
          span.setAttributes(metadataAttrs);
        } else if (key === "userId") {
          span.setAttribute(USER_ID, value);
        } else if (key === "sessionId") {
          span.setAttribute(SESSION_ID, value);
        } else if (key === "traceType") {
          span.setAttribute(TRACE_TYPE, value);
        } else if (key === "tracingLevel") {
          span.setAttribute("lmnr.internal.tracing_level", value);
        } else {
          span.setAttribute(`${ASSOCIATION_PROPERTIES}.${key}`, value);
        }
      }
    }

    makeSpanOtelV2Compatible(span);

    if (process.env.LMNR_ROLLOUT_SESSION_ID && this.client) {
      this.client.rolloutSessions
        .sendSpanUpdate({
          sessionId: process.env.LMNR_ROLLOUT_SESSION_ID,
          span: {
            name: span.name,
            startTime: new Date(
              span.startTime[0] * 1000 + span.startTime[1] / 1e6,
            ).toISOString(),
            spanId: span.spanContext().spanId,
            traceId: span.spanContext().traceId,
            parentSpanId: getParentSpanId(span),
            attributes: attributesForStartEvent(span.name, span.attributes),
            spanType: inferSpanType(span.name, span.attributes),
          },
        })
        .catch((error: any) => {
          this.logger.debug(
            `Failed to send span update: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    this.instance.onStart(span, parentContext);
  }

  // type ReadableSpan
  onEnd(span: any): void {
    // By default, we call the original onEnd.
    makeSpanOtelV2Compatible(span);
    this.instance.onEnd(span as Span);
  }

  /**
   * @deprecated Path info is now propagated via OTel Context values.
   * Callers should store path info in the OTel Context using
   * CONTEXT_SPAN_PATH_KEY / CONTEXT_SPAN_IDS_PATH_KEY.
   * Kept for backward compatibility.
   */
  setParentPathInfo(
    _parentSpanId: string,
    _spanPath: string[],
    _spanIdsPath: StringUUID[],
  ): void {
    // no-op
  }

  clear() {
    this._pathCache.clear();
    this._traceSpans.clear();
    this._spanTrace.clear();
    this._traceLastAccess.clear();
    this._lastEvictionTime = 0;
  }
}

const inferSpanType = (
  name: string,
  attributes: Record<string, AttributeValue | undefined>,
): SpanType => {
  if (attributes[SPAN_TYPE]) {
    return attributes[SPAN_TYPE] as SpanType;
  }
  if (attributes["gen_ai.system"]) {
    return "LLM";
  }
  if (
    Object.keys(attributes).some(
      (k) => k.startsWith("gen_ai.") || k.startsWith("llm."),
    )
  ) {
    return "LLM";
  }
  if (
    name === "ai.toolCall" ||
    attributes["ai.toolCall.id"] ||
    attributes["ai.toolCall.name"]
  ) {
    return "TOOL";
  }
  return "DEFAULT";
};

const attributesForStartEvent = (
  name: string,
  attributes: Record<string, AttributeValue | undefined>,
): Record<string, AttributeValue> => {
  const keysToKeep = [
    SPAN_PATH,
    SPAN_TYPE,
    SPAN_IDS_PATH,
    PARENT_SPAN_PATH,
    PARENT_SPAN_IDS_PATH,
    SPAN_INSTRUMENTATION_SOURCE,
    SPAN_SDK_VERSION,
    SPAN_LANGUAGE_VERSION,
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.system",
    "lmnr.span.original_type",
    "ai.model.id",
  ];
  const newAttributes = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => keysToKeep.includes(key)),
  );

  // Common scenario, because we don't have the response model in the start event.
  // Atrificially set the response model to the request model, just so frontend
  // can show the model in the UI.
  if (
    attributes["gen_ai.request.model"] &&
    !attributes["gen_ai.response.model"]
  ) {
    newAttributes["gen_ai.response.model"] = attributes["gen_ai.request.model"];
  }
  return {
    [SPAN_TYPE]: inferSpanType(name, attributes),
    ...newAttributes,
  };
};
