
import {
  Attributes,
  AttributeValue,
  Exception,
  HrTime,
  Link,
  Span,
  SpanContext,
  SpanKind,
  SpanStatus,
  TimeInput,
} from "@opentelemetry/api";
import { InstrumentationLibrary, InstrumentationScope } from "@opentelemetry/core";
import { IResource } from "@opentelemetry/resources";
import { ReadableSpan, Span as SdkSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";

import { LaminarSpanContext, TraceType, TracingLevel } from "../../types";
import {
  initializeLogger,
  metadataToAttributes,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
  StringUUID,
} from "../../utils";
import {
  ASSOCIATION_PROPERTIES,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_PATH,
  TRACE_TYPE,
  USER_ID,
} from "./attributes";
import { getParentSpanId, makeSpanOtelV2Compatible } from "./compat";
import { LaminarContextManager } from "./context";

const logger = initializeLogger();

// We decided to implement raw otel Span interface and have _span: SdkSpan because SdkSpan
// discourages use of its constructor directly in favour of Tracer.startSpan()
// We are using constructor directly because we're implementing Tracer interface as well.
export class LaminarSpan implements Span, ReadableSpan {
  private _span: SdkSpan;
  // Whether the span is started by Laminar.startActiveSpan()
  private _activated: boolean;

  constructor(span: Span, activated?: boolean) {
    if (span instanceof LaminarSpan) {
      this._activated = span.isActivated;
      this._span = span._span;
    } else {
      this._activated = activated ?? false;

      // This line assumes that the span passed here is an SdkSpan. Reason:
      // When using default OpenTelemetry Node SDK, i.e. NodeTracerProvider.getTracer().startSpan(),
      // the span returned is an SdkSpan. SDK span implements ReadableSpan, so attributes
      // can be accessed. Span, i.e. OpenTelemetry API Span, does not require that, so custom
      // SDK implementations may not implement certain ReadableSpan methods, in particular
      // `attributes` that we need to access.
      this._span = span as SdkSpan;
    }

    this.name = (this._span as unknown as SdkSpan).name;
    this.kind = (this._span as unknown as SdkSpan).kind;
    this.startTime = (this._span as unknown as SdkSpan).startTime;
    this.endTime = (this._span as unknown as SdkSpan).endTime;
    this.status = (this._span as unknown as SdkSpan).status;
    this.attributes = (this._span as unknown as SdkSpan).attributes;
    this.links = (this._span as unknown as SdkSpan).links;
    this.events = (this._span as unknown as SdkSpan).events;
    this.duration = (this._span as unknown as SdkSpan).duration;
    this.ended = (this._span as unknown as SdkSpan).ended;
    this.resource = (this._span as unknown as SdkSpan).resource;
    this.instrumentationLibrary = (this._span as unknown as SdkSpan).instrumentationLibrary;
    this.droppedAttributesCount = (this._span as unknown as SdkSpan).droppedAttributesCount;
    this.droppedEventsCount = (this._span as unknown as SdkSpan).droppedEventsCount;
    this.droppedLinksCount = (this._span as unknown as SdkSpan).droppedLinksCount;
    this.makeOtelV2Compatible();
    LaminarContextManager.addActiveSpan(this.spanContext().spanId);
  }

  name: string;
  kind: SpanKind;
  parentSpanId?: string | undefined;
  startTime: HrTime;
  endTime: HrTime;
  status: SpanStatus;
  attributes: Attributes;
  links: Link[];
  events: TimedEvent[];
  duration: HrTime;
  ended: boolean;
  resource: IResource;
  instrumentationLibrary: InstrumentationLibrary;
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;

  public spanContext(): SpanContext {
    return this._span.spanContext();
  }

  public setAttribute(key: string, value: AttributeValue): this {
    this._span.setAttribute(key, value);
    return this;
  }

  public setAttributes(attributes: Attributes): this {
    this._span.setAttributes(attributes);
    return this;
  }

  public addEvent(
    name: string,
    attributesOrStartTime?: Attributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    this._span.addEvent(name, attributesOrStartTime, startTime);
    return this;
  }

  public addLink(link: Link): this {
    this._span.addLink(link);
    return this;
  }

  public addLinks(links: Link[]): this {
    this._span.addLinks(links);
    return this;
  }

  public setStatus(status: SpanStatus): this {
    this._span.setStatus(status);
    return this;
  }

  public updateName(name: string): this {
    this._span.updateName(name);
    return this;
  }

  public end(endTime?: TimeInput): void {
    if (!this._span.isRecording()) {
      // This will log a warning and do nothing.
      return this._span.end(endTime);
    }

    // Remove from global registry on end
    LaminarContextManager.removeActiveSpan(this.spanContext().spanId);

    if (this._activated) {
      LaminarContextManager.popContext();
    }
    return this._span.end(endTime);
  }

  public set activated(activated: boolean) {
    this._activated = activated;
  }

  public isRecording(): boolean {
    return this._span.isRecording();
  }

  public recordException(exception: Exception, time?: TimeInput): void {
    return this._span.recordException(exception, time);
  }

  // ================================
  // Laminar specific methods
  // ================================

  public setTraceSessionId(sessionId: string): void {
    this._span.setAttribute(SESSION_ID, sessionId);
  }

  public setTraceUserId(userId: string): void {
    this._span.setAttribute(USER_ID, userId);
  }

  public setTraceMetadata(metadata: Record<string, any>): void {
    this._span.setAttributes(metadataToAttributes(metadata));
  }

  public setInput(input: any): void {
    const finalInput = typeof input === 'string' ? input : JSON.stringify(input);
    this._span.setAttribute(SPAN_INPUT, finalInput);
  }

  public setOutput(output: any): void {
    const finalOutput = typeof output === 'string' ? output : JSON.stringify(output);
    this._span.setAttribute(SPAN_OUTPUT, finalOutput);
  }

  public setTags(tags: string[]): void {
    this._span.setAttribute(`${ASSOCIATION_PROPERTIES}.tags`, Array.from(new Set(tags)));
  }

  public addTags(tags: string[]): void {
    const currentTags = this.tags;
    this.setTags(Array.from(new Set([...currentTags, ...tags])));
  }

  public getLaminarSpanContext(): LaminarSpanContext {
    let spanPath: string[] = [];
    let spanIdsPath: StringUUID[] = [];
    let userId;
    let sessionId;
    let traceType;
    const metadata: Record<string, AttributeValue> = {};

    if (this._span.attributes) {
      spanPath = this._span.attributes[SPAN_PATH] as string[];
      spanIdsPath = this._span.attributes[SPAN_IDS_PATH] as StringUUID[];
      userId = this._span.attributes[USER_ID] as string;
      sessionId = this._span.attributes[SESSION_ID] as string;
      traceType = this._span.attributes[TRACE_TYPE] as TraceType;
      for (const [key, rawValue] of Object.entries(this._span.attributes)) {
        if (key.startsWith(`${ASSOCIATION_PROPERTIES}.metadata.`)) {
          let value = rawValue!;
          try {
            value = JSON.parse(value as string);
          } catch {
            // Ignore
          }
          metadata[key.replace(`${ASSOCIATION_PROPERTIES}.metadata.`, '')] = value;
        }
      }
    } else {
      logger.warn(
        "Attributes object is not available. Most likely the span is not a LaminarSpan " +
        "and not an OpenTelemetry default SDK Span. Span path and ids path will be empty.",
      );
    }

    return {
      spanId: otelSpanIdToUUID(this._span.spanContext().spanId) as StringUUID,
      traceId: otelTraceIdToUUID(this._span.spanContext().traceId),
      isRemote: this._span.spanContext().isRemote ?? false,
      spanPath: spanPath,
      spanIdsPath: spanIdsPath,
      userId: userId,
      sessionId: sessionId,
      metadata: metadata,
      traceType: traceType,
    };
  }

  public spanId(
    format: 'otel' | 'uuid' = 'otel',
  ): string {
    const spanId = this._span.spanContext().spanId;
    if (format === 'otel') {
      return spanId;
    }
    return otelSpanIdToUUID(spanId);
  }

  public traceId(
    format: 'otel' | 'uuid' = 'otel',
  ): string {
    const traceId = this._span.spanContext().traceId;
    if (format === 'otel') {
      return traceId;
    }
    return otelTraceIdToUUID(traceId);
  }

  public get tags(): string[] {
    if (!this._span.attributes) {
      logger.warn(
        "[LaminarSpan.tags] WARNING. Current span does not have attributes object. " +
        "Possibly, the span was created with a custom OTel SDK. Returning an empty list. " +
        "Help: OpenTelemetry API does not guarantee reading attributes from a span, but OTel " +
        "SDK allows it by default. Laminar SDK allows to read attributes too.",
      );
      return [];
    }
    return this._span.attributes[`${ASSOCIATION_PROPERTIES}.tags`] as string[] ?? [];
  }

  public get laminarAssociationProperties(): {
    metadata?: Record<string, any>;
    userId?: string;
    sessionId?: string;
    traceType?: TraceType;
    tracingLevel?: TracingLevel;
  } {
    if (!this._span.attributes) {
      logger.warn(
        "[LaminarSpan.laminarAssociationProperties] WARNING. Current span does not have " +
        "attributes object. Possibly, the span was created with a custom OTel SDK. Returning an " +
        "empty object. Help: OpenTelemetry API does not guarantee reading attributes from a " +
        "span, but OTel SDK allows it by default. Laminar SDK allows to read attributes too.",
      );
      return {};
    }
    try {
      const properties: Record<string, any> = {};
      const metadata: Record<string, any> = {};
      for (const [key, rawValue] of Object.entries(this._span.attributes)) {
        if (!key.startsWith(`${ASSOCIATION_PROPERTIES}.`)) {
          continue;
        }
        let value = rawValue!;
        if (key.startsWith(`${ASSOCIATION_PROPERTIES}.metadata.`)) {
          const metaKey = key.replace(`${ASSOCIATION_PROPERTIES}.metadata.`, '');
          try {
            value = JSON.parse(value as string);
          } catch {
            // Ignore
          }
          metadata[metaKey] = value;
        }
      }
      properties.tracingLevel = this._span.attributes[
        `${ASSOCIATION_PROPERTIES}.tracing_level`
      ] as TracingLevel ?? TracingLevel.ALL;
      properties.userId = this._span.attributes[USER_ID] as string ?? undefined;
      properties.sessionId = this._span.attributes[SESSION_ID] as string ?? undefined;
      properties.traceType = this._span.attributes[TRACE_TYPE] as TraceType ?? undefined;
      return {
        metadata,
        ...properties,
      };
    } catch {
      return {};
    }
  }

  // ================================
  // OTel V2 compatibility
  // ================================

  public makeOtelV2Compatible(): void {
    makeSpanOtelV2Compatible(this._span);
  }

  public get instrumentationScope(): InstrumentationScope {
    return this._span.instrumentationLibrary;
  }

  public get parentSpanContext(): SpanContext | undefined {
    const parentSpanId = this._span.parentSpanId;
    if (!parentSpanId) {
      return undefined;
    }
    return {
      spanId: parentSpanId,
      traceId: this.spanContext().traceId,
      // TODO: somehow get the traceFlags from the parent span
      traceFlags: this.spanContext().traceFlags,
    };
  }

  public getParentSpanId(): string | undefined {
    return getParentSpanId(this._span as unknown as SdkSpan);
  }

  public get isActivated(): boolean {
    return this._activated;
  }
}
