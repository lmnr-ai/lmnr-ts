import { createContextKey, trace } from "@opentelemetry/api";
import { Context } from "@opentelemetry/api/build/src/context/types";

const TRACER_NAME = "lmnr.tracer";
export const SPAN_PATH_KEY = createContextKey("span_path");
export const ASSOCIATION_PROPERTIES_KEY = createContextKey(
  "association_properties",
);

export const getTracer = () => trace.getTracer(TRACER_NAME);

export const getSpanPath = (entityContext: Context): string | undefined => {
  const path = entityContext.getValue(SPAN_PATH_KEY) as string | undefined;

  return path ? `${path}` : undefined;
};
