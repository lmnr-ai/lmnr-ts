import { context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../shared/base";
import {
  finishSpan,
  instrumentStream,
  isAsyncIterable,
  safely,
  traceCall,
} from "../shared/utils";
import {
  createStreamState,
  processStreamEvent,
  setRequestAttributes,
  setResponseAttributes,
  setStreamingResponseAttributes,
} from "./utils";

/**
 * Resolve the `Anthropic` client class from the module namespace, its default
 * export, or the class itself.
 */
const resolveClientClass = (mod: any): any => {
  for (const candidate of [mod?.Anthropic, mod?.default, mod]) {
    if (typeof candidate?.Messages === "function") {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Instruments `@anthropic-ai/sdk`: `messages.create`, `beta.messages.create`
 * and the legacy `completions.create`. `messages.parse()` and
 * `messages.stream()` (and their beta counterparts) delegate to `create`, so
 * they are traced through it without nesting a second span.
 */
export class AnthropicInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("anthropic", config);
  }

  /**
   * Manual instrumentation accepts the `@anthropic-ai/sdk` module namespace
   * or the `Anthropic` class (the module's default export).
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@anthropic-ai/sdk",
        supportedVersions: [">=0.9.1"],
        patch: (moduleExports) => this.patch(moduleExports),
        unpatch: (moduleExports) => this.unpatch(moduleExports),
        accepts: (input) => resolveClientClass(input) !== undefined,
      },
    ];
  }

  private patch(moduleExports: any): void {
    const [completions, ...messages] = resourcePrototypes(moduleExports);
    this.wrapMethod(completions, "create", (patched) =>
      wrapCreate(patched, "anthropic.completion"),
    );
    for (const proto of messages) {
      this.wrapMethod(proto, "create", (patched) =>
        wrapCreate(patched, "anthropic.chat"),
      );
    }
  }

  private unpatch(moduleExports: any): void {
    for (const proto of resourcePrototypes(moduleExports)) {
      this.unwrapMethod(proto, "create");
    }
  }
}

/**
 * `[Completions, Messages, Beta.Messages]` prototypes; entries are undefined
 * where the installed SDK version lacks the resource.
 */
const resourcePrototypes = (moduleExports: any): any[] => {
  const client = resolveClientClass(moduleExports);
  return [
    client?.Completions?.prototype,
    client?.Messages?.prototype,
    client?.Beta?.Messages?.prototype,
  ];
};

const wrapCreate = (patched: PatchedMethod, spanName: string) =>
  function (this: any, params: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, params, ...rest);
    }

    const { traceContent } = instrumentation;
    const span = instrumentation.startSpan({
      name: spanName,
      spanType: "LLM",
    });
    safely(() => setRequestAttributes(span, params, traceContent));

    return traceCall(
      span,
      () => original.call(this, params, ...rest),
      (data) => {
        if (params?.stream && isAsyncIterable(data)) {
          // Aggregate the raw stream events as the caller iterates them.
          const state = createStreamState();
          instrumentStream(data, {
            onEvent: (event) => processStreamEvent(state, event),
            onDone: (error) => {
              safely(() =>
                setStreamingResponseAttributes(span, state, traceContent),
              );
              finishSpan(span, error);
            },
          });
          return data;
        }
        safely(() => setResponseAttributes(span, data, traceContent));
        span.end();
        return data;
      },
    );
  };
