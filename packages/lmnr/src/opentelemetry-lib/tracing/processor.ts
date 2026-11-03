import { Context, context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { Logger } from "pino";

import { version as SDK_VERSION } from "../../../package.json";
import { getRuntime } from "../../debug";
import {
  initializeLogger,
  metadataToAttributes,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
  StringUUID,
} from "../../utils";
import { getLangVersion } from "../../version";
import {
  ASSOCIATION_PROPERTIES,
  ASSOCIATION_PROPERTIES_OVERRIDES,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_PATH,
  SPAN_RELEASE,
  SPAN_SDK_VERSION,
  TRACE_TYPE,
  USER_ID,
} from "./attributes";
import { SizeLimitedBatchSpanProcessor } from "./batch-processor";
import {
  getParentSpanId,
  makeSpanOtelV2Compatible,
  OTelSpanCompat,
  type SpanExporterCompat,
  type SpanProcessorCompat,
} from "./compat";
import {
  ASSOCIATION_PROPERTIES_KEY,
  CONTEXT_SPAN_PATH_KEY,
  LaminarContextManager,
} from "./context";
import { LaminarSpanExporter } from "./exporter";
import { detectRelease } from "./release";
import { TrajectoryCollector } from "./trajectory";

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
   * Approximate maximum size, in bytes, of the spans buffered in a single batch.
   * Only used when `flushBySize` is true. Optional.
   * Defaults to 32 MiB.
   */
  maxExportBatchSizeBytes?: number;
  /**
   * Whether to also flush batches by approximate payload size. Optional.
   * Defaults to false.
   */
  flushBySize?: boolean;
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
  exporter?: SpanExporterCompat;

  /**
   * The span processor to use. If passed, some of the other options will be ignored.
   * If passed, wraps the underlying span processor.
   */
  spanProcessor?: SpanProcessorCompat;

  /**
   * The HTTP port to use. Optional.
   * If not provided, the `port` option will be used.
   */
  httpPort?: number;

  /**
   * The release of the running code, usually its git commit SHA, stamped on
   * every span. Optional. If not provided, detected from the environment.
   */
  release?: string;

  /**
   * Write the run as an lmnr-atif trajectory file here
   * (`LMNR_TRAJECTORY_PATH`). May contain `{trace_id}` and `{pid}`. Optional.
   */
  trajectoryPath?: string;

  /**
   * Whether to export spans to Laminar. Optional. Defaults to true. False
   * (with `trajectoryPath`) is local-only: no exporter and no batch
   * processor are created, and `exporter` / a wrapped LaminarSpanProcessor's
   * pipeline are not used. A `spanProcessor` that isn't a
   * LaminarSpanProcessor is the caller's own pipeline and still runs.
   */
  exportSpans?: boolean;
}

export class LaminarSpanProcessor implements SpanProcessor {
  // Both undefined in local-only mode (`LMNR_TRAJECTORY_PATH` without
  // force-export): spans go to the trajectory file and nowhere else. Every use
  // checks; there is deliberately no discarding exporter, since OTel's
  // exporter interfaces change between releases.
  private instance: SpanProcessor | undefined;
  private exporter: SpanExporter | undefined;
  /**
   * Writes the trajectory file, when there is one. Fed from `onStart` /
   * `onEnd`, so it sees exactly the spans that would be exported.
   */
  readonly trajectory: TrajectoryCollector | undefined;
  private logger: Logger;
  private readonly _spanIdToPath: Map<string, string[]> = new Map();
  private readonly _spanIdLists: Map<string, string[]> = new Map();
  private readonly release: string | undefined;

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
   * @param {string} options.release - The release of the running code, usually
   * its git commit SHA. Detected from the environment if not provided.
   */
  constructor(options: LaminarSpanProcessorOptions = {}) {
    this.logger = initializeLogger();
    // Only this processor's `onStart` runs, so it carries a wrapped one's release.
    const wrapped =
      options.spanProcessor instanceof LaminarSpanProcessor
        ? options.spanProcessor.release
        : undefined;
    this.release = detectRelease(options.release ?? wrapped);
    const exportSpans = options.exportSpans ?? true;
    if (
      options.spanProcessor &&
      options.spanProcessor instanceof LaminarSpanProcessor
    ) {
      // Its pipeline exports to Laminar, so local-only mode doesn't use it.
      if (exportSpans) {
        this.instance = options.spanProcessor.instance;
        this.exporter = options.spanProcessor.exporter;
      }
      // Set by reference, so that updates from the inside are reflected here.
      this._spanIdToPath = options.spanProcessor._spanIdToPath;
      this._spanIdLists = options.spanProcessor._spanIdLists;
    } else if (options.spanProcessor) {
      this.instance = options.spanProcessor;
    } else if (exportSpans) {
      const exporter = options.exporter ?? new LaminarSpanExporter(options);
      this.exporter = exporter;
      const batchConfig = {
        maxExportBatchSize: options.maxExportBatchSize ?? 512,
        exportTimeoutMillis: options.traceExportTimeoutMillis ?? 30000,
      };
      if (options.disableBatch) {
        this.instance = new SimpleSpanProcessor({ exporter });
      } else if (options.flushBySize) {
        this.instance = new SizeLimitedBatchSpanProcessor(exporter, {
          ...batchConfig,
          maxExportBatchSizeBytes: options.maxExportBatchSizeBytes,
        });
      } else {
        this.instance = new BatchSpanProcessor({ ...batchConfig, exporter });
      }
    }
    // Only this processor's `onStart` / `onEnd` run when it wraps another
    // LaminarSpanProcessor, so without a path of its own it takes over that
    // one's collector. Either way exactly one collector records each span;
    // a wrapped collector that isn't taken over records nothing.
    this.trajectory = options.trajectoryPath
      ? new TrajectoryCollector(
          options.trajectoryPath,
          exportSpans,
          this.release,
        )
      : options.spanProcessor instanceof LaminarSpanProcessor
        ? options.spanProcessor.trajectory
        : undefined;
  }

  async forceFlush(): Promise<void> {
    this.trajectory?.write();
    await this.instance?.forceFlush();
  }

  async shutdown(): Promise<void> {
    this.trajectory?.shutdown();
    await this.instance?.shutdown();
  }

  onStart(spanArg: any, parentContext: Context): void {
    const span = spanArg as OTelSpanCompat;
    // Check for parent path attributes first (from serialized span context)
    const parentPathFromAttribute = span.attributes?.[PARENT_SPAN_PATH] as
      | string[]
      | undefined;
    const parentIdsPathFromAttribute = span.attributes?.[
      PARENT_SPAN_IDS_PATH
    ] as StringUUID[] | undefined;

    const parentSpanId = getParentSpanId(span);

    // Use parent path from attributes if available, otherwise fall back to cached paths
    const parentSpanPath =
      parentPathFromAttribute ??
      (parentSpanId !== undefined
        ? this._spanIdToPath.get(parentSpanId)
        : undefined);

    const spanId = span.spanContext().spanId;
    // A parent created in ANOTHER process (context restored from a traceparent
    // header or a queue carrier) is not in `_spanIdLists`. Seeding the path with
    // the parent's own id keeps this span off the head of its ids_path, which is
    // what stops the backend from treating it as a root and discarding the
    // parent (`is_top_span` in app-server/src/traces/utils.rs).
    const parentSpanIdsPath =
      parentIdsPathFromAttribute ??
      (parentSpanId
        ? (this._spanIdLists.get(parentSpanId) ?? [
            otelSpanIdToUUID(parentSpanId),
          ])
        : []);
    const spanPath = parentSpanPath
      ? [...parentSpanPath, span.name]
      : [span.name];

    const spanIdUuid = otelSpanIdToUUID(spanId);
    const spanIdsPath = parentSpanIdsPath
      ? [...parentSpanIdsPath, spanIdUuid]
      : [spanIdUuid];

    span.setAttribute(SPAN_IDS_PATH, spanIdsPath);
    this._spanIdLists.set(spanId, spanIdsPath);

    span.setAttribute(SPAN_PATH, spanPath);
    context.active().setValue(CONTEXT_SPAN_PATH_KEY, spanPath);
    this._spanIdToPath.set(spanId, spanPath);

    span.setAttribute(SPAN_INSTRUMENTATION_SOURCE, "javascript");
    span.setAttribute(SPAN_SDK_VERSION, SDK_VERSION);
    const langVersion = getLangVersion();
    if (langVersion) {
      span.setAttribute(SPAN_LANGUAGE_VERSION, langVersion);
    }
    // On every span, not via global metadata: app-server groups an agent's
    // traces into versions by it, so a span from a bare OTel tracer needs it too.
    if (this.release) {
      span.setAttribute(SPAN_RELEASE, this.release);
    }

    // Stamp global metadata (e.g. the debug run's `rollout.session_id`) onto
    // every span. Unlike association properties, global metadata is not carried
    // on the OTEL context, so traces built purely from auto-instrumentation
    // (no observe / startActiveSpan) would otherwise never receive it. The
    // association-properties block below re-applies the per-span metadata, which
    // already merges global metadata in (see buildContextProperties), so any
    // span-level overrides still win.
    const globalMetadata = LaminarContextManager.getGlobalMetadata();
    if (globalMetadata && Object.keys(globalMetadata).length > 0) {
      span.setAttributes(metadataToAttributes(globalMetadata));
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

    // On a debug run, remember the root trace id so the run pointer (§5) can be
    // emitted at shutdown.
    if (parentSpanId === undefined) {
      this.recordDebugTraceId(span);
    }

    if (this.trajectory !== undefined) {
      try {
        this.trajectory.onStart(span as unknown as Span);
      } catch (e) {
        this.logger.debug(
          `Failed to track span for the trajectory: ${String(e)}`,
        );
      }
    }

    this.instance?.onStart(span as unknown as Span, parentContext);
  }

  /**
   * Record the root trace id on the debug runtime, if this is a debug run.
   *
   * No-op when debug mode is off. Best-effort: never break tracing.
   */
  private recordDebugTraceId(span: OTelSpanCompat): void {
    try {
      const runtime = getRuntime();
      if (runtime === null) {
        return;
      }
      runtime.recordTraceId(otelTraceIdToUUID(span.spanContext().traceId));
    } catch (e) {
      this.logger.debug(`Failed to record debug trace id: ${String(e)}`);
    }
  }

  // type ReadableSpan
  onEnd(span: any): void {
    const spanId = (span as Span).spanContext().spanId;
    this._spanIdLists.delete(spanId);
    this._spanIdToPath.delete(spanId);
    makeSpanOtelV2Compatible(span);
    if (this.trajectory !== undefined) {
      try {
        this.trajectory.onEnd(span as Span);
      } catch (e) {
        this.logger.debug(
          `Failed to record span for the trajectory: ${String(e)}`,
        );
      }
    }
    this.instance?.onEnd(span as Span);
  }

  /**
   * Set parent path information for a given span ID.
   * Used when initializing context from environment variables.
   *
   * @param parentSpanId - The span ID to set path information for
   * @param spanPath - The span path (array of span names)
   * @param spanIdsPath - The span IDs path (array of span ID UUIDs)
   */
  setParentPathInfo(
    parentSpanId: string,
    spanPath: string[],
    spanIdsPath: StringUUID[],
  ): void {
    this._spanIdToPath.set(parentSpanId, spanPath);
    this._spanIdLists.set(parentSpanId, spanIdsPath);
  }

  /**
   * Drop cached path entries for a given span id. For exporters that stamp
   * their own span id over the SDK-allocated one after `startSpan` has fired
   * `onStart` — without this, `onEnd` reads the mutated id and its delete is
   * a no-op, so the original entry leaks one pair of map entries per span.
   */
  dropPathInfo(spanId: string): void {
    this._spanIdToPath.delete(spanId);
    this._spanIdLists.delete(spanId);
  }

  clear() {
    this._spanIdToPath.clear();
    this._spanIdLists.clear();
  }
}
