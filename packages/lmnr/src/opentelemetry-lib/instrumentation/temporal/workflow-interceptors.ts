// This file runs inside the Temporal workflow V8 sandbox.
// Constraints: no I/O, no crypto.randomUUID(), no Date.now(), no require().
// It must be a standalone entry point so Temporal can bundle it separately.
import type { WorkflowInterceptors } from "@temporalio/workflow";

// Module-level storage is per-workflow-sandbox — each workflow execution gets
// its own V8 module instance, so there is no cross-contamination between
// concurrent workflows on the same worker.
let _headers: Record<string, unknown> = {};

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async (input: any, next: any) => {
        _headers = (input.headers as Record<string, unknown>) ?? {};
        return next(input);
      },
    },
  ],
  outbound: [
    {
      scheduleActivity: async (input, next) => {
        return next({
          ...input,
          headers: { ..._headers, ...input.headers },
        });
      },
      scheduleLocalActivity: async (input, next) => {
        return next({
          ...input,
          headers: { ..._headers, ...input.headers },
        });
      },
    },
  ],
});
