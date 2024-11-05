import { SpanAttributes } from '@traceloop/ai-semantic-conventions';

export const SPAN_INPUT = "lmnr.span.input";
export const SPAN_OUTPUT = "lmnr.span.output";
export const SPAN_TYPE = "lmnr.span.type";
export const SPAN_PATH = "lmnr.span.path";
export const SPAN_INSTRUMENTATION_SOURCE = "lmnr.span.instrumentation_source";
export const OVERRIDE_PARENT_SPAN = "lmnr.internal.override_parent_span";

export const ASSOCIATION_PROPERTIES = "lmnr.association.properties";
export const SESSION_ID = "lmnr.association.properties.session_id";
export const USER_ID = "lmnr.association.properties.user_id";
export const TRACE_TYPE = "lmnr.association.properties.trace_type";

export const ASSOCIATION_PROPERTIES_OVERRIDES: Record<string, string> = {
  "span_type": SPAN_TYPE,
};

export const LaminarAttributes = {
  // == This is the minimum set of attributes for a proper LLM span ==
  //
  // not SpanAttributes.LLM_USAGE_PROMPT_TOKENS
  INPUT_TOKEN_COUNT: "gen_ai.usage.input_tokens",
  // not SpanAttributes.LLM_USAGE_COMPLETION_TOKENS
  OUTPUT_TOKEN_COUNT: "gen_ai.usage.output_tokens",
  TOTAL_TOKEN_COUNT: SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
  PROVIDER: SpanAttributes.LLM_SYSTEM,
  REQUEST_MODEL: SpanAttributes.LLM_REQUEST_MODEL,
  RESPONSE_MODEL: SpanAttributes.LLM_RESPONSE_MODEL,
  //
  // == End of minimum set ==
  // == Additional attributes ==
  //
  INPUT_COST: "gen_ai.usage.input_cost",
  OUTPUT_COST: "gen_ai.usage.output_cost",
  TOTAL_COST: "gen_ai.usage.cost",
  //
  // == End of additional attributes ==
};
