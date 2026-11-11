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
import { errorMessage } from "@lmnr-ai/types";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  context as otelContext,
  type Span,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";

import { initializeLogger } from "../../../utils";
import { type LaminarSpanProcessor } from "../../tracing/processor";
import {
  type Bridge,
  type BridgeContext,
  LLM_INSTRUMENTATIONS,
} from "../types";
import { translateLangfuseSpan } from "./translate";

const logger = initializeLogger();

// @langfuse/tracing 4.x - 6.x keep `{ isolatedTracerProvider }` in a locked
// `globalThis[Symbol.for("langfuse")]` slot, create it only when it is
// missing, and read the provider from it on every span.
const LANGFUSE_GLOBAL_SYMBOL = Symbol.for("langfuse");
const PROVIDER_KEY = "isolatedTracerProvider";

/**
 * Langfuse's global state, created the way Langfuse creates it if Langfuse
 * hasn't run yet. The bridge never loads `@langfuse/tracing`: every copy of
 * it (CJS, ESM, duplicates, bundled) shares this slot, and resolving the
 * package fails in bundled apps.
 */
const langfuseState = (): Record<string, unknown> | undefined => {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (!g[LANGFUSE_GLOBAL_SYMBOL]) {
    Object.defineProperty(g, LANGFUSE_GLOBAL_SYMBOL, {
      value: { [PROVIDER_KEY]: null },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
  const state = g[LANGFUSE_GLOBAL_SYMBOL];
  return state && typeof state === "object"
    ? (state as Record<string, unknown>)
    : undefined;
};

/** The provider slot, if it is still the plain data property we can hook. */
const providerDescriptor = (
  state: Record<string, unknown> | undefined,
): PropertyDescriptor | undefined => {
  const descriptor = state
    ? Object.getOwnPropertyDescriptor(state, PROVIDER_KEY)
    : undefined;
  return descriptor?.configurable && "value" in descriptor
    ? descriptor
    : undefined;
};

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
  const copyAttributes: Record<string, AttributeValue | undefined> = {
    ...attributes,
    ...laminarAttributes,
    ...translated.attributes,
  };
  for (const [key, value] of Object.entries(copyAttributes)) {
    if (value === undefined) delete copyAttributes[key];
  }
  const copy = Object.create(span) as SdkSpan;
  defineOwn(copy, "attributes", copyAttributes);
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

  private processor: LaminarSpanProcessor | undefined;
  private wrapper: BridgeTracerProvider | undefined;
  /** Provider Langfuse used before us (or the one set after us); null = global. */
  private inner: TracerProvider | null = null;
  /** Langfuse's global state object while the accessor is installed on it. */
  private state: Record<string, unknown> | undefined;

  isAvailable(): boolean {
    try {
      if (providerDescriptor(langfuseState())) return true;
    } catch (e) {
      logger.debug(`Laminar langfuse bridge: ${errorMessage(e)}`);
    }
    logger.warn(
      "Laminar langfuse bridge: Langfuse's tracer provider slot " +
        `(globalThis[Symbol.for("langfuse")].${PROVIDER_KEY}) is not the ` +
        "one @langfuse/tracing 4.x - 6.x use, skipping.",
    );
    return false;
  }

  install({ spanProcessor }: BridgeContext): void {
    const state = langfuseState();
    const descriptor = providerDescriptor(state);
    if (!state || !descriptor) return;
    const wrapper = new BridgeTracerProvider(this);
    this.processor = spanProcessor;
    this.wrapper = wrapper;
    // Self-healing: a later `setLangfuseTracerProvider(p)` by the app
    // becomes the provider we delegate to, instead of unhooking us.
    this.inner = (descriptor.value as TracerProvider | null) ?? null;
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
    logger.debug("Laminar langfuse bridge installed");
  }

  uninstall(): void {
    if (this.state) {
      // Back to a plain data property, as Langfuse created it.
      defineOwn(this.state, PROVIDER_KEY, this.inner);
    }
    this.state = undefined;
    this.wrapper = undefined;
    this.processor = undefined;
    this.inner = null;
  }

  /** @internal */
  isInstalled(): boolean {
    return this.wrapper !== undefined && this.processor !== undefined;
  }

  /** @internal The provider Langfuse would use without the bridge. */
  innerProvider(): TracerProvider {
    // Laminar shares the app's `@opentelemetry/api`, so this is the global
    // provider Langfuse itself would fall back to.
    return this.inner ?? trace.getTracerProvider();
  }

  /** @internal */
  mirror(span: Span, context: Context | undefined): void {
    const processor = this.processor;
    if (!processor) return;
    try {
      mirrorSpan(span as SdkSpan, context ?? otelContext.active(), processor);
    } catch (e) {
      logger.debug(`Laminar langfuse bridge failed: ${errorMessage(e)}`);
    }
  }
}
