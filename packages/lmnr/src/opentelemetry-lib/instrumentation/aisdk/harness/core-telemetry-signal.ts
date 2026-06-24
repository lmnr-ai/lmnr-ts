// Dedupe bridge between the v7 Core-telemetry integration
// (`v7-integration/index.ts`) and the harness `stream-consumer`.
//
// A Vercel AI SDK "harness" (`@ai-sdk/harness-*`) translates its own runtime
// events into AI SDK stream parts. In most cases it does NOT dispatch the
// global `AI_SDK_TELEMETRY_INTEGRATIONS` lifecycle that `LaminarAiSdkTelemetry`
// relies on — so the harness wrapper (`harness/index.ts`) has to synthesize the
// per-step LLM / TOOL spans itself from `result.stream`. But SOME harness
// configurations DO route through Core `generateText` / `streamText`, in which
// case our v7 integration has already created those spans. Re-synthesizing them
// from the stream would double them.
//
// Dedupe correlation is TURN-SCOPED, not process-global. The harness wrapper
// opens a turn and runs the harness call inside an AsyncLocalStorage frame that
// carries a fresh `TurnSignal` (see `runWithTurnSignal`). When the harness
// routes through Core, the v7 integration's `onStart` runs INSIDE that same ALS
// frame (because the wrapper also activated the turn context), so
// `markCoreTelemetryFired` flips the flag on THIS turn's signal — and only this
// turn observes it. Concurrent turns each have their own signal, so a Core
// dispatch in turn B can never make turn A suppress its synthesized children.
//
// There is no per-callId Set and no process-global counter: the signal lives
// only for the lifetime of the ALS frame, so a v7 op fired outside any harness
// turn (the common case) sees `getActiveTurnSignal() === undefined` and
// `markCoreTelemetryFired` is a cheap no-op — nothing is retained, so there is
// no unbounded growth.
//
// This is TS-only AI-SDK glue — NOT part of the cross-language debug parity
// surface.

import { AsyncLocalStorage } from "node:async_hooks";

/** A per-turn mutable flag observed only by the turn that owns it. */
export interface TurnSignal {
  /** Set true the first time Core telemetry fires inside this turn's frame. */
  coreTelemetryFired: boolean;
}

const turnSignalStore = new AsyncLocalStorage<TurnSignal>();

/**
 * Run `fn` inside a fresh turn signal frame. Any `markCoreTelemetryFired` call
 * that happens (synchronously or via awaited continuations) inside `fn` flips
 * THIS signal — concurrent turns get independent signals. Returns the same
 * `signal` object the caller can read after `fn` settles.
 */
export const runWithTurnSignal = <T>(
  signal: TurnSignal,
  fn: () => T,
): T => turnSignalStore.run(signal, fn);

/** The turn signal active in the current ALS frame, if any. */
export const getActiveTurnSignal = (): TurnSignal | undefined =>
  turnSignalStore.getStore();

/**
 * Record that Core telemetry fired. Called from the v7 integration's `onStart`
 * for EVERY v7 op process-wide — so it must stay cheap and leak-free when no
 * harness is in use. Outside a harness turn there is no active signal and this
 * is a no-op that retains nothing. Inside a turn it flips that turn's flag,
 * which the wrapper reads to dedupe synthesized children.
 */
export const markCoreTelemetryFired = (): void => {
  const signal = turnSignalStore.getStore();
  if (signal) signal.coreTelemetryFired = true;
};
