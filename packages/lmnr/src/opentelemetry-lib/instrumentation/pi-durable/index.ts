import { errorMessage } from "@lmnr-ai/types";
import type { TracerProvider } from "@opentelemetry/api";
import { TracerProvider as SdkTracerProvider } from "@opentelemetry/sdk-trace";

import { initializeLogger } from "../../../utils";
import { forceFlush as forceFlushLaminar } from "../../tracing/index";
import { LaminarSpanProcessor } from "../../tracing/processor";
import { InstrumentedModule, LaminarInstrumentation } from "../shared/base";
import { lastUserText } from "./messages";
import {
  isPiSpanWithRun,
  PI_DURABLE,
  type PiDurableConversationInfo,
  type PiDurableSpanNames,
  PiDurableTracer,
  type PiSpan,
} from "./telemetry";
import type {
  PiAssistantMessage,
  PiContext,
  PiExtension,
  PiHookApi,
  PiMessage,
  PiTelemetryContext,
  PiToolExecutionResult,
  PiToolHookCall,
} from "./types";

export type { PiDurableConversationInfo, PiDurableSpanNames };

const logger = initializeLogger();

/**
 * Name of the extension. Pi's `registry.install` replaces any extension with
 * the same name, so it is the npm package name, which no one else picks.
 */
export const LAMINAR_PI_EXTENSION_NAME = "@lmnr-ai/lmnr";

/** Marks extensions made by any copy of this SDK. */
const LAMINAR_EXTENSION = Symbol.for("lmnr.pi-durable.extension");

const isLaminarExtension = (extension: unknown): boolean =>
  typeof extension === "object" &&
  extension !== null &&
  (extension as Record<symbol, unknown>)[LAMINAR_EXTENSION] === true;

export interface LaminarPiDurableOptions {
  /**
   * Laminar session id of every span: a string, or a function of the
   * conversation. Defaults to Pi's per-conversation provider session id
   * (persisted, so it survives restarts).
   */
  sessionId?:
    | string
    | ((info: PiDurableConversationInfo) => string | undefined);
  /** Laminar user id of every span. */
  userId?: string | ((info: PiDurableConversationInfo) => string | undefined);
  /** Laminar metadata of every span. */
  metadata?: Record<string, unknown>;
  /** Span names. Defaults: `pi.run`, `pi.chat`, and the tool name. */
  spanNames?: PiDurableSpanNames;
  /**
   * Override the system prompt reported on LLM spans. By default it is
   * rebuilt from the request's system messages, which hold Pi's prompt
   * sections and tool definitions.
   */
  systemPrompt?: (info: PiDurableConversationInfo) => string | undefined;
  /**
   * Send spans through this provider instead of the one
   * `Laminar.initialize()` set up.
   */
  tracerProvider?: TracerProvider;
  /**
   * Send spans to this Laminar project on a provider of their own, without
   * `Laminar.initialize()`. Agent traces can then go to another project than
   * the rest of the app's traces. Ignored with `tracerProvider`.
   */
  projectApiKey?: string;
  /** Laminar API base URL for `projectApiKey`. Defaults to `LMNR_BASE_URL`, else Laminar Cloud. */
  baseUrl?: string;
  /** Laminar gRPC port for `projectApiKey`. Defaults to 8443. */
  port?: number;
}

export interface LaminarPiDurable {
  /** Pass as `Harness.open(storage, { telemetry })`. */
  readonly telemetry: PiTelemetryContext;
  /** Install with `registry.install(extension)`. */
  readonly extension: PiExtension;
  /** Export finished spans now. */
  forceFlush(): Promise<void>;
  /**
   * Flush, and shut down the provider created for `projectApiKey`. A
   * provider passed in or set up by `Laminar.initialize()` is only flushed.
   */
  shutdown(): Promise<void>;
}

let warnedForeignTelemetry = false;

/** The phase span of a hook's context, when it is ours and has a run. */
const phaseOf = (context: PiContext | undefined): PiSpan | undefined => {
  const telemetry = context?.telemetry;
  if (isPiSpanWithRun(telemetry)) return telemetry;
  if (!warnedForeignTelemetry) {
    warnedForeignTelemetry = true;
    logger.warn(
      "Laminar's pi-durable extension is installed, but the Harness was not " +
        "opened with Laminar's `telemetry`. Pass `telemetry: lmnr.telemetry` " +
        "to Harness.open() to trace runs.",
    );
  }
  return undefined;
};

/** Run hook code without ever throwing into Pi. */
const hookSafely = async (
  name: string,
  fn: () => void | Promise<void>,
): Promise<undefined> => {
  try {
    await fn();
  } catch (error) {
    logger.debug(
      `Laminar pi-durable ${name} hook failed: ${errorMessage(error)}`,
    );
  }
  return undefined;
};

/**
 * Pi's hooks, dispatched to the adapter that owns the phase span: the LLM
 * span of a request runs `beforeRequest` → `afterResponse`, the TOOL span of
 * a call `beforeTool` → `afterTool`. Hooks only observe; they never change a
 * request, a call or a result.
 */
const createExtension = (): PiExtension =>
  Object.defineProperty(buildExtension(), LAMINAR_EXTENSION, { value: true });

const buildExtension = (): PiExtension => ({
  name: LAMINAR_PI_EXTENSION_NAME,
  hooks: [
    {
      task: "pi.generation",
      handlers: {
        beforeRequest: (
          request: { readonly messages: readonly PiMessage[] },
          api: PiHookApi,
          context: PiContext,
        ) =>
          hookSafely("beforeRequest", async () => {
            const phase = phaseOf(context);
            const run = phase?.owner.runFor(phase);
            if (!phase || !run) return;
            phase.llm = { startTime: Date.now(), messages: request.messages };
            if (run.input === undefined) {
              run.input = lastUserText(request.messages) || undefined;
            }
            await phase.owner.resolveConversation(run, api, context);
          }),
        afterResponse: (
          message: PiAssistantMessage,
          api: PiHookApi,
          context: PiContext,
        ) =>
          hookSafely("afterResponse", async () => {
            const phase = phaseOf(context);
            const run = phase?.owner.runFor(phase);
            if (!phase || !run) return;
            await phase.owner.resolveConversation(run, api, context);
            phase.owner.emitLlm(phase, run, message);
          }),
      },
    },
    {
      task: "pi.tool",
      handlers: {
        beforeTool: (
          call: PiToolHookCall,
          api: PiHookApi,
          context: PiContext,
        ) =>
          hookSafely("beforeTool", async () => {
            const phase = phaseOf(context);
            const run = phase?.owner.runFor(phase);
            if (!phase || !run) return;
            phase.tools.set(call.id, { startTime: Date.now() });
            await phase.owner.resolveConversation(run, api, context);
          }),
        afterTool: (
          call: PiToolHookCall,
          result: PiToolExecutionResult,
          api: PiHookApi,
          context: PiContext,
        ) =>
          hookSafely("afterTool", async () => {
            const phase = phaseOf(context);
            const run = phase?.owner.runFor(phase);
            if (!phase || !run) return;
            await phase.owner.resolveConversation(run, api, context);
            phase.owner.emitTool(phase, run, call, result);
          }),
      },
    },
  ],
});

/**
 * Trace a Pi Durable (`@earendil-works/pi-durable`) Harness with Laminar:
 * one trace per run, with an LLM span per model request and a TOOL span per
 * tool call. Runs resumed after a restart continue their trace.
 *
 * ```ts
 * const lmnr = laminarPiDurable({ userId: "user-1" });
 * registry.install(lmnr.extension);
 * const harness = await Harness.open(storage, { models, registry, telemetry: lmnr.telemetry }, context);
 * ```
 *
 * Without `projectApiKey` or `tracerProvider`, spans go through
 * `Laminar.initialize()`'s pipeline.
 */
export const laminarPiDurable = (
  options: LaminarPiDurableOptions = {},
): LaminarPiDurable => {
  let tracerProvider = options.tracerProvider;
  let spanProcessor: LaminarSpanProcessor | undefined;
  let ownProvider: SdkTracerProvider | undefined;
  if (!tracerProvider && options.projectApiKey) {
    spanProcessor = new LaminarSpanProcessor({
      apiKey: options.projectApiKey,
      baseUrl: options.baseUrl,
      port: options.port,
    });
    ownProvider = new SdkTracerProvider({ spanProcessors: [spanProcessor] });
    tracerProvider = ownProvider;
  }

  const tracer = new PiDurableTracer({
    sessionId: options.sessionId,
    userId: options.userId,
    metadata: options.metadata,
    spanNames: options.spanNames,
    systemPrompt: options.systemPrompt,
    tracerProvider,
    spanProcessor,
  });

  const forceFlush = async () => {
    try {
      if (tracerProvider) {
        await (
          tracerProvider as { forceFlush?: () => Promise<void> }
        ).forceFlush?.();
      } else {
        await forceFlushLaminar();
      }
    } catch (error) {
      logger.debug(`Failed to flush pi-durable spans: ${errorMessage(error)}`);
    }
  };

  return {
    telemetry: tracer,
    extension: createExtension(),
    forceFlush,
    shutdown: async () => {
      await forceFlush();
      await ownProvider?.shutdown().catch(() => undefined);
    },
  };
};

const INSTRUMENTED = Symbol.for("lmnr.pi-durable.instrumented");

/**
 * Patches `Harness.open` to pass Laminar's `telemetry` and install Laminar's
 * extension in the Harness's registry, so a Harness is traced without code
 * changes. Spans go through `Laminar.initialize()`'s pipeline.
 *
 * pi-durable is ESM-only, so the `require` hook never sees it. Pass the
 * module (`instrumentModules: { piDurable: await import(...) }`), or register
 * OTel's ESM loader hook before the app imports pi-durable.
 */
export class PiDurableInstrumentation extends LaminarInstrumentation {
  private integration?: LaminarPiDurable;

  constructor() {
    super("pi-durable");
  }

  protected modules(): InstrumentedModule[] {
    return [
      {
        name: PI_DURABLE,
        supportedVersions: [">=1.4.0 <2"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) =>
          this.unwrapMethod(moduleExports?.Harness, "open"),
        accepts: (input) => typeof input?.Harness?.open === "function",
      },
    ];
  }

  private patch(moduleExports: any): void {
    // `Harness` is a plain object shared by every importer of this copy of
    // pi-durable, so patching it covers `import { Harness }` bindings too.
    this.wrapMethod(
      moduleExports?.Harness,
      "open",
      (patched) =>
        function (
          this: unknown,
          storage: unknown,
          options: any,
          ...rest: any[]
        ) {
          const instrumented =
            patched.instrumentation.instrumentOptions(options);
          return patched.original.call(this, storage, instrumented, ...rest);
        },
    );
  }

  /**
   * `registry.install` replaces an extension of the same name, which would
   * silently take another extension's tools and prompt away. Replacing one of
   * Laminar's own is harmless (every copy dispatches through the phase's
   * telemetry), so only a foreign extension of that name blocks the install.
   */
  private installExtension(registry: any, extension: PiExtension): void {
    let existing: unknown;
    try {
      existing = registry.snapshot?.().extension?.(extension.name);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && !isLaminarExtension(existing)) {
      logger.warn(
        `pi-durable registry already has an extension named ` +
          `"${extension.name}"; Laminar won't replace it, so LLM and tool ` +
          "spans are not recorded. Rename that extension, or trace with " +
          "laminarPiDurable().",
      );
      return;
    }
    registry.install(extension);
  }

  /** `HarnessOptions` with Laminar's telemetry, its extension installed. */
  instrumentOptions(options: any): any {
    try {
      if (!options || typeof options !== "object" || options[INSTRUMENTED]) {
        return options;
      }
      if (options.telemetry instanceof PiDurableTracer) {
        // Already traced explicitly with `laminarPiDurable()`.
        return options;
      }
      if (options.telemetry !== undefined) {
        logger.debug(
          "pi-durable Harness has its own telemetry; Laminar leaves it alone.",
        );
        return options;
      }
      this.integration ??= laminarPiDurable();
      if (typeof options.registry?.install === "function") {
        this.installExtension(options.registry, this.integration.extension);
      } else {
        logger.warn(
          "pi-durable registry has no install(); install Laminar's extension " +
            "yourself with laminarPiDurable().",
        );
      }
      // Keep the host's object (and its getters) as the prototype.
      return Object.create(options, {
        telemetry: {
          value: this.integration.telemetry,
          enumerable: true,
          configurable: true,
          writable: true,
        },
        [INSTRUMENTED]: { value: true },
      });
    } catch (error) {
      logger.debug(
        `Failed to instrument pi-durable Harness options: ${errorMessage(error)}`,
      );
      return options;
    }
  }
}
