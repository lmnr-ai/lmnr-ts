// Narrow structural types for the subset of the `braintrust` SDK we touch.
// We avoid a peer dep by duck-typing at the boundary — the bridge only reads
// fields Braintrust documents on its public `Span` interface and on the
// `logInternal` event shape.

export interface BraintrustSpanAttributes {
  name?: string;
  type?: string;
  [key: string]: unknown;
}

export interface BraintrustLogPartial {
  input?: unknown;
  output?: unknown;
  expected?: unknown;
  error?: unknown;
  tags?: string[];
  scores?: Record<string, number | null>;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  span_attributes?: BraintrustSpanAttributes;
}

export interface BraintrustLogInternalArgs {
  event?: BraintrustLogPartial;
  internalData?: BraintrustLogPartial & {
    span_attributes?: BraintrustSpanAttributes;
    span_parents?: string[];
    metrics?: Record<string, unknown>;
    created?: string;
    context?: Record<string, unknown>;
  };
}

// Duck-typed view of `braintrust`'s `SpanImpl` — enough for the bridge.
export interface BraintrustSpanLike {
  readonly id: string;
  readonly spanId: string;
  readonly rootSpanId: string;
  readonly spanParents: string[];
  // Present on SpanImpl, used to detect "this is a real, live span"
  // (NoopSpan has it set to "span" too, but NoopSpan doesn't flow through
  // logInternal so we never see it at the patch boundary).
  kind?: "span";
  log(event: BraintrustLogPartial): void;
  end(args?: { endTime?: number }): number;
  close(args?: { endTime?: number }): number;
  // Private per TS, but exists at runtime — we patch it because it's the one
  // choke point every log / startup / end call flows through.

  logInternal?(args: BraintrustLogInternalArgs): void;
}

export interface BraintrustBridgeOptions {
  /**
   * When true (default), forceFlush Laminar's span processor after each
   * Braintrust span ends. Useful in tests; costs throughput in production.
   */
  realtime?: boolean;
  /**
   * When true (default), attach Braintrust spans to the active Laminar /
   * OTel span at span-start time so they render as children of the caller's
   * outer wrapper (`Laminar.startActiveSpan`, `observe`, etc.).
   */
  linkToActiveContext?: boolean;
}
