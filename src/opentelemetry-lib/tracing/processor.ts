import { AttributeValue, Context, context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Logger } from "pino";

import { version as SDK_VERSION } from "../../../package.json";
import { LaminarClient } from "../../client";
import { SpanType } from "../../types";
import { initializeLogger, metadataToAttributes, otelSpanIdToUUID, StringUUID } from "../../utils";
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
  CONTEXT_SPAN_PATH_KEY,
} from "./context";
import { LaminarSpanExporter } from "./exporter";

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
  private readonly _spanIdToPath: Map<string, string[]> = new Map();
  private readonly _spanIdLists: Map<string, string[]> = new Map();

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
    if (options.spanProcessor && options.spanProcessor instanceof LaminarSpanProcessor) {
      this.instance = options.spanProcessor.instance;
      // Set by reference, so that updates from the inside are reflected here.
      this._spanIdToPath = options.spanProcessor._spanIdToPath;
      this._spanIdLists = options.spanProcessor._spanIdLists;
    } else if (options.spanProcessor) {
      this.instance = options.spanProcessor as BatchSpanProcessor | SimpleSpanProcessor;
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

  onStart(spanArg: any, parentContext: Context): void {
    const span = spanArg as OTelSpanCompat;
    // Check for parent path attributes first (from serialized span context)
    const parentPathFromAttribute = span.attributes?.[PARENT_SPAN_PATH] as string[] | undefined;
    const parentIdsPathFromAttribute =
      span.attributes?.[PARENT_SPAN_IDS_PATH] as StringUUID[] | undefined;

    const parentSpanId = getParentSpanId(span);

    // Use parent path from attributes if available, otherwise fall back to cached paths
    const parentSpanPath = parentPathFromAttribute
      ?? (parentSpanId !== undefined
        ? this._spanIdToPath.get(parentSpanId)
        : undefined);

    const spanId = span.spanContext().spanId;
    const parentSpanIdsPath = parentIdsPathFromAttribute
      ?? (parentSpanId
        ? this._spanIdLists.get(parentSpanId)
        : []);
    const spanPath = parentSpanPath ? [...parentSpanPath, span.name] : [span.name];

    const spanIdUuid = otelSpanIdToUUID(spanId);
    const spanIdsPath = parentSpanIdsPath ? [...parentSpanIdsPath, spanIdUuid] : [spanIdUuid];

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
        } else if (key === "metadata" && typeof value === "object" && value !== null) {
          // Flatten metadata into individual attributes
          const metadataAttrs = metadataToAttributes(value as Record<string, unknown>);
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
      this.client.rolloutSessions.sendSpanUpdate({
        sessionId: process.env.LMNR_ROLLOUT_SESSION_ID,
        span: {
          name: span.name,
          startTime: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString(),
          spanId: span.spanContext().spanId,
          traceId: span.spanContext().traceId,
          parentSpanId: getParentSpanId(span),
          attributes: attributesForStartEvent(span.name, span.attributes),
          spanType: inferSpanType(span.name, span.attributes),
        },
      }).catch((error: any) => {
        this.logger.debug(
          `Failed to send span update: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    this.instance.onStart((span), parentContext);
  }

  // type ReadableSpan
  onEnd(span: any): void {
    // By default, we call the original onEnd.
    makeSpanOtelV2Compatible(span);
    this.instance.onEnd(span as Span);
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

  clear() {
    this._spanIdToPath.clear();
    this._spanIdLists.clear();
  }
}

const inferSpanType = (
  name: string,
  attributes: Record<string, AttributeValue | undefined>,
): SpanType => {
  if (attributes[SPAN_TYPE]) {
    return attributes[SPAN_TYPE] as SpanType;
  }
  if (attributes['gen_ai.system']) {
    return 'LLM';
  }
  if (Object.keys(attributes).some((k) => k.startsWith('gen_ai.') || k.startsWith('llm.'))) {
    return 'LLM';
  }
  if (name === 'ai.toolCall' || attributes['ai.toolCall.id'] || attributes['ai.toolCall.name']) {
    return 'TOOL';
  }
  return 'DEFAULT';
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
  if (attributes["gen_ai.request.model"] && !attributes["gen_ai.response.model"]) {
    newAttributes["gen_ai.response.model"] = attributes["gen_ai.request.model"];
  }
  return {
    [SPAN_TYPE]: inferSpanType(name, attributes),
    ...newAttributes,
  };
};
