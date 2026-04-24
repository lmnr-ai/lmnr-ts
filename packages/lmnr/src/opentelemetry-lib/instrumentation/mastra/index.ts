/**
 * Mastra instrumentation.
 *
 * Mastra has its own observability bus separate from OpenTelemetry. We therefore
 * do not monkey-patch LLM call sites — instead, we intercept the `Mastra`
 * constructor, inject a {@link LaminarMastraExporter} into its observability
 * config, and let Mastra's native bus emit rich `agent_run`/`tool_call`/
 * `model_generation` spans straight to Laminar.
 *
 * We also auto-disable AI-SDK `experimental_telemetry` fallback inside Mastra
 * contexts (the Vercel AI SDK is used by Mastra internally), to avoid producing
 * the noisy duplicate `ai.streamText` → Step → chunk hierarchy on top of the
 * native spans.
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type,
   @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-require-imports */

import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { initializeLogger } from "../../../utils";
import { LaminarMastraExporter } from "./exporter";

export { LaminarMastraExporter } from "./exporter";

const logger = initializeLogger();

// Module-level flag so tests / idempotent init can still run safely.
const MASTRA_PATCHED = Symbol.for("lmnr.mastra.patched");

let cachedObservabilityClass: any = undefined;
const loadObservabilityClass = (): any => {
  if (cachedObservabilityClass !== undefined) return cachedObservabilityClass;
  try {
    cachedObservabilityClass = require("@mastra/observability").Observability;
  } catch {
    cachedObservabilityClass = null;
  }
  return cachedObservabilityClass;
};

// Detect a Mastra `Observability` entrypoint (has `getDefaultInstance`).
const isObservabilityEntrypoint = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  typeof (value as any).getDefaultInstance === "function";

const laminarExporterDefined = (exporters: any[]): boolean =>
  exporters.some(
    (e: any) => e && (e.name === "laminar" || e instanceof LaminarMastraExporter),
  );

const buildLaminarInstanceConfig = (existing?: any) => {
  const defaultCfg = (existing?.configs?.default ?? {}) as Record<string, any>;
  const exporters = Array.isArray(defaultCfg.exporters)
    ? [...defaultCfg.exporters]
    : [];
  if (!laminarExporterDefined(exporters)) {
    exporters.push(new LaminarMastraExporter());
  }
  return {
    ...defaultCfg,
    serviceName: defaultCfg.serviceName ?? "mastra-service",
    exporters,
  };
};

const ensureExporterInjected = (args: any[]): any[] => {
  if (!args[0] || typeof args[0] !== "object") {
    args[0] = {};
  }
  const config = args[0];
  const existing = config.observability;

  // 1. User passed a pre-built Observability instance — leave it alone; they
  //    have taken full manual control. `withLaminar` is the documented path
  //    for this case.
  if (isObservabilityEntrypoint(existing)) return args;

  // 2. @mastra/core >= 1.27 rejects raw registry-config objects — it checks
  //    for `getDefaultInstance()` and only accepts an `Observability`
  //    instance. Build one from the user's config (if any) plus our exporter.
  const ObservabilityClass = loadObservabilityClass();
  if (!ObservabilityClass) {
    logger.debug(
      "@mastra/observability is not installed; Laminar Mastra " +
        "instrumentation cannot inject its exporter.",
    );
    return args;
  }

  const instanceConfig = buildLaminarInstanceConfig(existing);
  const mergedConfigs = { ...(existing?.configs ?? {}), default: instanceConfig };
  config.observability = new ObservabilityClass({
    configs: mergedConfigs,
    ...(existing?.configSelector
      ? { configSelector: existing.configSelector }
      : {}),
  });
  return args;
};

export class MastraInstrumentation extends InstrumentationBase {
  constructor() {
    super("@lmnr/mastra-instrumentation", SDK_VERSION, { enabled: true });
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@mastra/core",
      [">=0.10.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(input: any): void {
    diag.debug("Manually instrumenting @mastra/core");
    if (input && typeof input === "object" && this.resolveMastraClass(input)) {
      this.patch(input);
    } else {
      logger.debug(
        "Could not find Mastra class in manual instrumentation input. " +
          "Pass the @mastra/core module (e.g. `require('@mastra/core')` " +
          "or a namespace import).",
      );
    }
  }

  private resolveMastraClass(input: any): Function | null {
    if (!input) return null;
    // { Mastra } named export
    if (input.Mastra && typeof input.Mastra === "function") {
      return input.Mastra;
    }
    // Default export is the class
    if (input.default && typeof input.default === "function") {
      return input.default;
    }
    // Direct class
    if (typeof input === "function" && input.prototype) {
      return input;
    }
    return null;
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @mastra/core");

    if (!moduleExports || typeof moduleExports !== "object") return moduleExports;

    const MastraClass = this.resolveMastraClass(moduleExports);
    if (!MastraClass) {
      logger.debug("Mastra class not found in @mastra/core exports");
      return moduleExports;
    }

    if (moduleExports[MASTRA_PATCHED]) return moduleExports;

    const Wrapped: any = function (this: any, ...args: any[]) {
      const patchedArgs = ensureExporterInjected(args);
      // new.target may be undefined if called without `new`
      if (new.target) {
        return Reflect.construct(MastraClass, patchedArgs, new.target);
      }
      return MastraClass.apply(this, patchedArgs);
    };
    Wrapped.prototype = MastraClass.prototype;
    Object.setPrototypeOf(Wrapped, MastraClass);
    for (const key of Object.getOwnPropertyNames(MastraClass)) {
      if (["length", "prototype", "name"].includes(key)) continue;
      try {
        Object.defineProperty(
          Wrapped,
          key,
          Object.getOwnPropertyDescriptor(MastraClass, key)!,
        );
      } catch {
        // best-effort
      }
    }

    if (moduleExports.Mastra) {
      moduleExports.Mastra = Wrapped;
    }
    if (moduleExports.default && moduleExports.default === MastraClass) {
      moduleExports.default = Wrapped;
    }
    Object.defineProperty(moduleExports, MASTRA_PATCHED, {
      value: true,
      enumerable: false,
      configurable: true,
    });

    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @mastra/core");
    void moduleExports;
    // We don't have the pre-wrap reference in memory; Mastra instances created
    // post-unpatch will simply not receive the exporter. No-op.
  }
}

/**
 * Public helper: wrap an existing Mastra config to include the Laminar exporter.
 * Use this for ESM / bundled environments where the auto-patch on `@mastra/core`
 * does not trigger.
 *
 * @example
 * ```ts
 * import { Mastra } from "@mastra/core";
 * import { withLaminar } from "@lmnr-ai/lmnr";
 *
 * const mastra = new Mastra(withLaminar({
 *   agents: { ... },
 * }));
 * ```
 */
export const withLaminar = <T extends Record<string, any>>(
  mastraConfig: T = {} as T,
): T => {
  const [patched] = ensureExporterInjected([mastraConfig]);
  return patched as T;
};
