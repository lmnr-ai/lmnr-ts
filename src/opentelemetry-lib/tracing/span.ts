
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

import { getParentSpanId, makeSpanOtelV2Compatible } from "./compat";
import { LaminarContextManager } from "./context";

// We decided to implement raw otel Span interface and have _span: SdkSpan because SdkSpan
// discourages use of its constructor directly
// We are using constructor directly because we're implementing Tracer interface
export class LaminarSpan implements Span, ReadableSpan {
  private _span: Span;
  private _activated: boolean;

  // Static registry for cross-async span management
  // We're keeping track of spans have started (and running) here for the cases when span
  // is started in one async context and ended in another
  // In LaminarContextManager we're using this registry to ignore the context of spans that
  // were already ended in another async context
  private static _activeSpans = new Set<string>();

  constructor(span: Span, activated?: boolean) {
    this._activated = activated ?? false;

    this._span = span;
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

    LaminarSpan._activeSpans.add(this.spanContext().spanId);
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
    LaminarSpan._activeSpans.delete(this.spanContext().spanId);

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

  /**
 * Get an active span by its ID.
 *
 * @param spanId - The span ID to retrieve
 * @returns the LaminarSpan if found and active, undefined otherwise
 */
  public static isSpanActive(spanId: string): boolean {
    return LaminarSpan._activeSpans.has(spanId);
  }

  // ================================
  // OTel V2 compatibility
  // ================================

  public makeOtelV2Compatible(): void {
    makeSpanOtelV2Compatible(this._span as unknown as SdkSpan);
  }

  public get instrumentationScope(): InstrumentationScope {
    return (this._span as unknown as SdkSpan).instrumentationLibrary;
  }

  public get parentSpanContext(): SpanContext | undefined {
    if (!this.parentSpanId) {
      return undefined;
    }
    return {
      spanId: this.parentSpanId,
      traceId: this.spanContext().traceId,
      // TODO: somehow get the traceFlags from the parent span
      traceFlags: this.spanContext().traceFlags,
    };
  }

  public getParentSpanId(): string | undefined {
    return getParentSpanId(this._span as unknown as SdkSpan);
  }
}
