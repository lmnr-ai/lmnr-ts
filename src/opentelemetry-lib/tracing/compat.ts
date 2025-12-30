// Forward-compatibility with OTel v2 / v0.200 SDKs
import { SpanContext } from "@opentelemetry/api";
import { IResource } from "@opentelemetry/resources";
import { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace-base";

// Type definitions that cover both OTel SDK v1 and v2
// In v1: spans have parentSpanId and instrumentationLibrary
// In v2: spans have parentSpanContext and instrumentationScope
type OTelSpanCompat = (SdkSpan | ReadableSpan) & {
  parentSpanId?: string;
  parentSpanContext?: SpanContext;
  instrumentationLibrary?: any;
  instrumentationScope?: any;
};

// In-place edits on span object for compatibility between OTel v1 and v2 SDKs
export const makeSpanOtelV2Compatible = (
  span: OTelSpanCompat,
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
    Object.defineProperty(span, 'parentSpanId', {
      value: spanAny.parentSpanContext.spanId,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else if (spanAny.parentSpanId && !spanAny.parentSpanContext) {
    // SDK v1 -> SDK v2: Create a proper SpanContext object
    // We need to get the traceId from the span's own spanContext
    const spanContext = span.spanContext();
    Object.defineProperty(span, 'parentSpanContext', {
      value: {
        traceId: spanContext.traceId,
        spanId: spanAny.parentSpanId,
        traceFlags: spanContext.traceFlags,
        traceState: undefined,
        isRemote: false,
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
};

export const getParentSpanId = (
  span: OTelSpanCompat,
): string | undefined => {
  const spanAny = span as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return spanAny.parentSpanContext?.spanId ?? spanAny.parentSpanId;
};

/**
 * Creates a Resource object compatible with both OTel v1 and v2.
 *
 * In v1, Resource is a class constructor: new Resource(attributes)
 * In v2, Resource class is not exported; use resourceFromAttributes(attributes) instead
 *
 * This function automatically detects which version is available and uses the appropriate API.
 */
export const createResource = (
  attributes: Record<string, string>,
): IResource => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resources = require("@opentelemetry/resources");

    // v2 uses resourceFromAttributes (0.200+ SDK, 2.x API)
    if (resources.resourceFromAttributes) {
      return resources.resourceFromAttributes(attributes);
    }

    // v1 uses Resource constructor (0.57.x SDK, 1.x API)
    if (resources.Resource) {
      return new resources.Resource(attributes);
    }

    throw new Error("Unable to create Resource: neither v1 nor v2 API found");
  } catch (error) {
    throw new Error(
      `Failed to create Resource: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
