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

/**
 * The debug-run pointer (§5). Emitted once at process shutdown as a console line
 * and to `${CWD}/.lmnr/last-run.json`. Key order is part of the cross-language
 * parity contract with the Python SDK.
 */
export interface DebugRunPointer {
  trace_id: string;
  session_id: string;
  replay_trace_id: string | null;
  cache_until: string | null;
  debugger_url: string | null;
  started_at: string;
}
