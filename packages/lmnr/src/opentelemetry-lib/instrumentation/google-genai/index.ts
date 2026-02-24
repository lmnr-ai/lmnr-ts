import { context, diag, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  isWrapped,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { setRequestAttributes, setResponseAttributes, wrapStreamingResponse } from "./utils";

const WRAPPED_SYMBOL = Symbol("lmnr.google-genai.wrapped");

/* eslint-disable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-return
*/
export class GoogleGenAiInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super(
      "@lmnr/google-genai-instrumentation",
      SDK_VERSION,
      { enabled: true },
    );
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@google/genai",
      [">=1.0.0"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(genaiModule: any): void {
    diag.debug("Manually instrumenting @google/genai");
    if (genaiModule.GoogleGenAI) {
      try {
        this._wrap(
          genaiModule,
          "GoogleGenAI",
          this.wrapGoogleGenAIClass.bind(this),
        );
      } catch {
        // ES module namespace objects have non-configurable properties,
        // so _wrap (which uses Object.defineProperty) will throw.
        // Fall back to direct property assignment on mutable objects.
        const patched = this.wrapGoogleGenAIClass(genaiModule.GoogleGenAI);
        try {
          genaiModule.GoogleGenAI = patched;
        } catch {
          diag.warn(
            "Could not patch GoogleGenAI on the provided module object. " +
            "Pass a mutable object: { GoogleGenAI } instead of the ES module namespace.",
          );
        }
      }
    }
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @google/genai");
    if (moduleExports.GoogleGenAI) {
      this._wrap(
        moduleExports,
        "GoogleGenAI",
        this.wrapGoogleGenAIClass.bind(this),
      );
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @google/genai");
    if (isWrapped(moduleExports.GoogleGenAI)) {
      this._unwrap(moduleExports, "GoogleGenAI");
    }
  }

  private wrapGoogleGenAIClass(Original: any): any {
    const instrumentation = this;

    class PatchedGoogleGenAI extends Original {
      constructor(...args: any[]) {
        super(...args);
        instrumentation.patchModelsInstance(this.models);
      }
    }

    return PatchedGoogleGenAI;
  }

  private patchModelsInstance(models: any): void {
    // Guard against double-wrapping
    if (models[WRAPPED_SYMBOL]) return;

    const originalGenerateContent = models.generateContent.bind(models);
    const originalGenerateContentStream = models.generateContentStream.bind(models);
    const traceContent = this.traceContent;

    models.generateContent = async function (params: any) {
      // Check OTel suppression
      const activeContext = context.active();
      const suppressionKey = Symbol.for("OpenTelemetry Context Key SUPPRESS_TRACING");
      if (activeContext.getValue(suppressionKey)) {
        return originalGenerateContent(params);
      }

      const span = Laminar.startSpan({
        name: "gemini.generate_content",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, traceContent);

      return context.with(
        trace.setSpan(context.active(), span),
        async () => {
          try {
            const response = await originalGenerateContent(params);
            setResponseAttributes(span, response, traceContent);
            span.end();
            return response;
          } catch (error) {
            span.setAttribute("error.type", (error as Error).constructor?.name ?? "Error");
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw error;
          }
        },
      );
    };

    models.generateContentStream = async function (params: any) {
      // Check OTel suppression
      const activeContext = context.active();
      const suppressionKey = Symbol.for("OpenTelemetry Context Key SUPPRESS_TRACING");
      if (activeContext.getValue(suppressionKey)) {
        return originalGenerateContentStream(params);
      }

      const span = Laminar.startSpan({
        name: "gemini.generate_content_stream",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, traceContent);

      return context.with(
        trace.setSpan(context.active(), span),
        async () => {
          try {
            const asyncGen = await originalGenerateContentStream(params);
            return wrapStreamingResponse(span, asyncGen, traceContent);
          } catch (error) {
            span.setAttribute("error.type", (error as Error).constructor?.name ?? "Error");
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw error;
          }
        },
      );
    };

    models[WRAPPED_SYMBOL] = true;
  }
}
/* eslint-enable
  @typescript-eslint/no-this-alias,
  @typescript-eslint/no-unsafe-return
*/
