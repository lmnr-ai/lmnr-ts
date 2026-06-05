/**
 * Laminar Temporal interceptors for distributed trace context propagation.
 *
 * Usage — Option A (explicit, always works):
 *
 * ```typescript
 * import { LaminarTemporalInterceptors } from '@lmnr-ai/lmnr';
 * import { Worker } from '@temporalio/worker';
 * import { Client } from '@temporalio/client';
 *
 * const worker = await Worker.create({
 *   interceptors: {
 *     activityInbound: [() => new LaminarTemporalInterceptors.ActivityInboundInterceptor()],
 *   },
 *   // ...
 * });
 *
 * const client = new Client({
 *   interceptors: {
 *     workflow: [new LaminarTemporalInterceptors.WorkflowClientInterceptor()],
 *   },
 * });
 * ```
 *
 * Usage — Option B (auto-patch via instrumentModules):
 *
 * ```typescript
 * import * as temporalWorker from '@temporalio/worker';
 * import * as temporalClient from '@temporalio/client';
 * import { Laminar } from '@lmnr-ai/lmnr';
 *
 * Laminar.initialize({
 *   instrumentModules: {
 *     temporal: { worker: temporalWorker, client: temporalClient },
 *   },
 * });
 *
 * // Worker.create() and new temporalClient.Client() now automatically include
 * // Laminar interceptors.
 * const worker = await temporalWorker.Worker.create({ ... });
 * const client = new temporalClient.Client({ ... });
 * ```
 */

import {
  ActivityClientInterceptor,
  ActivityInterceptorFactory,
  LaminarTemporalInterceptorOptions,
  ScheduleClientInterceptor,
  WorkflowClientInterceptor,
} from "./interceptors";

// ─── Auto-patch helpers ───────────────────────────────────────────────────────

const _patchedWorkerModules = new WeakSet<object>();
const _patchedClientModules = new WeakSet<object>();

/**
 * Patch a `@temporalio/worker` module object so that every `Worker.create()`
 * call automatically includes `ActivityInboundInterceptor`.
 *
 * Idempotent — calling with the same module object more than once is a no-op.
 *
 * Called by `manuallyInitInstrumentations` when
 * `instrumentModules.temporal.worker` is provided.
 */
export const patchTemporalWorker = (
  workerModule: {
    Worker: { create: (...args: unknown[]) => Promise<unknown> };
  },
  options: LaminarTemporalInterceptorOptions = {},
): void => {
  if (_patchedWorkerModules.has(workerModule)) {
    return;
  }
  _patchedWorkerModules.add(workerModule);

  const originalCreate = workerModule.Worker.create.bind(workerModule.Worker);

  workerModule.Worker.create = async (...args: unknown[]) => {
    const [rawOpts, ...rest] = args as [
      {
        interceptors?: {
          activity: ((options: LaminarTemporalInterceptorOptions) => (
            ctx: any,
          ) => {
            inbound: any;
          })[];
          [k: string]: unknown;
        };
        [k: string]: unknown;
      },
      ...unknown[],
    ];

    const patched = {
      ...rawOpts,
      interceptors: {
        ...rawOpts?.interceptors,
        activity: [
          ActivityInterceptorFactory(options),
          ...(rawOpts?.interceptors?.activity ?? []),
        ],
      },
    };

    return originalCreate(patched, ...rest);
  };
};

/**
 * Patch a `@temporalio/client` module object so that every `new Client()`
 * call automatically includes `WorkflowClientInterceptor`.
 *
 * Mutates `clientModule.Client` in place so any code that reads `Client`
 * from the module after `Laminar.initialize()` gets the patched class
 * automatically.
 *
 * Idempotent — calling with the same module object more than once is a no-op.
 *
 * Called by `manuallyInitInstrumentations` when
 * `instrumentModules.temporal.client` is provided.
 */
export const patchTemporalClient = (clientModule: {
  Client: new (...args: unknown[]) => unknown;
}): void => {
  if (_patchedClientModules.has(clientModule)) {
    return;
  }
  _patchedClientModules.add(clientModule);

  const OriginalClient = clientModule.Client;

  type ClientOptions = {
    interceptors?: {
      workflow?: WorkflowClientInterceptor[];
      activity?: ActivityClientInterceptor[];
      schedule?: ScheduleClientInterceptor[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };

  clientModule.Client =
    class LaminarTemporalClient extends (OriginalClient as new (
      opts?: ClientOptions,
    ) => any) {
      constructor(opts?: ClientOptions) {
        super({
          ...opts,
          interceptors: {
            ...opts?.interceptors,
            workflow: [
              new WorkflowClientInterceptor(),
              ...(opts?.interceptors?.workflow ?? []),
            ],
            activity: [
              new ActivityClientInterceptor(),
              ...(opts?.interceptors?.activity ?? []),
            ],
            schedule: [
              new ScheduleClientInterceptor(),
              ...(opts?.interceptors?.schedule ?? []),
            ],
          },
        });
      }
    } as unknown as new (...args: unknown[]) => unknown;
};

// ─── Convenience namespace ────────────────────────────────────────────────────

/** Namespace export: `LaminarTemporalInterceptors.WorkflowClientInterceptor`. */
export const LaminarTemporalInterceptors = {
  WorkflowClientInterceptor,
  ScheduleClientInterceptor,
  ActivityClientInterceptor,
  ActivityInterceptorFactory,
};
