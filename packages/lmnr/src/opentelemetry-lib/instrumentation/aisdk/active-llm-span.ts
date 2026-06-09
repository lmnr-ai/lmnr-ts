import type { Span } from "@opentelemetry/api";

/**
 * Bridge between the v7 telemetry integration and the replay wrapper.
 *
 * On a v7 run the actual `ai.llm` span is created by `LaminarAiSdkTelemetry`
 * (`v7-integration/index.ts`) and parked in its `llmByKey` map — it is NEVER
 * placed on the OTel context. The replay wrapper (`base-language-model.ts`),
 * however, runs as the wrapped `model.doGenerate` / `doStream` and needs to
 * stamp the CACHED boundary on the span that actually serves the reconstructed
 * output. `Laminar.getCurrentSpan()` only sees the on-context operation span
 * (`ai.generateText`), not the parked LLM span, so on a HIT it would mark the
 * wrong span.
 *
 * This module is the missing link: the integration pushes each open LLM span
 * here and removes it when the call ends; the replay wrapper peeks the most
 * recently pushed still-open span at its synchronous call entry. AI SDK fires
 * `onLanguageModelCallStart` immediately before invoking `model.doGenerate`
 * (no `await` in between), so in sequential execution the top of the stack is
 * this exact call's LLM span. On v6 the integration is not used, the stack is
 * empty, and the wrapper falls back to `getCurrentSpan()` (which on v6 IS the
 * live `doGenerate` LLM span the SDK activated on context).
 *
 * This is TS-only AI-SDK glue — NOT part of the cross-language debug parity
 * surface.
 */
const openLlmSpans: Span[] = [];

/** Register an `ai.llm` span as open. Call from the integration's callStart. */
export const pushActiveLlmSpan = (span: Span): void => {
  openLlmSpans.push(span);
};

/** Remove a previously registered span (matched by reference). */
export const removeActiveLlmSpan = (span: Span): void => {
  for (let i = openLlmSpans.length - 1; i >= 0; i--) {
    if (openLlmSpans[i] === span) {
      openLlmSpans.splice(i, 1);
      return;
    }
  }
};

/** Most recently pushed still-open LLM span, or undefined if none. */
export const peekActiveLlmSpan = (): Span | undefined =>
  openLlmSpans.length > 0 ? openLlmSpans[openLlmSpans.length - 1] : undefined;
