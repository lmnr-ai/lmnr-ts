// This file runs inside the Temporal workflow V8 sandbox.
// Constraints: no I/O, no crypto.randomUUID(), no Date.now(), no require().
// It must be a standalone entry point so Temporal can bundle it separately.
// Temporal injects a deterministic AsyncLocalStorage into the sandbox global
// scope and re-exports it here (the same one its own UpdateScope/CancellationScope
// rely on), so this import is replay-safe — unlike node:async_hooks directly.
import { AsyncLocalStorage, type WorkflowInterceptors } from "@temporalio/workflow";

// Trace headers from the workflow-start call. Module-level storage is
// per-workflow-sandbox — each workflow execution gets its own V8 module
// instance, so there is no cross-contamination between concurrent workflows on
// the same worker.
let _startHeaders: Record<string, unknown> = {};

// Trace headers scoped to the currently-running signal handler coroutine. The
// client `signal` interceptor injects its own context, distinct from the
// workflow-start trace; activities scheduled from inside a signal handler must
// be parented to the signal's trace, not the workflow-start one. A signal
// handler runs as its own coroutine, so AsyncLocalStorage keeps its headers
// isolated from the main workflow path and from other concurrent handlers —
// overwriting the shared `_startHeaders` would corrupt those interleaved paths.
const _signalHeaders = new AsyncLocalStorage<Record<string, unknown>>();

// The trace headers that outbound calls should propagate from: the active
// signal handler's headers when one is running, otherwise the workflow-start
// headers.
const activeHeaders = (): Record<string, unknown> =>
  _signalHeaders.getStore() ?? _startHeaders;

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async (input: any, next: any) => {
        _startHeaders = (input.headers as Record<string, unknown>) ?? {};
        return next(input);
      },
      handleSignal: async (input: any, next: any) => {
        const headers = (input.headers as Record<string, unknown>) ?? {};
        return _signalHeaders.run(headers, () => next(input));
      },
    },
  ],
  outbound: [
    {
      scheduleActivity: async (input, next) => {
        return next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        });
      },
      scheduleLocalActivity: async (input, next) => {
        return next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        });
      },
      startChildWorkflowExecution: async (input, next) => {
        return next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        });
      },
      continueAsNew: async (input, next) => {
        return next({
          ...input,
          headers: { ...activeHeaders(), ...input.headers },
        });
      },
    },
  ],
});
