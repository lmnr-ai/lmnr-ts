import { errorMessage } from "@lmnr-ai/types";
import { ROOT_CONTEXT } from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { LaminarSpan } from "../../tracing/span";
import { buildHeaders, restoreContextFromHeaders } from "./helpers";

/**
 * Options for Laminar Temporal interceptors.
 */
export interface LaminarTemporalInterceptorOptions {
  /**
   * Whether the activity inbound interceptor should wrap each activity
   * execution in a Laminar span named after the activity type.
   *
   * Defaults to `true`. Set to `false` if you want only context restoration
   * (letting your own `observe()` calls act as roots inside the activity).
   */
  createActivitySpan?: boolean;

  /**
   * Whether to record the activity's arguments as the span input.
   *
   * Defaults to `true`. Set to `false` to omit potentially large or sensitive
   * activity arguments from the span. Ignored when `createActivitySpan` is
   * `false`.
   */
  recordActivityArgs?: boolean;

  /**
   * Whether to record the activity's return value as the span output.
   *
   * Defaults to `true`. Set to `false` to omit potentially large or sensitive
   * activity results from the span. Ignored when `createActivitySpan` is
   * `false`.
   */
  recordActivityOutput?: boolean;
}

// Inject Laminar span-context headers and forward, preserving input/output types.
// T is unconstrained so Temporal's concrete input types (some of which lack a
// `headers` field entirely) are accepted without an index-signature requirement.
const withLaminarHeaders = async <T, R>(
  input: T,
  next: (i: T) => Promise<R>,
): Promise<R> => {
  const existing = (input as { headers?: Record<string, unknown> }).headers;
  return next({
    ...(input as object),
    headers: buildHeaders(existing ?? {}),
  } as T);
};

const withLaminarHeadersIterable = <T, R>(
  input: T,
  next: (i: T) => AsyncIterable<R>,
): AsyncIterable<R> => {
  const existing = (input as { headers?: Record<string, unknown> }).headers;
  return next({
    ...(input as object),
    headers: buildHeaders(existing ?? {}),
  } as T);
};

// ─── WorkflowClientInterceptor ────────────────────────────────────────────────

/**
 * Temporal client-side workflow interceptor. Injects the active Laminar span context
 * into every workflow-start / signal / query / update-start call via headers.
 *
 * **Explicit usage:**
 * ```typescript
 * const client = new Client({
 *   interceptors: {
 *     workflow: [new LaminarTemporalInterceptors.WorkflowClientInterceptor()],
 *   },
 * });
 * ```
 */
export class WorkflowClientInterceptor {
  async start<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async startWithDetails<T, R>(
    input: T,
    next: (i: T) => Promise<R>,
  ): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async startUpdate<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async startUpdateWithStart<T, R>(
    input: T,
    next: (i: T) => Promise<R>,
  ): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async signal<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async signalWithStart<T, R>(
    input: T,
    next: (i: T) => Promise<R>,
  ): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async query<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async terminate<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async describe<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }
}

// ─── ScheduleClientInterceptor ────────────────────────────────────────────────

/**
 * Temporal client-side schedule interceptor.
 *
 * Deliberately a no-op: it does NOT inject Laminar trace headers on schedule
 * `create`. A Schedule is a long-lived server-side object, and the headers
 * attached to its workflow-start action are a stored template replayed on every
 * triggered run — runs that may fire hours or days later. Injecting the active
 * span at creation time would pin every future scheduled run to that single,
 * long-dead parent trace instead of letting each run start its own root trace.
 * Temporal exposes no per-run client-side hook to inject fresh context, so the
 * correct behavior is to forward unchanged and let each triggered workflow be
 * its own root.
 *
 * Kept as a registered interceptor (rather than omitted) so the wiring stays
 * explicit and stable, and so future per-run context support has a home.
 *
 * **Explicit usage:**
 * ```typescript
 * const client = new Client({
 *   interceptors: {
 *     schedule: [new LaminarTemporalInterceptors.ScheduleClientInterceptor()],
 *   },
 * });
 * ```
 */
export class ScheduleClientInterceptor {
  async create<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return next(input);
  }
}

/**
 * Warning: Standalone Activities are experimental in Temporal. If the API changes,
 * this interceptor may not work as expected.
 * Temporal client-side activity interceptor. Injects the active Laminar span context
 * into every activity start / terminate call via headers.
 *
 * **Explicit usage:**
 * ```typescript
 * const client = new Client({
 *   interceptors: {
 *     schedule: [new LaminarTemporalInterceptors.ScheduleClientInterceptor()],
 *   },
 * });
 * ```
 */
export class ActivityClientInterceptor {
  async start<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async getResult<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async describe<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async cancel<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  async terminate<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }

  list<T, R>(input: T, next: (i: T) => AsyncIterable<R>): AsyncIterable<R> {
    return withLaminarHeadersIterable(input, next);
  }

  async count<T, R>(input: T, next: (i: T) => Promise<R>): Promise<R> {
    return withLaminarHeaders(input, next);
  }
}

// ─── ActivityInboundInterceptor ───────────────────────────────────────────────

/**
 * Temporal worker-side interceptor. Reads the Laminar span context from
 * Temporal headers and restores it as the parent context before each activity
 * executes. When `createActivitySpan` is `true` (default), also wraps the
 * activity in a Laminar span named after the activity type.
 *
 * **Explicit usage:**
 * ```typescript
 * const worker = await Worker.create({
 *   interceptors: {
 *     activityInbound: [
 *       () => new LaminarTemporalInterceptors.ActivityInboundInterceptor(),
 *     ],
 *   },
 * });
 * ```
 */
class ActivityInboundInterceptor {
  readonly createActivitySpan: boolean;
  readonly recordActivityArgs: boolean;
  readonly recordActivityOutput: boolean;
  readonly activityType: string | undefined;
  readonly logger;

  constructor(
    options: LaminarTemporalInterceptorOptions = {},
    activityContext?: any,
  ) {
    this.createActivitySpan = options.createActivitySpan ?? true;
    this.recordActivityArgs = options.recordActivityArgs ?? true;
    this.recordActivityOutput = options.recordActivityOutput ?? true;
    this.activityType = activityContext?.info?.activityType;
    this.logger = initializeLogger();
  }

  execute = async <
    T extends { headers: Record<string, unknown> | undefined; args: unknown[] },
    R,
  >(
    input: T,
    next: (i: T) => Promise<R>,
  ): Promise<R> =>
    // Wrap the entire execution in an isolated ALS scope seeded with an
    // explicit ROOT_CONTEXT. An activity's only legitimate parent is the remote
    // context carried in its headers — never the worker thread's ambient stack.
    // We seed `[ROOT_CONTEXT]` rather than `[]` because `getContext()` falls
    // through to the process-global active-span stack when the ALS stack is
    // EMPTY (see `LaminarContextManager.getContext`); a single ROOT entry makes
    // the lookup short-circuit at root, so when header restoration fails the
    // activity runs detached instead of attaching to an unrelated in-process
    // trace left on the worker's async lineage.
    LaminarContextManager.runWithIsolatedContext([ROOT_CONTEXT], async () => {
      const restoredCtx = restoreContextFromHeaders(input.headers);
      if (!this.createActivitySpan || !restoredCtx) {
        return next(input);
      }

      const activityName = this.activityType ?? "temporal.activity";

      const span = Laminar.startSpan({
        name: activityName,
        parentSpanContext: restoredCtx,
        input: this.recordActivityArgs ? input.args : undefined,
      });

      return Laminar.withSpan(
        span,
        async () => {
          const res = await next(input);
          if (this.recordActivityOutput) {
            try {
              (span as LaminarSpan).setOutput(res);
            } catch (e) {
              this.logger.debug(
                `failed to set output to activity span: ${errorMessage(e)}`,
              );
            }
          }
          return res;
        },
        true,
      );
    });
}

export const ActivityInterceptorFactory =
  (options?: LaminarTemporalInterceptorOptions) => (ctx: any) => ({
    inbound: new ActivityInboundInterceptor(options, ctx),
  });
