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
 * WHEN a signal is evaluated, decided from a single span batch. A closed set,
 * not a column list: these are the only two shapes the backend evaluates, so
 * anything else would be stored and then silently never fire.
 *
 * - `rootSpanFinished` — the trace's root span finished. Right for most traces.
 * - `spanName` — a span with any of these names finished. For distributed traces
 *   where no single span is observably the root.
 *
 * A signal with a `null` trigger never fires on its own and runs only via
 * backfill.
 */
export type SignalTrigger =
  | { type: "rootSpanFinished" }
  | { type: "spanName"; spanNames: string[] };

/**
 * WHETHER a fired signal actually runs — a property of the whole trace, read
 * from its cumulative state. Columns: `total_token_count`, `status`,
 * `span_names`. An empty filter list passes, i.e. runs on every firing trace.
 *
 * Note `span_names` (a filter, matched anywhere in the trace) is a different
 * thing from the `spanName` TRIGGER, which sees only the firing batch.
 */
export interface SignalFilter {
  column: string;
  operator: string;
  value: string | number | string[];
}

/** How a fired signal runs. Realtime is faster and costs ~2x batch. */
export type SignalMode = "batch" | "realtime";

export interface Signal {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  structuredOutput: SignalStructuredOutput;
  sampleRate: number | null;
  disabled: boolean;
  createdAt: string;
  /** `null` when the signal never fires on its own (backfill only). */
  trigger: SignalTrigger | null;
  filters: SignalFilter[];
  mode: SignalMode;
}
