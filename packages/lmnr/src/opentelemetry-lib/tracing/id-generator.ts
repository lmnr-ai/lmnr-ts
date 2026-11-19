import { type IdGenerator, RandomIdGenerator } from "@opentelemetry/sdk-trace";

import { initializeLogger } from "../../utils";

const logger = initializeLogger();

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = "0".repeat(32);

export const isValidTraceId = (value: unknown): value is string =>
  typeof value === "string" &&
  TRACE_ID_RE.test(value) &&
  value !== INVALID_TRACE_ID;

// Set only while `withForcedTraceId` runs. Span creation is synchronous, so a
// module slot needs no context manager (a context key would be lost on hosts
// without a working global one).
let forcedTraceId: string | undefined;

/**
 * Run `fn` (which should create exactly one root span) with `traceId` forced
 * as that span's trace id. OTel calls the IdGenerator only for spans without a
 * valid parent, so child spans are unaffected. A missing or invalid id runs
 * `fn` as is.
 */
export const withForcedTraceId = <T>(
  traceId: string | undefined,
  fn: () => T,
): T => {
  if (!isValidTraceId(traceId)) {
    return fn();
  }
  const previous = forcedTraceId;
  forcedTraceId = traceId;
  try {
    return fn();
  } finally {
    forcedTraceId = previous;
  }
};

const LAMINAR_ID_GENERATOR = Symbol.for("lmnr.id_generator");

/**
 * The IdGenerator of Laminar's TracerProvider: random ids, except that a root
 * span created inside {@link withForcedTraceId} gets the forced trace id. Used
 * to put every request of one MCP turn into one trace while keeping each
 * request's span a root (a fake remote parent would leave a dangling parent
 * span id, and the span would vanish from the trace view).
 */
export class LaminarIdGenerator implements IdGenerator {
  readonly [LAMINAR_ID_GENERATOR] = true;
  private readonly random = new RandomIdGenerator();

  generateTraceId(): string {
    return forcedTraceId ?? this.random.generateTraceId();
  }

  generateSpanId(): string {
    return this.random.generateSpanId();
  }
}

const patchedGenerators = new WeakSet<object>();

/**
 * Make sure root spans started from `tracer` honor {@link withForcedTraceId}.
 *
 * Laminar's own provider already does (it is built with
 * {@link LaminarIdGenerator}). When Laminar runs as a `LaminarSpanProcessor`
 * inside an app-owned provider, the tracer is the app's: its SDK `Tracer`
 * keeps the provider's generator in the `_idGenerator` field (OTel JS v1, v2
 * and v3 alike), so the generator's `generateTraceId` is wrapped in place to
 * return the forced id when one is set, and otherwise to call the original.
 * Behavior outside `withForcedTraceId` is unchanged.
 *
 * Unwraps `LaminarTracer` (`_tracer`) and the api's `ProxyTracer`
 * (`_getTracer()`). Returns false when forcing is impossible (no SDK tracer,
 * an unknown tracer implementation): the caller then gets random trace ids.
 */
export const enableForcedTraceIds = (tracer: unknown): boolean => {
  try {
    let current: any = tracer;
    for (let i = 0; i < 4 && current; i++) {
      const generator = current._idGenerator;
      if (generator && typeof generator.generateTraceId === "function") {
        if (
          generator[LAMINAR_ID_GENERATOR] ||
          patchedGenerators.has(generator)
        ) {
          return true;
        }
        const original = generator.generateTraceId.bind(generator);
        generator.generateTraceId = () => forcedTraceId ?? original();
        patchedGenerators.add(generator);
        return true;
      }
      if (current._tracer) {
        current = current._tracer;
      } else if (typeof current._getTracer === "function") {
        current = current._getTracer();
      } else {
        return false;
      }
    }
  } catch (e) {
    logger.debug(`Could not enable forced trace ids: ${String(e)}`);
  }
  return false;
};
