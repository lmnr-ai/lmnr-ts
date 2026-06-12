// This file runs inside the Temporal workflow V8 sandbox.
// Constraints: no I/O, no crypto.randomUUID(), no Date.now(), no require().
// It must be a standalone entry point so Temporal can bundle it separately.
// Temporal injects a deterministic AsyncLocalStorage into the sandbox global
// scope and re-exports it here (the same one its own UpdateScope/CancellationScope
// rely on), so this import is replay-safe — unlike node:async_hooks directly.
import {
  AsyncLocalStorage,
  type Headers,
  type WorkflowInterceptors,
} from "@temporalio/workflow";

import { LAMINAR_SPAN_CONTEXT_HEADER, TRACEPARENT_HEADER } from "./consts";

// True when the headers map actually carries an injected Laminar / W3C trace
// context. A signal or update may arrive with no injected context (empty or
// undefined headers); in that case we must NOT enter the handler-headers scope,
// or `activeHeaders()` would resolve to that empty map and drop the
// workflow-start trace from any activity / child-workflow scheduled inside the
// handler.
const hasTraceHeaders = (headers: Headers): boolean =>
  headers[LAMINAR_SPAN_CONTEXT_HEADER] != null ||
  headers[TRACEPARENT_HEADER] != null;

// Trace headers from the workflow-start call. Module-level storage is
// per-workflow-sandbox — each workflow execution gets its own V8 module
// instance, so there is no cross-contamination between concurrent workflows on
// the same worker.
let _startHeaders: Headers = {};

// Trace headers scoped to the currently-running signal/update handler
// coroutine. The client `signal` / `startUpdate` interceptors inject their own
// context, distinct from the workflow-start trace; activities scheduled from
// inside such a handler must be parented to the handler's trace, not the
// workflow-start one. Each handler runs as its own coroutine, so
// AsyncLocalStorage keeps its headers isolated from the main workflow path and
// from other concurrent handlers — overwriting the shared `_startHeaders` would
// corrupt those interleaved paths.
const _handlerHeaders = new AsyncLocalStorage<Headers>();

// The trace headers that outbound calls should propagate from: the active
// signal/update handler's headers when one is running, otherwise the
// workflow-start headers.
const activeHeaders = (): Headers =>
  _handlerHeaders.getStore() ?? _startHeaders;


export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      execute: async (input, next) => {
        _startHeaders = input.headers ?? {};
        return next(input);
      },
      handleSignal: async (input, next) => {
        const headers = input.headers ?? {};
        // Only override the active trace when the signal carried its own
        // context — otherwise fall through to the workflow-start headers.
        return hasTraceHeaders(headers)
          ? _handlerHeaders.run(headers, () => next(input))
          : next(input);
      },
      handleUpdate: async (input, next) => {
        const headers = input.headers ?? {};
        // Only override the active trace when the update carried its own
        // context — otherwise fall through to the workflow-start headers.
        return hasTraceHeaders(headers)
          ? _handlerHeaders.run(headers, () => next(input))
          : next(input);
      },
    },
  ],
  outbound: [
    {
      scheduleActivity: async (input, next) =>
        next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        }),
      scheduleLocalActivity: async (input, next) =>
        next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        }),
      startChildWorkflowExecution: async (input, next) =>
        next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        }),
      continueAsNew: async (input, next) =>
        next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        }),
    },
  ],
});

