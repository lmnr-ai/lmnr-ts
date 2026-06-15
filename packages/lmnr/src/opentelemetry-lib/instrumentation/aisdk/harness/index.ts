// Public entry points for instrumenting Vercel AI SDK "agent harnesses"
// (`@ai-sdk/harness-claude-code`, `@ai-sdk/harness-codex`, `@ai-sdk/harness-pi`).
//
// These are EXPERIMENTAL and not installed — we wrap a `HarnessAgent` via narrow
// structural typing (`./types`), with NO peer dependency on the harness packages.
//
// CRITICAL architectural finding (LAM-1763): AI SDK's telemetry lifecycle is
// dispatched only from inside Core `generateText` / `streamText` bodies. A
// harness translates its own runtime events into AI SDK stream parts and likely
// does NOT fire the global `AI_SDK_TELEMETRY_INTEGRATIONS` lifecycle. So the
// guaranteed-coverage path is a WRAPPER around `generate` / `stream` that opens
// a turn span and reads the `result`. When a harness configuration DOES route
// through Core telemetry, the `coreTelemetryFired` signal lets us dedupe.

import { errorMessage } from "@lmnr-ai/types";
import { context as contextApi } from "@opentelemetry/api";

import { Laminar } from "../../../../laminar";
import { LaminarContextManager } from "../../../tracing/context";
import {
  aiSdkTelemetry,
  type LaminarAiSdkTelemetry,
  type LaminarAiSdkTelemetryOptions,
} from "../v7-integration/index";
import {
  runWithTurnSignal,
  type TurnSignal,
} from "./core-telemetry-signal";
import { consumeHarnessStream } from "./stream-consumer";
import { openHarnessTurnSpan } from "./turn-span";
import type {
  HarnessAgentLike,
  HarnessGenerateOptionsLike,
  HarnessResultLike,
} from "./types";

export type HarnessTelemetryOptions = LaminarAiSdkTelemetryOptions;

export interface HarnessTelemetry {
  /**
   * Tier-1 integration for the `HarnessAgent` constructor `telemetry` option.
   * When a harness routes through Core generate/stream, this produces the
   * per-step spans and (via the shared signal) lets the wrapper dedupe.
   */
  integration: LaminarAiSdkTelemetry;
}

/**
 * Build the harness telemetry bundle. Pass `.integration` to the `HarnessAgent`
 * constructor's `telemetry` option:
 *
 * ```ts
 * const tel = harnessTelemetry();
 * const agent = instrumentHarnessAgent(
 *   new HarnessAgent({ harness, sandbox, telemetry: tel.integration }),
 * );
 * ```
 */
export const harnessTelemetry = (
  options?: HarnessTelemetryOptions,
): HarnessTelemetry => ({
  integration: aiSdkTelemetry(options),
});

const laminarActive = (): boolean =>
  Laminar.initialized() || !!process.env.LMNR_PROJECT_API_KEY;

const recordOpts = (options?: HarnessTelemetryOptions) => ({
  recordInputs: options?.recordInputs ?? true,
  recordOutputs: options?.recordOutputs ?? true,
});

// Run `fn` inside the turn's span context. We activate BOTH the OTel standard
// context (`contextApi.with` — read by OTel-aware auto-instrumentation and the
// v7 integration's `onStart` via `getActiveSpan`) AND Laminar's ALS stack
// (`runWithIsolatedContext` — read by `LaminarContextManager.getContext()`), so
// any Core-routed v7 spans for this turn parent UNDER the turn span rather than
// the ambient context. Mirrors the `executeTool` sub-agent pattern in
// `v7-integration/index.ts`. The whole thing runs inside a per-turn
// `TurnSignal` frame so a Core-telemetry `onStart` fired by THIS turn flips
// THIS turn's dedupe flag (and only this turn observes it).
const runInTurnContext = <T>(
  handleCtx: Parameters<typeof contextApi.with>[0],
  signal: TurnSignal,
  fn: () => T,
): T =>
  contextApi.with(handleCtx, () =>
    runWithTurnSignal(signal, () => {
      const stack = LaminarContextManager.getContextStack();
      return LaminarContextManager.runWithIsolatedContext(
        [...stack, handleCtx],
        fn,
      );
    }),
  );

// Wrap one non-streaming method (generate / continueGenerate).
const wrapGenerate = (
  agent: HarnessAgentLike,
  original: (options: HarnessGenerateOptionsLike) => unknown,
  name: string,
  options: HarnessTelemetryOptions | undefined,
) => (callOptions: HarnessGenerateOptionsLike): unknown => {
  if (!laminarActive()) return original.call(agent, callOptions);
  const handle = openHarnessTurnSpan({
    name,
    options: callOptions,
    harness: agent.harness,
    ...recordOpts(options),
  });
  // Run the harness call inside the turn context so Core-routed v7 spans nest
  // under the turn span (see runInTurnContext).
  const signal: TurnSignal = { coreTelemetryFired: false };
  let result: unknown;
  try {
    result = runInTurnContext(handle.ctx, signal, () =>
      original.call(agent, callOptions),
    );
  } catch (err) {
    handle.error(err);
    throw err;
  }
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    return (result as Promise<HarnessResultLike>).then(
      (resolved) => {
        handle.finishFromResult(resolved);
        // No stream consumer on the generate path — nothing can record a late
        // `stream.error` event on the live span, so commit the deferred physical
        // end NOW rather than waiting for the macrotask fallback.
        handle.finishTurnSpan();
        return resolved;
      },
      (err: unknown) => {
        handle.error(err);
        throw err instanceof Error ? err : new Error(errorMessage(err));
      },
    );
  }
  // Synchronous result (unusual for a harness, but tolerated).
  handle.finishFromResult(result as HarnessResultLike);
  handle.finishTurnSpan();
  return result;
};

// Wrap one streaming method (stream / continueStream). The turn span is
// finished EAGERLY from the resolved result (so a never-iterated stream can't
// leak it open); child LLM / TOOL spans are synthesized from stream parts
// during iteration and clamped to the parent endTime, unless Core telemetry
// fired during the turn (dedupe) or the turn is already finished.
const wrapStream = (
  agent: HarnessAgentLike,
  original: (options: HarnessGenerateOptionsLike) => unknown,
  name: string,
  options: HarnessTelemetryOptions | undefined,
) => (callOptions: HarnessGenerateOptionsLike): unknown => {
  if (!laminarActive()) return original.call(agent, callOptions);
  const handle = openHarnessTurnSpan({
    name,
    options: callOptions,
    harness: agent.harness,
    ...recordOpts(options),
  });
  // Turn-scoped dedupe signal: a Core-telemetry `onStart` fired DURING this
  // turn (i.e. inside `runInTurnContext`'s ALS frame) flips this turn's flag —
  // and ONLY this turn observes it. Concurrent turns each get their own signal,
  // so turn B firing Core telemetry can never make turn A suppress its
  // synthesized children. `shouldSynthesize()` is read by the consumer on its
  // first part: synthesize only when this turn did NOT route through Core.
  const signal: TurnSignal = { coreTelemetryFired: false };
  const shouldSynthesize = () => !signal.coreTelemetryFired;

  // Run the harness call inside the turn context + signal frame so Core-routed
  // v7 spans created while the harness kicks off / resolves nest under the turn
  // span and flip THIS turn's dedupe signal.
  let result: unknown;
  try {
    result = runInTurnContext(handle.ctx, signal, () =>
      original.call(agent, callOptions),
    );
  } catch (err) {
    handle.error(err);
    throw err;
  }

  const finalize = (resolved: HarnessResultLike): HarnessResultLike => {
    // Re-yield the stream through the consumer so the user still gets it AND we
    // synthesize/collect child LLM / TOOL spans during iteration.
    const consumed = consumeHarnessStream(
      resolved?.stream,
      handle,
      shouldSynthesize,
      // Pass the turn signal so the consumer can re-establish the turn-signal
      // ALS frame around each `iterator.next()`. The frame this `wrapStream`
      // opened around `original.call` has unwound by the time the user iterates,
      // so a harness that routes a step through Core WHILE producing a part
      // needs the consumer's frame for `markCoreTelemetryFired` to flip the flag.
      signal,
    );

    // FINALIZATION MODEL (LAM-1763, round 3) — eager-finalize + child clamp.
    //
    // `resolved` is FULLY settled here: `original.call` already resolved, so
    // `text` / `usage` / `finishReason` / `responseMessages` are replay
    // aggregates available NOW. We therefore finish the turn span EAGERLY from
    // `resolved` for BOTH the absent-stream and present-stream paths. This is
    // the only design that CANNOT leak: it runs unconditionally the moment the
    // harness call resolves, so a caller that takes `result.stream` and never
    // touches it (the round-3 leak) still gets a finished turn span with
    // output/usage — we no longer depend on the generator's `finally` (which a
    // dropped, never-iterated generator never runs) as the sole finisher.
    //
    // The live stream is NOT needed to finalize the TURN — it is only needed to
    // synthesize CHILD spans, and children only exist if the user iterates. So
    // the wrapped generator now ONLY synthesizes + ends children (it no longer
    // finishes the turn). Because the parent is already finished before any
    // (possibly deferred) iteration, the consumer clamps every synthesized
    // child's `.end()` to `handle.parentEndTime()` — exactly like
    // `endOrphanChildSpansForCallId` clamps in the v7 path — so
    // child.endTime <= parent.endTime holds even when synthesis happens after
    // the eager parent finish. And once the turn is `finished` (here, or via an
    // earlier abort/error), the consumer SKIPS child synthesis entirely, so no
    // orphan child is ever created outside the parent window. This reconciles
    // with issue #2 (abort-then-drain): one finish, children clamped, synthesis
    // skipped after finish.
    handle.finishFromResult(resolved);
    if (consumed.consumed) {
      // Present, consumable stream: DEFER the physical end so the consumer's
      // `finally` can record a mid-iteration `stream.error` event on the live
      // span before committing it (`handle.finishTurnSpan()`). The macrotask
      // fallback (scheduled by `finishFromResult`) guarantees the end even if
      // the stream is never iterated. Return a shallow clone so we don't mutate
      // the harness's own object.
      return { ...resolved, stream: consumed.stream };
    }
    // No consumable stream — nothing will record a late event, so commit the
    // deferred end now instead of waiting for the macrotask fallback.
    handle.finishTurnSpan();
    return resolved;
  };

  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    return (result as Promise<HarnessResultLike>).then(finalize, (err) => {
      handle.error(err);
      throw err instanceof Error ? err : new Error(errorMessage(err));
    });
  }
  return finalize(result as HarnessResultLike);
};

/**
 * Return the same `HarnessAgent` instance with `generate` / `stream` /
 * `continueGenerate` / `continueStream` wrapped to emit Laminar spans. Mirrors
 * `instrumentClaudeAgentQuery`'s wrapping style.
 *
 * No-op (returns the agent untouched) when Laminar is not initialized.
 */
export const instrumentHarnessAgent = <T extends HarnessAgentLike>(
  agent: T,
  options?: HarnessTelemetryOptions,
): T => {
  if (!agent || typeof agent !== "object") return agent;

  if (typeof agent.generate === "function") {
    const original = agent.generate.bind(agent);
    agent.generate = wrapGenerate(agent, original, "harness.generate", options);
  }
  if (typeof agent.continueGenerate === "function") {
    const original = agent.continueGenerate.bind(agent);
    agent.continueGenerate = wrapGenerate(
      agent,
      original,
      "harness.continueGenerate",
      options,
    );
  }
  if (typeof agent.stream === "function") {
    const original = agent.stream.bind(agent);
    agent.stream = wrapStream(agent, original, "harness.stream", options);
  }
  if (typeof agent.continueStream === "function") {
    const original = agent.continueStream.bind(agent);
    agent.continueStream = wrapStream(
      agent,
      original,
      "harness.continueStream",
      options,
    );
  }
  return agent;
};
