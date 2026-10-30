// Compatibility across OTel JS SDK v1 (0.5x), v2 (0.2xx) and v3 (0.3xx).
//
// Laminar's own TracerProvider and span processors come from the v3
// `@opentelemetry/sdk-trace` (with `core` and `resources`), bundled into
// dist so that it works on whichever `@opentelemetry/api` the host app has.
// The spans it creates can still meet v1 code: a user's `spanProcessor` /
// `exporter` passed to `Laminar.initialize`, or a v1 OTLP exporter deduped
// from the host app. The helpers below bridge those span shapes. v3 spans
// have the v2 shape.
import { Context, SpanContext } from "@opentelemetry/api";
import { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace";

// Public option types for a span processor / exporter the user hands to
// Laminar. The bundled `@opentelemetry/sdk-trace` types are inlined into our
// .d.ts, and v1's span shape (and its own `ExportResultCode` enum) is not
// assignable to them, so these are structural and take spans as `any`.
// Every OTel JS SDK line satisfies them.
export interface SpanProcessorCompat {
  onStart(span: any, parentContext: Context): void;
  onEnd(span: any): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SpanExporterCompat {
  export(
    spans: any[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

// Type definitions that cover OTel SDK v1, v2 and v3
// In v1: spans have parentSpanId and instrumentationLibrary
// In v2 and v3: spans have parentSpanContext and instrumentationScope
export type OTelSpanCompat = SdkSpan &
  ReadableSpan & {
    parentSpanId?: string;
    parentSpanContext?: SpanContext;
    instrumentationLibrary?: any;
    instrumentationScope?: any;
  };

type OTelReadableSpanCompat = ReadableSpan & {
  parentSpanId?: string;
  parentSpanContext?: SpanContext;
  instrumentationLibrary?: any;
  instrumentationScope?: any;
};

// In-place edits on span object for compatibility between OTel v1 and v2 SDKs
export const makeSpanOtelV2Compatible = (
  span: OTelSpanCompat | OTelReadableSpanCompat,
) => {
  const spanAny = span as any;
  if (spanAny.instrumentationScope && !spanAny.instrumentationLibrary) {
    // Making the spans from V2 compatible with V1
    Object.assign(span, {
      instrumentationLibrary: spanAny.instrumentationScope,
    });
  } else if (spanAny.instrumentationLibrary && !spanAny.instrumentationScope) {
    // Making the spans from V1 compatible with V2
    Object.assign(span, {
      instrumentationScope: spanAny.instrumentationLibrary,
    });
  }

  // Handle parent span compatibility between SDK v1 and v2
  // SDK v1 uses parentSpanId (string), SDK v2 uses parentSpanContext (SpanContext)
  if (spanAny.parentSpanContext && !spanAny.parentSpanId) {
    // SDK v2 -> SDK v1: Extract spanId from parentSpanContext
    Object.defineProperty(span, "parentSpanId", {
      value: spanAny.parentSpanContext.spanId,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else if (spanAny.parentSpanId && !spanAny.parentSpanContext) {
    // SDK v1 -> SDK v2: Create a proper SpanContext object
    // We need to get the traceId from the span's own spanContext
    const spanContext = span.spanContext();
    Object.defineProperty(span, "parentSpanContext", {
      value: {
        traceId: spanContext.traceId,
        spanId: spanAny.parentSpanId,
        traceFlags: spanContext.traceFlags,
        traceState: spanContext.traceState,
        isRemote: spanContext.isRemote,
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
};

export const getParentSpanId = (
  span: OTelSpanCompat | OTelReadableSpanCompat,
): string | undefined => {
  const spanAny = span as any;
  return spanAny.parentSpanContext?.spanId ?? spanAny.parentSpanId;
};
