import { errorMessage } from "@lmnr-ai/types";
import { type Span } from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";

const logger = initializeLogger();

// Minimal structural view of the WorkflowClient methods we patch. The real
// types live in @temporalio/client, which is a soft peer-dep we don't import.
interface WorkflowClientLike {
  prototype: {
    start: (...args: unknown[]) => Promise<WorkflowHandleLike>;
    execute: (...args: unknown[]) => Promise<unknown>;
    signalWithStart: (...args: unknown[]) => Promise<WorkflowHandleLike>;
  };
}

interface WorkflowHandleLike {
  result: (...args: unknown[]) => Promise<unknown>;
  cancel: (...args: unknown[]) => Promise<unknown>;
  terminate: (...args: unknown[]) => Promise<unknown>;
}

const _patchedWorkflowClients = new WeakSet<object>();

// `start(workflowTypeOrFunc, options)`: derive a span name from the workflow
// type and read the workflow arguments from `options.args`.
const workflowName = (args: unknown[]): string => {
  const wf = args[0];
  if (typeof wf === "string") {
    return wf;
  }
  const name = (wf as { name?: string } | undefined)?.name;
  return name && name.length > 0 ? name : "temporal.workflow";
};

const workflowArgs = (args: unknown[]): unknown[] | undefined =>
  (args[1] as { args?: unknown[] } | undefined)?.args;

// Wrap a workflow handle so the lifecycle span (started at `start()`) ends on
// the FIRST terminal call — `result()` resolving/rejecting, `cancel()`, or
// `terminate()`. For cancel/terminate we additionally record a dedicated child
// span. The `closed` guard ensures the workflow span is ended exactly once even
// when callers follow the canonical `cancel()` → `result()` pattern.
const wrapHandle = (handle: WorkflowHandleLike, span: Span): void => {
  let closed = false;
  const closeWith = (finalize: () => void): void => {
    if (closed) {
      return;
    }
    closed = true;
    finalize();
    span.end();
  };

  const origResult = handle.result.bind(handle);
  const origCancel = handle.cancel.bind(handle);
  const origTerminate = handle.terminate.bind(handle);

  const childSpanContext = (): string | undefined => {
    try {
      return Laminar.serializeLaminarSpanContext(span) ?? undefined;
    } catch (e) {
      logger.debug(`failed to derive workflow child span parent: ${errorMessage(e)}`);
      return undefined;
    }
  };

  handle.result = async (...args: unknown[]): Promise<unknown> => {
    if (closed) {
      return origResult(...args);
    }
    try {
      const res = await origResult(...args);
      closeWith(() => {
        try {
          (span as LaminarSpan).setOutput(res);
        } catch (e) {
          logger.debug(`failed to set workflow span output: ${errorMessage(e)}`);
        }
      });
      return res;
    } catch (e) {
      closeWith(() => span.recordException(e as Error));
      throw e;
    }
  };

  const wrapTerminating = (
    name: string,
    orig: (...args: unknown[]) => Promise<unknown>,
  ) =>
    async (...args: unknown[]): Promise<unknown> => {
      if (closed) {
        return orig(...args);
      }
      const childSpan = Laminar.startSpan({
        name,
        parentSpanContext: childSpanContext(),
      });
      try {
        const res = await orig(...args);
        childSpan.end();
        closeWith(() => {});
        return res;
      } catch (e) {
        childSpan.recordException(e as Error);
        childSpan.end();
        closeWith(() => span.recordException(e as Error));
        throw e;
      }
    };

  handle.cancel = wrapTerminating("temporal.workflow.cancel", origCancel);
  handle.terminate = wrapTerminating("temporal.workflow.terminate", origTerminate);
};

/**
 * Patch `WorkflowClient.prototype` so a Laminar workflow span tracks each
 * workflow's client-side lifecycle: it starts when `start()` / `signalWithStart()`
 * / `execute()` is called and ends when the workflow completes (`result()`
 * resolves) or is cancelled / terminated.
 *
 * The span is kept active for the duration of the start RPC so that
 * `WorkflowClientInterceptor.start` injects the workflow span's context into the
 * Temporal headers — that is what makes the worker-side workflow and its
 * activities nest under this span.
 *
 * Idempotent — patching the same module object more than once is a no-op.
 */
export const patchWorkflowClient = (clientModule: {
  WorkflowClient?: WorkflowClientLike;
}): void => {
  const WorkflowClient = clientModule.WorkflowClient;
  if (!WorkflowClient?.prototype || _patchedWorkflowClients.has(WorkflowClient)) {
    return;
  }
  _patchedWorkflowClients.add(WorkflowClient);

  const proto = WorkflowClient.prototype;
  const origStart = proto.start;
  const origExecute = proto.execute;
  const origSignalWithStart = proto.signalWithStart;

  // start / signalWithStart return a handle; keep the span open and hand it to
  // wrapHandle so a later terminal call ends it.
  const patchStartLike = (
    orig: (...args: unknown[]) => Promise<WorkflowHandleLike>,
  ) =>
    async function (
      this: unknown,
      ...args: unknown[]
    ): Promise<WorkflowHandleLike> {
      const span = Laminar.startSpan({
        name: workflowName(args),
        input: workflowArgs(args),
      });
      try {
        const handle = await Laminar.withSpan(
          span,
          () => orig.apply(this, args),
          false,
        );
        wrapHandle(handle, span);
        return handle;
      } catch (e) {
        // withSpan already recorded the exception on the span.
        span.end();
        throw e;
      }
    };

  proto.start = patchStartLike(origStart);
  proto.signalWithStart = patchStartLike(origSignalWithStart);

  // execute() starts the workflow and awaits its result in one call, so the
  // whole span lifecycle is local to this method.
  proto.execute = async function (
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const span = Laminar.startSpan({
      name: workflowName(args),
      input: workflowArgs(args),
    });
    try {
      const res = await Laminar.withSpan(
        span,
        () => origExecute.apply(this, args),
        false,
      );
      try {
        (span as LaminarSpan).setOutput(res);
      } catch (e) {
        logger.debug(`failed to set workflow span output: ${errorMessage(e)}`);
      }
      span.end();
      return res;
    } catch (e) {
      span.end();
      throw e;
    }
  };
};
