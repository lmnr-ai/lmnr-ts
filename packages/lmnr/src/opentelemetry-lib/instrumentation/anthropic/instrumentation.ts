import {
  context,
  trace,
  type Span,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  InstrumentationBase,
  type InstrumentationConfig,
  type InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  safeExecuteInTheMiddle,
} from "@opentelemetry/instrumentation";
import type * as anthropic from "@anthropic-ai/sdk";
import type { Completion } from "@anthropic-ai/sdk/resources/completions";
import type {
  MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import { version } from "../../../../package.json";
import {
  setInputAttributes,
  setResponseAttributes,
  setStreamingResponseAttributes,
} from "./span-utils";
import { processResponseItem, createCompleteResponse } from "./streaming";

interface AnthropicInstrumentationConfig extends InstrumentationConfig {
  traceContent?: boolean;
}

export class AnthropicInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config: AnthropicInstrumentationConfig = {}) {
    super("@lmnr/anthropic-instrumentation", version, config);
    this.traceContent = config.traceContent ?? true;
  }

  public override setConfig(config: AnthropicInstrumentationConfig = {}) {
    super.setConfig(config);
    this.traceContent = config.traceContent ?? true;
  }

  public manuallyInstrument(module: typeof anthropic) {
    this._diag.debug("Patching @anthropic-ai/sdk manually");

    // Resolve the Anthropic class. When the user passes the default export
    // (e.g. `import Anthropic from '@anthropic-ai/sdk'`), the class IS the module.
    // When they pass the namespace (e.g. `import * as anthropic from '...'`),
    // the class is at module.Anthropic.
    const AnthropicClass = resolveAnthropicClass(module);

    try {
      this._wrap(
        AnthropicClass.Completions.prototype,
        "create",
        this.patchAnthropic("completion"),
      );
    } catch {
      // Completions may not exist in all SDK versions
    }
    try {
      this._wrap(
        AnthropicClass.Messages.prototype,
        "create",
        this.patchAnthropic("chat"),
      );
    } catch {
      // Messages should always exist but wrap safely
    }
    try {
      this._wrap(
        AnthropicClass.Beta.Messages.prototype,
        "create",
        this.patchAnthropic("chat"),
      );
    } catch {
      // Beta may not exist
    }
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@anthropic-ai/sdk",
      [">=0.9.1"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  private patch(moduleExports: typeof anthropic, moduleVersion?: string) {
    this._diag.debug(`Patching @anthropic-ai/sdk@${moduleVersion}`);

    try {
      this._wrap(
        moduleExports.Anthropic.Completions.prototype,
        "create",
        this.patchAnthropic("completion"),
      );
    } catch {
      // Completions may not exist
    }
    try {
      this._wrap(
        moduleExports.Anthropic.Messages.prototype,
        "create",
        this.patchAnthropic("chat"),
      );
    } catch {
      // Messages should always exist
    }
    try {
      this._wrap(
        moduleExports.Anthropic.Beta.Messages.prototype,
        "create",
        this.patchAnthropic("chat"),
      );
    } catch {
      // Beta may not exist
    }
    return moduleExports;
  }

  private unpatch(
    moduleExports: typeof anthropic,
    moduleVersion?: string,
  ): void {
    this._diag.debug(`Unpatching @anthropic-ai/sdk@${moduleVersion}`);

    try {
      this._unwrap(moduleExports.Anthropic.Completions.prototype, "create");
    } catch { /* may not exist */ }
    try {
      this._unwrap(moduleExports.Anthropic.Messages.prototype, "create");
    } catch { /* may not exist */ }
    try {
      this._unwrap(moduleExports.Anthropic.Beta.Messages.prototype, "create");
    } catch { /* may not exist */ }
  }

  private patchAnthropic(
    type: "chat" | "completion",
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    return (original: Function) => {
      return function method(this: any, ...args: unknown[]) {
        const params = (args[0] ?? {}) as Record<string, any>;
        const spanName = type === "chat" ? "anthropic.chat" : "anthropic.completion";

        const span = plugin.tracer.startSpan(spanName, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "anthropic",
          },
        });

        try {
          setInputAttributes(span, params, plugin.traceContent);
        } catch (e) {
          plugin._diag.debug(
            `Error setting input attributes: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const execContext = trace.setSpan(context.active(), span);
        const execPromise = safeExecuteInTheMiddle(
          () => {
            return context.with(execContext, () => {
              return original.apply(this, args);
            });
          },
          (e) => {
            if (e) {
              plugin._diag.error("Error in Anthropic instrumentation", e);
            }
          },
        );

        if (params.stream) {
          return context.bind(
            execContext,
            plugin._streamingWrapPromise({
              span,
              type,
              params,
              promise: execPromise,
            }),
          );
        }

        const wrappedPromise = plugin._wrapPromise(span, execPromise);
        return context.bind(execContext, wrappedPromise as any);
      };
    };
  }

  private _streamingWrapPromise(
    {
      span,
      type,
      params,
      promise,
    }: {
      span: Span;
      type: "chat" | "completion";
      params: Record<string, any>;
      promise: Promise<Stream<MessageStreamEvent>> | Promise<Stream<Completion>>;
    },
  ) {
    const plugin = this;

    async function* iterateStream(
      stream: Stream<MessageStreamEvent> | Stream<Completion>,
    ) {
      try {
        if (type === "chat") {
          const completeResponse = createCompleteResponse();

          for await (const chunk of stream) {
            yield chunk;
            processResponseItem(chunk, completeResponse);
          }

          try {
            setStreamingResponseAttributes(
              span,
              completeResponse,
              plugin.traceContent,
            );
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (e) {
            plugin._diag.debug(
              `Error setting streaming response attributes: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          span.end();
        } else {
          // Completion streaming (legacy)
          let completionText = "";
          let completionModel = "";
          let completionId = "";

          for await (const chunk of stream as Stream<Completion>) {
            yield chunk;

            try {
              completionId = chunk.id;
              if (chunk.model) completionModel = chunk.model;
              if (chunk.completion) completionText += chunk.completion;
            } catch {
              // ignore
            }
          }

          try {
            const responseData = {
              id: completionId,
              model: completionModel,
              completion: completionText,
              role: "assistant",
            };
            setResponseAttributes(span, responseData, plugin.traceContent);
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (e) {
            plugin._diag.debug(
              `Error setting completion response attributes: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          span.end();
        }
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error instanceof Error ? error : String(error));
        span.end();
        throw error;
      }
    }

    // Wrap the promise: when it resolves to a Stream, replace the stream's
    // async iterator with our instrumented one that collects span attributes.
    return (promise as Promise<any>).then(
      (realStream: any) => {
        // Use the Stream constructor to create a new stream with the same
        // controller and client, but with our instrumented iterator.
        return new realStream.constructor(
          () => iterateStream(realStream),
          realStream.controller,
        );
      },
      (error: Error) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        throw error;
      },
    );
  }

  private _wrapPromise<T>(
    span: Span,
    promise: Promise<T>,
  ): Promise<T> {
    return promise
      .then((result) => {
        try {
          const responseData = extractResponseData(result);
          setResponseAttributes(span, responseData, this.traceContent);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          this._diag.debug(
            `Error setting response attributes: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        span.end();
        return result;
      })
      .catch((error: Error) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        throw error;
      });
  }
}

/**
 * Resolve the Anthropic class from either a default export or namespace import.
 * - Default export: `import Anthropic from '@anthropic-ai/sdk'` → module itself is the class
 * - Namespace: `import * as anthropic from '...'` → module.Anthropic is the class
 */
const resolveAnthropicClass = (module: any): any => {
  // Check if the module itself has Messages/Completions (default export)
  if (typeof module === "function" && module.Messages) {
    return module;
  }
  // Namespace import
  if (module.Anthropic && typeof module.Anthropic === "function" && module.Anthropic.Messages) {
    return module.Anthropic;
  }
  // Fallback: check default export
  if (module.default && typeof module.default === "function" && module.default.Messages) {
    return module.default;
  }
  // If nothing works, just return module.Anthropic and hope for the best (original behavior)
  return module.Anthropic ?? module;
};

/**
 * Extract response data from various response types.
 */
const extractResponseData = (response: unknown): Record<string, any> => {
  if (response === null || response === undefined) {
    return {};
  }

  if (typeof response === "object") {
    // Anthropic SDK objects have toJSON - convert to plain object
    if ("toJSON" in response && typeof (response as any).toJSON === "function") {
      return (response as any).toJSON();
    }

    return response as Record<string, any>;
  }

  return {};
};
