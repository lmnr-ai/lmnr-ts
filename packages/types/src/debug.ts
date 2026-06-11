/**
 * A single cached LLM response served by a debug-replay cache HIT. The provider
 * wrappers consume `output` (a JSON string) and `attributes` to reconstruct the
 * call result; `name`/`input` are unused by replay.
 */
export interface CachedSpan {
  name: string;
  input: string; // JSON string
  output: string; // JSON string
  attributes: Record<string, any>; // already parsed
}
