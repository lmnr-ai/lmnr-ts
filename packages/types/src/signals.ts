/**
 * A signal's payload schema — the structured output the LLM must return. Every
 * field is required (the UI drawer marks them all required); enums are a string
 * field with an `enum` array.
 */
export interface SignalStructuredOutput {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

/**
 * A signal trigger. The two lists mean different things and are NOT
 * interchangeable:
 *
 * - `conditions` — WHEN the signal is evaluated. Decidable from one span batch
 *   (`root_span_finished`, `span_name`). An EMPTY list never fires.
 * - `filters` — WHETHER a fired trigger runs. Properties of the whole trace
 *   (`total_token_count`, `status`, `span_names`). An empty list passes.
 *
 * Note `span_name` (condition, this batch only) and `span_names` (filter,
 * anywhere in the trace) are DIFFERENT columns.
 */
export interface SignalTrigger {
  id?: string;
  conditions: SignalFilter[];
  filters: SignalFilter[];
  createdAt?: string;
  /** 0 = batch, 1 = realtime */
  mode?: number;
}

export interface SignalFilter {
  column: string;
  operator: string;
  value: string | number | string[];
}

export interface Signal {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  structuredOutput: SignalStructuredOutput;
  sampleRate: number | null;
  disabled: boolean;
  createdAt: string;
  triggers: SignalTrigger[];
}
