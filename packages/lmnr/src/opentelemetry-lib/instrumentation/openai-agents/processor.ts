import type {
  Span as AgentsSpan,
  SpanData,
  Trace,
  TracingProcessor,
} from "@openai/agents";
import {
  ROOT_CONTEXT,
  type Span as OtelSpan,
} from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";
import {
  DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY,
  mapSpanType,
  nameFromSpanData,
  spanKind,
  spanName,
} from "./helpers";
import { applySpanData, applySpanError } from "./span-data";

const logger = initializeLogger();

interface SpanEntry {
  lmnrSpan: OtelSpan;
  agentsSpan: AgentsSpan<SpanData>;
}

interface TraceState {
  rootSpan: OtelSpan | undefined;
  spans: Map<string, SpanEntry>;
  // When true, the trace has been marked as ended (via onTraceEnd or shutdown)
  // and we should not write any more spans into it.
  ended: boolean;
  // Maps destination agent name -> handoff parent Laminar span context so the
  // subsequent agent span becomes a sibling of the handoff span (both children
  // of the handoff's parent).
  pendingHandoffCtxs: Map<string, string>;
}

/* eslint-disable @typescript-eslint/require-await */
export class LaminarAgentsTraceProcessor implements TracingProcessor {
  private traces: Map<string, TraceState> = new Map();
  private disabled: boolean = false;

  start(): void {
    // Nothing to do - we don't run an export loop.
  }

  async onTraceStart(trace: Trace): Promise<void> {
    if (this.disabled) {
      return;
    }
    const traceId = trace.traceId;
    if (!traceId) {
      return;
    }
    try {
      const state = this.getOrCreateTrace(trace);

      // Update root span name to the actual trace name (it defaults to
      // "agents.trace" at creation time; see getOrCreateTrace).
      const traceName = trace.name;
      if (traceName && state.rootSpan !== undefined) {
        try {
          state.rootSpan.updateName(traceName);
        } catch {
          // ignore
        }
      }
      this.applyTraceMetadata(state.rootSpan, trace);
    } catch (e) {
      logger.debug(`Error in onTraceStart: ${String(e)}`);
    }
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    if (this.disabled) {
      return;
    }
    const traceId = trace.traceId;
    if (!traceId) {
      return;
    }
    const state = this.traces.get(traceId);
    if (!state || state.ended) {
      return;
    }
    state.ended = true;
    this.endTraceState(state);
    this.traces.delete(traceId);
  }

  async onSpanStart(span: AgentsSpan<SpanData>): Promise<void> {
    if (this.disabled) {
      return;
    }
    const traceId = span.traceId;
    if (!traceId) {
      return;
    }
    let lmnrSpan: OtelSpan | undefined;
    try {
      const state = this.getOrCreateTrace(span);

      let parentSpanContext: string | undefined;

      const spanData = span.spanData;

      // If this is an agent span, check if a handoff targeting this agent is
      // pending. If so, make this span a child of the handoff's parent so the
      // subagent is nested correctly.
      if (spanKind(spanData) === "agent") {
        const thisAgentName = nameFromSpanData(
          (spanData as any)?.name ?? spanData,
        );
        const handoffCtx = state.pendingHandoffCtxs.get(thisAgentName);
        if (handoffCtx !== undefined) {
          state.pendingHandoffCtxs.delete(thisAgentName);
          parentSpanContext = handoffCtx;
        }
      }

      // Resolve the parent Laminar span explicitly via the agents SDK's
      // parentId (or falling back to the trace's root span). Relying on
      // LaminarContextManager.getContext() would consult a process-global
      // stack, which is unsafe when multiple agent runs execute concurrently.
      if (parentSpanContext === undefined) {
        const parentId = span.parentId;
        const parentEntry = parentId != null
          ? state.spans.get(parentId)
          : undefined;
        const parentLmnrSpan = parentEntry !== undefined
          ? parentEntry.lmnrSpan
          : state.rootSpan;
        if (parentLmnrSpan !== undefined) {
          try {
            const ctx = (parentLmnrSpan as LaminarSpan)
              .getLaminarSpanContext?.();
            if (ctx) {
              parentSpanContext = JSON.stringify(ctx);
            }
          } catch {
            // ignore
          }
        }
      }

      const spanType = mapSpanType(spanData);
      const name = spanName(span, spanData);

      // Mark the context so any future OpenAI Responses API instrumentation
      // (on the TS side) knows to skip — the agents run already records a
      // matching span for this underlying HTTP call. Start from ROOT_CONTEXT
      // (not getContext()) so the per-trace parent we resolved above — rather
      // than whatever happens to be globally active on the shared stack —
      // determines hierarchy. This keeps concurrent traces isolated.
      const ctx = ROOT_CONTEXT.setValue(
        DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY,
        true,
      );

      lmnrSpan = Laminar.startActiveSpan({
        name,
        spanType,
        parentSpanContext,
        context: ctx,
      });

      const key = span.spanId;
      if (!key) {
        logger.debug("Span missing spanId, cannot track");
        try {
          lmnrSpan.end();
        } catch {
          // ignore
        }
        return;
      }
      state.spans.set(key, { lmnrSpan, agentsSpan: span });
    } catch (e) {
      logger.debug(`Error in onSpanStart: ${String(e)}`);
      if (lmnrSpan !== undefined) {
        try {
          lmnrSpan.end();
        } catch {
          // ignore
        }
      }
    }
  }

  async onSpanEnd(span: AgentsSpan<SpanData>): Promise<void> {
    if (this.disabled) {
      return;
    }
    const traceId = span.traceId;
    if (!traceId) {
      return;
    }

    const key = span.spanId;
    if (!key) {
      return;
    }

    const state = this.traces.get(traceId);
    const entry = state?.spans.get(key);
    if (!entry || !state) {
      return;
    }
    state.spans.delete(key);

    const spanData = span.spanData;
    try {
      try {
        applySpanData(entry.lmnrSpan, spanData);
        applySpanError(entry.lmnrSpan, span);
      } catch {
        // ignore
      }

      // When a handoff span ends, save the *parent* span's Laminar context keyed
      // by the destination agent name. The next agent span's start will consume
      // this so it becomes a sibling of the handoff span.
      if (spanKind(spanData) === "handoff") {
        try {
          const toAgent = nameFromSpanData((spanData as any)?.to_agent);
          if (toAgent) {
            const parentId = span.parentId;
            const parentEntry = parentId != null
              ? state.spans.get(parentId)
              : undefined;
            const parentLmnrSpan = parentEntry !== undefined
              ? parentEntry.lmnrSpan
              : state.rootSpan;
            if (parentLmnrSpan !== undefined) {
              const handoffCtx = (parentLmnrSpan as LaminarSpan)
                .getLaminarSpanContext?.();
              if (handoffCtx) {
                state.pendingHandoffCtxs.set(toAgent, JSON.stringify(handoffCtx));
              }
            }
          }
        } catch {
          // ignore
        }
      }

      try {
        entry.lmnrSpan.end();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async shutdown(_timeout?: number): Promise<void> {
    this.disabled = true;
    const states = Array.from(this.traces.values()).filter((s) => !s.ended);
    for (const s of states) {
      s.ended = true;
    }
    this.traces.clear();
    for (const state of states) {
      this.endTraceState(state);
    }
    try {
      await Laminar.flush();
    } catch {
      // ignore
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await Laminar.flush();
    } catch {
      // ignore
    }
  }

  private endTraceState(state: TraceState): void {
    // End all child spans (LIFO) then the root span.
    const remaining = Array.from(state.spans.values());
    state.spans.clear();
    for (let i = remaining.length - 1; i >= 0; i--) {
      const entry = remaining[i];
      try {
        const spanData = entry.agentsSpan?.spanData;
        applySpanData(entry.lmnrSpan, spanData);
        applySpanError(entry.lmnrSpan, entry.agentsSpan);
      } catch {
        // ignore
      }
      try {
        entry.lmnrSpan.end();
      } catch {
        // ignore
      }
    }
    try {
      state.rootSpan?.end();
    } catch {
      // ignore
    }
  }

  private getOrCreateTrace(
    traceOrSpan: Trace | AgentsSpan<SpanData>,
  ): TraceState {
    let traceId: string | undefined = (traceOrSpan as any).traceId;
    if (!traceId) {
      traceId = "unknown";
    }
    const existing = this.traces.get(traceId);
    if (existing) {
      return existing;
    }

    // Generic name; onTraceStart will update it to the actual trace name.
    // Start from ROOT_CONTEXT so the root span of a concurrently-running
    // agent trace cannot become a child of another trace's currently-active
    // span on the shared async context.
    const rootSpan = Laminar.startActiveSpan({
      name: "agents.trace",
      context: ROOT_CONTEXT,
    });
    const state: TraceState = {
      rootSpan,
      spans: new Map(),
      ended: false,
      pendingHandoffCtxs: new Map(),
    };
    this.traces.set(traceId, state);
    return state;
  }

  private applyTraceMetadata(
    rootSpan: OtelSpan | undefined,
    trace: Trace,
  ): void {
    if (rootSpan === undefined) {
      return;
    }
    const metadata: Record<string, any> = {};
    const traceMetadata = trace.metadata;
    if (traceMetadata !== undefined && traceMetadata !== null) {
      Object.assign(metadata, traceMetadata);
    }
    const groupId = trace.groupId;
    if (groupId) {
      metadata["openai.agents.group_id"] = groupId;
    }
    if (trace.name) {
      metadata["openai.agents.trace_name"] = trace.name;
    }
    if (Object.keys(metadata).length > 0) {
      try {
        (rootSpan as LaminarSpan).setTraceMetadata?.(metadata);
      } catch {
        // ignore
      }
    }
    const sessionId = metadata.session_id;
    const userId = metadata.user_id;
    if (sessionId) {
      try {
        (rootSpan as LaminarSpan).setTraceSessionId?.(String(sessionId));
      } catch {
        // ignore
      }
    }
    if (userId) {
      try {
        (rootSpan as LaminarSpan).setTraceUserId?.(String(userId));
      } catch {
        // ignore
      }
    }
  }
}
/* eslint-enable @typescript-eslint/require-await */
