/**
 * A signal's payload schema — the structured output the LLM must return. Every
 * field is required; enums are a string field with an `enum` array.
 */
export interface SignalStructuredOutput {
  type: "object";
  properties: Record<
    string,
    { type: string; description: string; enum?: string[] }
  >;
  required: string[];
}

/**
 * WHEN a signal is evaluated, decided from a single span batch. A closed set,
 * not a column list: these are the only two shapes the backend evaluates, so
 * anything else would be stored and then silently never fire.
 */
export type SignalTrigger =
  | { type: "rootSpanFinished" }
  | { type: "spanName"; spanNames: string[] };

/**
 * WHETHER a fired signal runs — a property of the whole trace. Columns:
 * `total_token_count`, `status`, `span_names`. An empty list runs on every
 * firing trace. Extra keys are preserved so the shape can grow server-side
 * without an SDK release.
 */
export interface SignalFilter {
  column: string;
  operator: string;
  value: unknown;
  [key: string]: unknown;
}

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
  trigger: SignalTrigger;
  filters: SignalFilter[];
  mode: SignalMode;
  /** Workspace LLM profile id; `null` = runs on the server's env LLM. */
  llmProfileId: string | null;
  /** Display name of `llmProfileId`; `null` alongside it. */
  llmProfileName: string | null;
  /** Model pinned within the profile; `null` alongside `llmProfileId`. */
  model: string | null;
}
