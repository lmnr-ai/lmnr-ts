/**
 * Langfuse → Laminar bridge (`Laminar.initialize({ bridges: ["langfuse"] })`).
 *
 * `@langfuse/tracing` (and `@langfuse/openai` / `@langfuse/langchain`, which
 * build on it) gets its tracer from `getLangfuseTracerProvider()`: the
 * provider set with `setLangfuseTracerProvider`, else the global one. The
 * bridge registers a wrapper provider there. Its tracer delegates every span
 * to the tracer of the provider that was there before, so Langfuse's export
 * is untouched, and mirrors each span into Laminar's pipeline:
 *
 * - at start, Laminar's processor runs `onStart` against a shadow of the span
 *   (`Object.create(span)` with its own attribute bag), so the real span never
 *   receives `lmnr.*` attributes;
 * - after the real `end()`, a copy (again `Object.create(span)`) with the
 *   span's attributes, the shadow's, and the translated ones (`translate.ts`)
 *   goes to Laminar's processor `onEnd`.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import * as otelApi from "@opentelemetry/api";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";

import { initializeLogger } from "../../../utils";
import { getPackageVersion } from "../../instrumentation/shared/package-version";
import { type LaminarSpanProcessor } from "../../tracing/processor";
import {
  type Bridge,
  type BridgeContext,
  LLM_INSTRUMENTATIONS,
} from "../types";
import { translateLangfuseSpan } from "./translate";

const logger = initializeLogger();

const PACKAGE = "@langfuse/tracing";
const MIN_MAJOR_VERSION = 4;
// `globalThis[Symbol.for("langfuse")]` holds `{ isolatedTracerProvider }` in
// @langfuse/tracing 4.x - 6.x; `setLangfuseTracerProvider` writes it.
const LANGFUSE_GLOBAL_SYMBOL = Symbol.for("langfuse");
const PROVIDER_KEY = "isolatedTracerProvider";

interface LangfuseTracingModule {
  setLangfuseTracerProvider: (provider: TracerProvider | null) => void;
  getLangfuseTracerProvider: () => TracerProvider;
}

type OtelApi = typeof otelApi;

interface LoadedLangfuse {
  module: LangfuseTracingModule;
  /** The `@opentelemetry/api` copy `@langfuse/tracing` itself uses. */
  api: OtelApi;
}

/**
 * Load `@langfuse/tracing` from this SDK's location, then from the app's
 * working directory (strict package-manager layouts). Its global state is
 * keyed by `Symbol.for`, so every copy (CJS / ESM / duplicates) shares it.
 */
const loadLangfuseTracing = (): LoadedLangfuse | undefined => {
  // biome-ignore lint/style/noCommonJs: resolve an optional peer at runtime
  const resolvers: NodeJS.Require[] = [require];
  try {
    resolvers.push(createRequire(join(process.cwd(), "package.json")));
  } catch {
    // No usable working directory.
  }
  for (const resolver of resolvers) {
    let path: string;
    try {
      path = resolver.resolve(PACKAGE);
    } catch {
      continue;
    }
    try {
      const module = resolver(path) as LangfuseTracingModule;
      if (
        typeof module?.setLangfuseTracerProvider !== "function" ||
        typeof module?.getLangfuseTracerProvider !== "function"
      ) {
        continue;
      }
      let api: OtelApi = otelApi;
      try {
        api = createRequire(path)("@opentelemetry/api") as OtelApi;
      } catch {
        // Fall back to ours; both read the same OTel globals.
      }
      return { module, api };
    } catch (e) {
      logger.debug(`Failed to load ${PACKAGE}: ${errorMessage(e)}`);
    }
  }
  return undefined;
};

const majorVersion = (version: string): number =>
  parseInt(version.split(".")[0], 10);

type SdkSpan = Span & {
  name?: string;
  attributes?: Attributes;
  events?: unknown[];
  status?: { code?: number; message?: string };
  endTime?: unknown;
  instrumentationScope?: { name?: string; version?: string };
  instrumentationLibrary?: { name?: string; version?: string };
};

const defineOwn = (target: object, key: PropertyKey, value: unknown) => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/**
 * Feed one Langfuse span to Laminar's processor without touching what the
 * span itself exports.
 */
const mirrorSpan = (
  span: SdkSpan,
  parentContext: Context,
  processor: LaminarSpanProcessor,
): void => {
  if (
    !span ||
    typeof span.isRecording !== "function" ||
    !span.isRecording() ||
    typeof span.end !== "function"
  ) {
    return;
  }

  // Attributes Laminar's onStart writes (path, ids path, sdk version,
  // association properties). Kept for the copy that reaches onEnd.
  const laminarAttributes: Record<string, AttributeValue> = {};
  const shadowAttributes: Record<string, AttributeValue | undefined> = {
    ...(span.attributes ?? {}),
  };
  const shadow = Object.create(span) as SdkSpan;
  defineOwn(shadow, "attributes", shadowAttributes);
  const setAttribute = (key: string, value: AttributeValue | undefined) => {
    if (value !== undefined && value !== null) {
      laminarAttributes[key] = value;
      shadowAttributes[key] = value;
    }
    return shadow;
  };
  defineOwn(shadow, "setAttribute", setAttribute);
  defineOwn(shadow, "setAttributes", (attrs: Attributes) => {
    for (const [key, value] of Object.entries(attrs ?? {})) {
      setAttribute(key, value);
    }
    return shadow;
  });
  try {
    processor.onStart(shadow, parentContext);
  } catch (e) {
    logger.debug(`Laminar langfuse bridge onStart failed: ${errorMessage(e)}`);
    return;
  }

  const originalEnd = span.end;
  let mirrored = false;
  // Non-enumerable, so nothing that walks the span's own keys sees it.
  Object.defineProperty(span, "end", {
    value: (...args: unknown[]) => {
      const result = (originalEnd as (...a: unknown[]) => void).apply(
        span,
        args,
      );
      if (!mirrored) {
        mirrored = true;
        try {
          endMirror(span, laminarAttributes, processor);
        } catch (e) {
          logger.debug(
            `Laminar langfuse bridge onEnd failed: ${errorMessage(e)}`,
          );
        }
      }
      return result;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
};

const endMirror = (
  span: SdkSpan,
  laminarAttributes: Record<string, AttributeValue>,
  processor: LaminarSpanProcessor,
): void => {
  const attributes = span.attributes ?? {};
  const scope = span.instrumentationScope ?? span.instrumentationLibrary;
  const translated = translateLangfuseSpan(
    attributes,
    span.status,
    scope?.version,
  );
  const copy = Object.create(span) as SdkSpan;
  defineOwn(copy, "attributes", {
    ...attributes,
    ...laminarAttributes,
    ...translated.attributes,
  });
  const events = span.events ?? [];
  if (
    translated.errorMessage !== undefined &&
    !events.some((e: any) => e?.name === "exception")
  ) {
    defineOwn(copy, "events", [
      ...events,
      {
        name: "exception",
        attributes: {
          "exception.type": "Error",
          "exception.message": translated.errorMessage,
        },
        time: span.endTime,
        droppedAttributesCount: 0,
      },
    ]);
  }
  processor.onEnd(copy);
};

class BridgeTracer implements Tracer {
  constructor(
    private readonly inner: Tracer,
    private readonly bridge: LangfuseBridge,
  ) {}

  startSpan(name: string, options?: any, context?: Context): Span {
    const span = this.inner.startSpan(name, options, context);
    this.bridge.mirror(span, context);
    return span;
  }

  // Same arity as the caller's, only the callback is wrapped, so the inner
  // tracer parents and activates the span exactly as it would without us.
  startActiveSpan(name: string, ...args: any[]): any {
    const fn = args[args.length - 1];
    if (typeof fn !== "function") {
      return (this.inner.startActiveSpan as any)(name, ...args);
    }
    const context: Context | undefined = args.length >= 3 ? args[1] : undefined;
    args[args.length - 1] = (span: Span) => {
      this.bridge.mirror(span, context);
      return fn(span);
    };
    return (this.inner.startActiveSpan as any)(name, ...args);
  }
}

class BridgeTracerProvider implements TracerProvider {
  constructor(private readonly bridge: LangfuseBridge) {}

  getTracer(name: string, version?: string, options?: any): Tracer {
    const inner = this.bridge.innerProvider().getTracer(name, version, options);
    return this.bridge.isInstalled()
      ? new BridgeTracer(inner, this.bridge)
      : inner;
  }
}

export class LangfuseBridge implements Bridge {
  readonly name = "langfuse" as const;
  readonly conflictingInstrumentations = LLM_INSTRUMENTATIONS;
  readonly inheritsGlobalContext = true;

  private loaded: LoadedLangfuse | undefined;
  private processor: LaminarSpanProcessor | undefined;
  private wrapper: BridgeTracerProvider | undefined;
  /** Provider Langfuse used before us (or the one set after us); null = global. */
  private inner: TracerProvider | null = null;
  /** Langfuse's global state object when the accessor is installed on it. */
  private state: Record<string, unknown> | undefined;
  private warnedOverridden = false;

  isAvailable(): boolean {
    const loaded = loadLangfuseTracing();
    if (!loaded) {
      logger.warn(
        `Laminar langfuse bridge: ${PACKAGE} is not installed, skipping. ` +
          `Install ${PACKAGE} >= ${MIN_MAJOR_VERSION} to send Langfuse spans to Laminar.`,
      );
      return false;
    }
    const version = getPackageVersion(PACKAGE);
    if (
      version !== undefined &&
      !(majorVersion(version) >= MIN_MAJOR_VERSION)
    ) {
      logger.warn(
        `Laminar langfuse bridge: ${PACKAGE}@${version} is not supported ` +
          `(needs >= ${MIN_MAJOR_VERSION}), skipping.`,
      );
      return false;
    }
    this.loaded = loaded;
    return true;
  }

  install({ spanProcessor }: BridgeContext): void {
    const loaded = this.loaded ?? loadLangfuseTracing();
    if (!loaded) return;
    this.loaded = loaded;
    this.processor = spanProcessor;
    this.wrapper = new BridgeTracerProvider(this);
    this.warnedOverridden = false;

    // Creates Langfuse's global state if it doesn't exist yet.
    loaded.module.getLangfuseTracerProvider();
    const state = (globalThis as any)[LANGFUSE_GLOBAL_SYMBOL];
    const descriptor =
      state && typeof state === "object"
        ? Object.getOwnPropertyDescriptor(state, PROVIDER_KEY)
        : undefined;

    if (descriptor?.configurable && "value" in descriptor) {
      // Self-healing: a later `setLangfuseTracerProvider(p)` by the app
      // becomes the provider we delegate to, instead of unhooking us.
      this.inner = (descriptor.value as TracerProvider | null) ?? null;
      const wrapper = this.wrapper;
      Object.defineProperty(state, PROVIDER_KEY, {
        get: () => wrapper,
        set: (provider: TracerProvider | null) => {
          if (provider === wrapper) return;
          this.inner = provider ?? null;
          logger.debug(
            "Laminar langfuse bridge: Langfuse tracer provider replaced; " +
              "now delegating to the new one.",
          );
        },
        enumerable: descriptor.enumerable,
        configurable: true,
      });
      this.state = state;
    } else {
      // Unknown Langfuse internals: use the public API, and check on flush
      // that nobody replaced us.
      const current = loaded.module.getLangfuseTracerProvider();
      this.inner =
        current === loaded.api.trace.getTracerProvider() ? null : current;
      loaded.module.setLangfuseTracerProvider(this.wrapper);
    }
    logger.debug("Laminar langfuse bridge installed");
  }

  uninstall(): void {
    const loaded = this.loaded;
    const wrapper = this.wrapper;
    if (!loaded || !wrapper) return;
    if (this.state) {
      // Back to a plain data property, as Langfuse created it.
      defineOwn(this.state, PROVIDER_KEY, this.inner);
      this.state = undefined;
    } else if (loaded.module.getLangfuseTracerProvider() === wrapper) {
      loaded.module.setLangfuseTracerProvider(this.inner);
    }
    this.wrapper = undefined;
    this.processor = undefined;
    this.inner = null;
  }

  onFlush(): void {
    if (
      !this.state &&
      this.wrapper &&
      !this.warnedOverridden &&
      this.loaded?.module.getLangfuseTracerProvider() !== this.wrapper
    ) {
      this.warnedOverridden = true;
      logger.warn(
        "Laminar langfuse bridge: setLangfuseTracerProvider() was called " +
          "after Laminar.initialize(), so Langfuse spans no longer reach " +
          "Laminar. Call Laminar.initialize() after setting the Langfuse " +
          "tracer provider.",
      );
    }
  }

  /** @internal */
  isInstalled(): boolean {
    return this.wrapper !== undefined && this.processor !== undefined;
  }

  /** @internal The provider Langfuse would use without the bridge. */
  innerProvider(): TracerProvider {
    return (
      this.inner ??
      this.loaded?.api.trace.getTracerProvider() ??
      otelApi.trace.getTracerProvider()
    );
  }

  /** @internal */
  mirror(span: Span, context: Context | undefined): void {
    const processor = this.processor;
    if (!processor) return;
    try {
      mirrorSpan(
        span as SdkSpan,
        context ??
          this.loaded?.api.context.active() ??
          otelApi.context.active(),
        processor,
      );
    } catch (e) {
      logger.debug(`Laminar langfuse bridge failed: ${errorMessage(e)}`);
    }
  }
}
