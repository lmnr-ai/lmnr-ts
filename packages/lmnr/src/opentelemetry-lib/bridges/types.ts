import { type InitializeOptions } from "../interfaces";
import { type LaminarSpanProcessor } from "../tracing/processor";

/**
 * Third-party tracing SDKs whose spans Laminar can receive alongside the
 * SDK's own backend: `Laminar.initialize({ bridges: ["langfuse"] })`.
 */
export type LaminarBridge = "langfuse";

/** A key of `instrumentModules`, i.e. one Laminar auto-instrumentation. */
export type InstrumentationKey = keyof NonNullable<
  InitializeOptions["instrumentModules"]
>;

export interface BridgeContext {
  /** The processor of the Laminar pipeline `initialize()` just built. */
  spanProcessor: LaminarSpanProcessor;
}

/**
 * One bridge. Bridges differ in how they hook the other SDK (Langfuse: its
 * tracer provider; others may hook at the network level), so the interface
 * only fixes the lifecycle `Laminar.initialize()` / `shutdown()` drive.
 */
export interface Bridge {
  readonly name: LaminarBridge;
  /**
   * Laminar auto-instrumentations whose spans would duplicate this bridge's.
   * Disabled when the bridge is installed and the user did not pass
   * `instrumentModules`; a warning names them when the user did.
   */
  readonly conflictingInstrumentations: readonly InstrumentationKey[];
  /**
   * Whether the other SDK is installed in a supported version. Logs the
   * reason when it isn't; the bridge is then skipped.
   */
  isAvailable(): boolean;
  /** Called once, after Laminar's tracing is set up. Must not throw. */
  install(ctx: BridgeContext): void;
  /** Called from `Laminar.shutdown()`. Must not throw. */
  uninstall(): void;
  /** Called from `Laminar.flush()`. Optional health check. */
  onFlush?(): void;
}

/**
 * Laminar auto-instrumentations of LLM providers and agent frameworks. Every
 * bridge so far carries LLM spans from the other SDK, so they all conflict
 * with these. Claude Agent SDK, OpenCode and TypeSafe are deliberately absent
 * (no bridged SDK covers them, so nothing is recorded twice), as are the
 * non-LLM ones (browsers, kernel, vector DBs, Temporal). Keep in step with
 * lmnr-python's `LangfuseBridge.conflicting_instruments`.
 */
export const LLM_INSTRUMENTATIONS: readonly InstrumentationKey[] = [
  "OpenAI",
  "openAI",
  "anthropic",
  "cohere",
  "bedrock",
  "together",
  "google_genai",
  "google_aiplatform",
  "openrouter",
  "langchain",
  "openAIAgents",
  "piDurable",
];
