// Forward-compatibility with OTel v2 / v0.200 SDKs
import { Resource } from "@opentelemetry/resources";
import { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace-base";
import {
  ReadableSpan as OTelV2ReadableSpan,
  Span as OTelV2Span,
} from "@opentelemetry/sdk-trace-base-v2";

// In-place edits on span object for compatibility between OTel v1 and v2 SDKs
export const makeSpanOtelV2Compatible = (
  span: SdkSpan | OTelV2Span | ReadableSpan | OTelV2ReadableSpan,
) => {
  if ((span as unknown as OTelV2Span).instrumentationScope
    && !(span as unknown as SdkSpan).instrumentationLibrary) {
    // Making the spans from V2 compatible with V1
    Object.assign(span, {
      instrumentationLibrary: (span as unknown as OTelV2Span).instrumentationScope,
    });
  } else if ((span as unknown as SdkSpan).instrumentationLibrary
    && !(span as unknown as OTelV2Span).instrumentationScope) {
    // Making the spans from V1 compatible with V2
    Object.assign(span, {
      instrumentationScope: (span as unknown as SdkSpan).instrumentationLibrary,
    });
  }
};

export const getParentSpanId = (
  span: SdkSpan | OTelV2Span | ReadableSpan | OTelV2ReadableSpan,
): string | undefined => (span as unknown as OTelV2Span).parentSpanContext?.spanId
  ?? (span as unknown as SdkSpan).parentSpanId;

export const createResource = (
  attributes: Record<string, string>,
) =>
  // For v2 this would be:
  // const { resourceFromAttributes } = require("@opentelemetry/resources");
  // return resourceFromAttributes(attributes);
  new Resource(attributes);
