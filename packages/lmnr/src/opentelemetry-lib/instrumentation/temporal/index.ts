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
 *     activity: [LaminarTemporalInterceptors.ActivityInterceptorFactory()],
 *     workflowModules: [require.resolve('@lmnr-ai/lmnr/temporal-workflow-interceptors')],
 *   },
 *   // ...
 * });
 *
 * const client = new Client({
 *   interceptors: {
 *     workflow: [new LaminarTemporalInterceptors.WorkflowClientInterceptor()],
 *     activity: [new LaminarTemporalInterceptors.ActivityClientInterceptor()],
 *     schedule: [new LaminarTemporalInterceptors.ScheduleClientInterceptor()],
 *   },
 * });
 * ```
 *
 * Usage — Option B (auto-patch via instrumentModules):
 *
 * In Temporal, the worker and client typically run in separate processes
 * (separate entry-point files). Call `Laminar.initialize()` in each file,
 * passing only the module that belongs to that process:
 *
 * worker.ts:
 * ```typescript
 * import * as temporalWorker from '@temporalio/worker';
 * import { Laminar } from '@lmnr-ai/lmnr';
 *
 * Laminar.initialize({
 *   instrumentModules: { temporal: { worker: temporalWorker } },
 * });
 *
 * // Worker.create() now automatically includes Laminar activity interceptors
 * // and the workflow interceptor module.
 * const worker = await temporalWorker.Worker.create({ ... });
 * ```
 *
 * NOTE: if the worker is created with a pre-built `workflowBundle`, Temporal
 * ignores `interceptors.workflowModules`, so the workflow interceptor cannot be
 * auto-injected. Register it at bundle time instead:
 * ```typescript
 * await bundleWorkflowCode({
 *   workflowsPath: require.resolve('./workflows'),
 *   workflowInterceptorModules: [
 *     require.resolve('@lmnr-ai/lmnr/temporal-workflow-interceptors'),
 *   ],
 * });
 * ```
 *
 * client.ts:
 * ```typescript
 * import * as temporalClient from '@temporalio/client';
 * import { Laminar } from '@lmnr-ai/lmnr';
 *
 * Laminar.initialize({
 *   instrumentModules: { temporal: { client: temporalClient } },
 * });
 *
 * // new temporalClient.Client() now automatically includes Laminar interceptors.
 * const client = new temporalClient.Client({ ... });
 * ```
 */

import { initializeLogger } from "../../../utils";
import {
  ActivityClientInterceptor,
  ActivityInterceptorFactory,
  LaminarTemporalInterceptorOptions,
  ScheduleClientInterceptor,
  WorkflowClientInterceptor,
} from "./interceptors";

const logger = initializeLogger();

// ─── Auto-patch helpers ───────────────────────────────────────────────────────

const _patchedWorkerModules = new WeakSet<object>();
const _patchedClientModules = new WeakSet<object>();

let _warnedWorkflowBundleOnce = false;

// Temporal ignores `interceptors.workflowModules` whenever a pre-built
// `workflowBundle` is supplied — the bundle is produced before `Worker.create`
// runs, so there is no hook for us to inject the Laminar workflow interceptor
// after the fact (see @temporalio/worker WorkerOptions.workflowBundle /
// .interceptors docs). When that happens the workflow-side outbound header
// propagation never runs, so trace headers from workflow start are not
// forwarded to activities / child workflows scheduled from inside the workflow.
// Warn once with the exact bundle-time fix instead of silently injecting a
// module Temporal will drop.
const warnWorkflowBundleOnce = (): void => {
  if (_warnedWorkflowBundleOnce) {
    return;
  }
  _warnedWorkflowBundleOnce = true;
  logger.warn(
    "[Laminar] Temporal Worker.create was called with a pre-built " +
      "`workflowBundle`; Temporal ignores `interceptors.workflowModules` in " +
      "that case, so Laminar's workflow interceptor cannot be auto-injected. " +
      "Trace context from workflow start will NOT propagate to activities or " +
      "child workflows scheduled inside the workflow. Register the interceptor " +
      "at bundle time: bundleWorkflowCode({ workflowInterceptorModules: " +
      "[require.resolve('@lmnr-ai/lmnr/temporal-workflow-interceptors')], ... }).",
  );
};

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
        workflowBundle?: unknown;
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

    // Temporal ignores `interceptors.workflowModules` when a pre-built
    // `workflowBundle` is supplied (the bundle is already compiled), so we must
    // NOT inject it there — the user has to register it at bundle time. Warn
    // once and leave the workflow interceptors untouched.
    const usesWorkflowBundle = rawOpts?.workflowBundle != null;
    if (usesWorkflowBundle) {
      warnWorkflowBundleOnce();
    }

    const interceptors: Record<string, unknown> = {
      ...rawOpts?.interceptors,
      activity: [
        ActivityInterceptorFactory(options),
        ...(rawOpts?.interceptors?.activity ?? []),
      ],
    };

    if (!usesWorkflowBundle) {
      interceptors.workflowModules = [
        require.resolve("@lmnr-ai/lmnr/temporal-workflow-interceptors"),
        ...((rawOpts?.interceptors?.workflowModules as
          | string[]
          | undefined) ?? []),
      ];
    }

    const patched = {
      ...rawOpts,
      interceptors,
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
