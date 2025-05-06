import { Context, context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  ReadableSpan,
  SimpleSpanProcessor,
  Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ReadableSpan as OTelV2ReadableSpan,
  Span as OTelV2Span,
} from "@opentelemetry/sdk-trace-base-v2";

import { version as SDK_VERSION } from "../../../package.json";
import { otelSpanIdToUUID } from "../../utils";
import { getLangVersion } from "../../version";
import {
  ASSOCIATION_PROPERTIES,
  ASSOCIATION_PROPERTIES_OVERRIDES,
  SPAN_IDS_PATH,
  SPAN_INSTRUMENTATION_SOURCE,
  SPAN_LANGUAGE_VERSION,
  SPAN_PATH,
  SPAN_SDK_VERSION,
} from "./attributes";
import {
  getParentSpanId,
  makeSpanOtelV2Compatible,
} from "./compat";
import { LaminarSpanExporter } from "./exporter";
import {
  ASSOCIATION_PROPERTIES_KEY,
  getSpanPath,
  SPAN_PATH_KEY,
} from "./utils";

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
}

export class LaminarSpanProcessor implements SpanProcessor {
  private instance: BatchSpanProcessor | SimpleSpanProcessor;
  private readonly _spanIdToPath: Map<string, string[]> = new Map();
  private readonly _spanIdLists: Map<string, string[]> = new Map();

  /**
   * @param {object} options - The options for the Laminar span processor.
   * @param {string} options.baseUrl - The base URL of the Laminar API.
   * @param {number} options.port - The port of the Laminar API.
   * @param {string} options.apiKey - Laminar project API key or any other authorization set as bearer token.
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
    const exporter = options.exporter ?? new LaminarSpanExporter(options);
    this.instance = options.disableBatch
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, {
        maxExportBatchSize: options.maxExportBatchSize ?? 512,
        exportTimeoutMillis: options.traceExportTimeoutMillis ?? 30000,
      });
  }

  forceFlush(): Promise<void> {
    return this.instance.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.instance.shutdown();
  }

  onStart(span: Span | OTelV2Span, parentContext: Context): void {
    const contextSpanPath = getSpanPath(parentContext ?? context.active());
    const parentSpanId = getParentSpanId(span);
    const parentSpanPath = contextSpanPath
      ?? (parentSpanId !== undefined
        ? this._spanIdToPath.get(parentSpanId)
        : undefined);
    const spanId = span.spanContext().spanId;
    const parentSpanIdsPath = parentSpanId
      ? this._spanIdLists.get(parentSpanId)
      : [];
    const spanPath = parentSpanPath ? [...parentSpanPath, span.name] : [span.name];

    const spanIdUuid = otelSpanIdToUUID(spanId);
    const spanIdsPath = parentSpanIdsPath ? [...parentSpanIdsPath, spanIdUuid] : [spanIdUuid];

    span.setAttribute(SPAN_IDS_PATH, spanIdsPath);
    this._spanIdLists.set(spanId, spanIdsPath);

    span.setAttribute(SPAN_PATH, spanPath);
    context.active().setValue(SPAN_PATH_KEY, spanPath);
    this._spanIdToPath.set(spanId, spanPath);

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
        } else {
          span.setAttribute(`${ASSOCIATION_PROPERTIES}.${key}`, value);
        }
      }
    }

    makeSpanOtelV2Compatible(span);
    this.instance.onStart((span as Span), parentContext);
  }

  onEnd(span: ReadableSpan | OTelV2ReadableSpan): void {
    // By default, we call the original onEnd.
    makeSpanOtelV2Compatible(span);
    this.instance.onEnd(span as Span);
  }
}
