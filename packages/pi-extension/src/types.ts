// pi event payloads are dynamic JSON objects whose exact shape is internal to
// the pi coding agent, so we treat them as loosely-typed records. `Json` is any
// parsed JSON value. (Mirrors the CC plugin's types.ts.)
export type Json = any;

// ---- pi payload shapes we actually read (documented in wayfinder/findings) ----

/** pi assistant message usage block (see findings/001, findings/005). */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number;
  };
}

/** A pi assistant `message` (the `message` field of a `turn_end`/`message_end` event). */
export interface PiAssistantMessage {
  role: "assistant";
  content: Json[];
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: PiUsage;
  timestamp?: string;
}
