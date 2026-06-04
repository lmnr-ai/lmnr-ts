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
 * import { Client } from '@temporalio/client';
 * import { Laminar } from '@lmnr-ai/lmnr';
 *
 * Laminar.initialize({
 *   instrumentModules: {
 *     temporal: { worker: temporalWorker, Client },
 *   },
 * });
 *
 * // Worker.create() and new Client() now automatically include Laminar interceptors.
 * const worker = await Worker.create({ ... });
 * const client = new Client({ ... });
 * ```
 */

import { errorMessage, LaminarSpanContext } from "@lmnr-ai/types";
import { isSpanContextValid, trace } from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import {
  deserializeLaminarSpanContext,
  initializeLogger,
  tryToOtelSpanContext,
} from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { getSpanProcessor } from "../../tracing/index";
import { LaminarSpanProcessor } from "../../tracing/processor";
import { LaminarSpan } from "../../tracing/span";

const logger = initializeLogger();

/** Header key used to carry the serialized Laminar span context through Temporal. */
export const LAMINAR_SPAN_CONTEXT_HEADER = "laminar-span-context";

/**
 * W3C traceparent header key — written alongside `laminar-span-context` for
 * interop with non-Laminar clients/workers that understand W3C trace context.
 */
export const TRACEPARENT_HEADER = "traceparent";

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
}

// ─── Payload codec helpers ────────────────────────────────────────────────────
// Temporal headers are `Record<string, Payload>` where Payload is a protobuf
// envelope with `metadata.encoding` and `data` fields.  We avoid importing
// @temporalio/common so that it stays a soft peer-dep.

const _enc = new TextEncoder();
const _dec = new TextDecoder();

const encodePayload = (value: string): unknown => ({
  metadata: { encoding: _enc.encode("json/plain") },
  data: _enc.encode(JSON.stringify(value)),
});

const decodePayload = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { data?: Uint8Array | null };
  if (!p.data) return undefined;
  try {
    return JSON.parse(_dec.decode(p.data)) as string;
  } catch {
    return undefined;
  }
};

// ─── Context serialisation ────────────────────────────────────────────────────

/**
 * Read the currently active Laminar span and encode its context into a headers
 * map.  Writes both `laminar-span-context` (full Laminar JSON) and
 * `traceparent` (W3C, for interop with non-Laminar workers).
 *
 * Returns the headers map unchanged if there is no active Laminar span.
 */
const buildHeaders = (
  existing: Record<string, unknown>,
): Record<string, unknown> => {
  const rawSpan = trace.getSpan(LaminarContextManager.getContext())
    ?? trace.getActiveSpan();

  if (!rawSpan || !isSpanContextValid(rawSpan.spanContext())) {
    return existing;
  }

  let laminarCtx: LaminarSpanContext | null = null;
  if (rawSpan instanceof LaminarSpan) {
    try {
      laminarCtx = rawSpan.getLaminarSpanContext();
    } catch {
      // fall through to OTel-only path
    }
  }

  const headers: Record<string, unknown> = { ...existing };

  if (laminarCtx) {
    headers[LAMINAR_SPAN_CONTEXT_HEADER] = encodePayload(
      JSON.stringify(laminarCtx),
    );
    const traceHex = laminarCtx.traceId.replace(/-/g, "");
    const spanHex = laminarCtx.spanId.replace(/-/g, "").slice(16);
    headers[TRACEPARENT_HEADER] = encodePayload(`00-${traceHex}-${spanHex}-01`);
  } else {
    const ctx = rawSpan.spanContext();
    headers[TRACEPARENT_HEADER] = encodePayload(
      `00-${ctx.traceId}-${ctx.spanId}-01`,
    );
  }

  return headers;
};

// ─── Context restoration ──────────────────────────────────────────────────────

/**
 * Read `laminar-span-context` (preferred) or `traceparent` (fallback) from
 * Temporal headers and push the restored context onto Laminar's ALS stack.
 *
 * Returns the restored `LaminarSpanContext` or `undefined` if headers contain
 * no usable trace context.
 */
const restoreContextFromHeaders = (
  headers: Record<string, unknown> | undefined,
): LaminarSpanContext | undefined => {
  if (!headers) return undefined;

  // Preferred: full Laminar context header
  const laminarRaw = decodePayload(headers[LAMINAR_SPAN_CONTEXT_HEADER]);
  if (laminarRaw) {
    try {
      const ctx = deserializeLaminarSpanContext(laminarRaw);
      _pushLaminarContext(ctx);
      return ctx;
    } catch (e) {
      logger.warn(
        `[Laminar] Could not restore ${LAMINAR_SPAN_CONTEXT_HEADER}: ${errorMessage(e)}`,
      );
    }
  }

  // Fallback: W3C traceparent
  const traceparent = decodePayload(headers[TRACEPARENT_HEADER]);
  if (traceparent) {
    const parts = traceparent.split("-");
    if (parts.length >= 3) {
      const [, traceHex, spanHex] = parts;
      try {
        const toUUID = (hex: string, pad: number, fmt: string): string =>
          hex.padStart(pad, "0").replace(
            new RegExp(fmt),
            "$1-$2-$3-$4-$5",
          );
        const traceId = toUUID(
          traceHex, 32,
          "^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$",
        ) as LaminarSpanContext["traceId"];
        const spanId = toUUID(
          spanHex.padStart(32, "0"), 32,
          "^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$",
        ) as LaminarSpanContext["spanId"];
        const ctx: LaminarSpanContext = { traceId, spanId, isRemote: true };
        _pushLaminarContext(ctx);
        return ctx;
      } catch (e) {
        logger.warn(`[Laminar] Could not restore traceparent: ${errorMessage(e)}`);
      }
    }
  }

  return undefined;
};

/** Push a LaminarSpanContext onto the Laminar ALS stack as a remote parent. */
const _pushLaminarContext = (laminarCtx: LaminarSpanContext): void => {
  const otelCtx = tryToOtelSpanContext(laminarCtx);
  otelCtx.isRemote = true;

  const processor = getSpanProcessor();
  if (
    processor instanceof LaminarSpanProcessor &&
    laminarCtx.spanPath &&
    laminarCtx.spanIdsPath
  ) {
    processor.setParentPathInfo(
      otelCtx.spanId,
      laminarCtx.spanPath,
      laminarCtx.spanIdsPath,
    );
  }

  const base = trace.setSpan(
    LaminarContextManager.getContext(),
    trace.wrapSpanContext(otelCtx),
  );
  const enriched = LaminarContextManager.setRawAssociationProperties(
    laminarCtx,
    base,
  );
  LaminarContextManager.pushContext(enriched);
};

// ─── WorkflowClientInterceptor ────────────────────────────────────────────────

/**
 * Temporal client-side interceptor. Injects the active Laminar span context
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
  async start(
    input: { headers: Record<string, unknown>; [k: string]: unknown },
    next: (i: { headers: Record<string, unknown>; [k: string]: unknown }) =>
    Promise<unknown>,
  ): Promise<unknown> {
    return next({ ...input, headers: buildHeaders(input.headers ?? {}) });
  }

  async signal(
    input: { headers: Record<string, unknown>; [k: string]: unknown },
    next: (i: { headers: Record<string, unknown>; [k: string]: unknown }) =>
    Promise<unknown>,
  ): Promise<unknown> {
    return next({ ...input, headers: buildHeaders(input.headers ?? {}) });
  }

  async query(
    input: { headers: Record<string, unknown>; [k: string]: unknown },
    next: (i: { headers: Record<string, unknown>; [k: string]: unknown }) =>
    Promise<unknown>,
  ): Promise<unknown> {
    return next({ ...input, headers: buildHeaders(input.headers ?? {}) });
  }

  async signalWithStart(
    input: { headers: Record<string, unknown>; [k: string]: unknown },
    next: (i: { headers: Record<string, unknown>; [k: string]: unknown }) =>
    Promise<unknown>,
  ): Promise<unknown> {
    return next({ ...input, headers: buildHeaders(input.headers ?? {}) });
  }

  async startUpdate(
    input: { headers: Record<string, unknown>; [k: string]: unknown },
    next: (i: { headers: Record<string, unknown>; [k: string]: unknown }) =>
    Promise<unknown>,
  ): Promise<unknown> {
    return next({ ...input, headers: buildHeaders(input.headers ?? {}) });
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
export class ActivityInboundInterceptor {
  private readonly _createActivitySpan: boolean;

  constructor(options: LaminarTemporalInterceptorOptions = {}) {
    this._createActivitySpan = options.createActivitySpan ?? true;
  }

  async execute(
    input: {
      headers: Record<string, unknown> | undefined;
      args: unknown[];
      info?: { activityType?: string };
      [k: string]: unknown;
    },
    next: (i: {
      headers: Record<string, unknown> | undefined;
      args: unknown[];
      [k: string]: unknown;
    }) => Promise<unknown>,
  ): Promise<unknown> {
    // Wrap the entire execution in an isolated ALS scope so that
    // _pushLaminarContext's `enterWith` (which restores the remote parent)
    // cannot leak onto sibling activities that share the same async lineage.
    return LaminarContextManager.runWithIsolatedContext(
      LaminarContextManager.getContextStack(),
      () => {
        const restoredCtx = restoreContextFromHeaders(input.headers);

        if (!this._createActivitySpan || !restoredCtx) {
          return next(input);
        }

        const activityName =
          input.info?.activityType ?? "temporal.activity";

        const span = Laminar.startSpan({
          name: activityName,
          parentSpanContext: restoredCtx,
        });

        return Laminar.withSpan(span, () => next(input), true);
      },
    );
  }
}

// ─── Auto-patch helpers ───────────────────────────────────────────────────────

/**
 * Patch a `@temporalio/worker` module object so that every `Worker.create()`
 * call automatically includes `ActivityInboundInterceptor`.
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
  const originalCreate = workerModule.Worker.create.bind(
    workerModule.Worker,
  );

  workerModule.Worker.create = async (...args: unknown[]) => {
    const [rawOpts, ...rest] = args as [
      {
        interceptors?: {
          activityInbound?: (() => ActivityInboundInterceptor)[];
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
        activityInbound: [
          () => new ActivityInboundInterceptor(options),
          ...(rawOpts?.interceptors?.activityInbound ?? []),
        ],
      },
    };

    return originalCreate(patched, ...rest);
  };
};

/**
 * Wrap a `@temporalio/client` `Client` class so that every `new Client()`
 * call automatically includes `WorkflowClientInterceptor`.
 *
 * Returns the wrapped class; assign it back to the variable used for `new`:
 * ```typescript
 * const { Client } = require('@temporalio/client');
 * const PatchedClient = patchTemporalClient(Client);
 * const client = new PatchedClient({ ... }); // interceptors injected
 * ```
 *
 * When using `instrumentModules.temporal.Client`, `Laminar.initialize()` does
 * this automatically.
 */
export const patchTemporalClient = (
  ClientClass: new (...args: unknown[]) => unknown,
): new (...args: unknown[]) => unknown => {
  type ClientOptions = {
    interceptors?: {
      workflow?: WorkflowClientInterceptor[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };

  return class LaminarTemporalClient extends (
    ClientClass as new (opts?: ClientOptions) => unknown
  ) {
    constructor(opts?: ClientOptions) {
      super({
        ...opts,
        interceptors: {
          ...opts?.interceptors,
          workflow: [
            new WorkflowClientInterceptor(),
            ...(opts?.interceptors?.workflow ?? []),
          ],
        },
      });
    }
  };
};

// ─── Convenience namespace ────────────────────────────────────────────────────

/** Namespace export: `LaminarTemporalInterceptors.WorkflowClientInterceptor`. */
export const LaminarTemporalInterceptors = {
  WorkflowClientInterceptor,
  ActivityInboundInterceptor,
};
