
import {
  Attributes,
  AttributeValue,
  Exception,
  Link,
  Span,
  SpanContext,
  SpanStatus,
  TimeInput,
} from "@opentelemetry/api";
import { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace-base";

import { getParentSpanId, makeSpanOtelV2Compatible } from "./compat";
import { LaminarContextManager } from "./context";

export class LaminarSpan implements Span {
  private _span: Span;
  constructor(span: Span) {
    this._span = span;
  }

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
    const attributes = (this._span as unknown as ReadableSpan).attributes;
    const { "lmnr.internal.active": active, ...rest } = attributes;
    if (active === true) {
      this._span.setAttributes(rest);
      LaminarContextManager.popContext();
    }
    return this._span.end(endTime);
  }


  public isRecording(): boolean {
    return this._span.isRecording();
  }

  public recordException(exception: Exception, time?: TimeInput): void {
    return this._span.recordException(exception, time);
  }

  // ================================
  // OTel V2 compatibility
  // ================================

  public makeOtelV2Compatible(): void {
    makeSpanOtelV2Compatible(this._span as unknown as SdkSpan);
  }

  public getParentSpanId(): string | undefined {
    return getParentSpanId(this._span as unknown as SdkSpan);
  }
}
