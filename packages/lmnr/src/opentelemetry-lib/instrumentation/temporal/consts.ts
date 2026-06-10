/** Header key used to carry the serialized Laminar span context through Temporal. */
export const LAMINAR_SPAN_CONTEXT_HEADER = "x-lmnr-span-context";

/**
 * W3C traceparent header key — written alongside `laminar-span-context` for
 * interop with non-Laminar clients/workers that understand W3C trace context.
 */
export const TRACEPARENT_HEADER = "traceparent";
