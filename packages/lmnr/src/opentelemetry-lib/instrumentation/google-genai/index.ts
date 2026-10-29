import { context, diag, SpanStatusCode } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { Laminar } from "../../../laminar";
import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
} from "../shared/base";
import {
  setRequestAttributes,
  setResponseAttributes,
  wrapStreamingResponse,
} from "./utils";

const WRAPPED_SYMBOL = Symbol("lmnr.google-genai.wrapped");
const CLASS_PATCH_DATA_SYMBOL = Symbol("lmnr.google-genai.classPatchData");

type ClassPatchData = {
  instrumentation: GoogleGenAiInstrumentation;
  originalModelsDescriptor: PropertyDescriptor | undefined;
};

export class GoogleGenAiInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("google-genai", config);
  }

  /**
   * Manual instrumentation accepts the `GoogleGenAI` class or the module
   * object with a `GoogleGenAI` export.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: "@google/genai",
        supportedVersions: [">=1.0.0"],
        patch: (moduleExports) => {
          const GoogleGenAIClass = resolveGoogleGenAIClass(moduleExports);
          if (GoogleGenAIClass) this.patchGoogleGenAIClass(GoogleGenAIClass);
        },
        unpatch: (moduleExports) => {
          const GoogleGenAIClass = resolveGoogleGenAIClass(moduleExports);
          if (GoogleGenAIClass) {
            this.unpatchGoogleGenAIClass(GoogleGenAIClass);
          }
        },
        accepts: (input) => resolveGoogleGenAIClass(input) !== undefined,
      },
    ];
  }

  private patchGoogleGenAIClass(GoogleGenAIClass: any): void {
    const classPatchData = GoogleGenAIClass[CLASS_PATCH_DATA_SYMBOL] as
      | ClassPatchData
      | undefined;
    if (classPatchData) {
      classPatchData.instrumentation = this;
      return;
    }

    const originalModelsDescriptor = Object.getOwnPropertyDescriptor(
      GoogleGenAIClass.prototype,
      "models",
    );
    if (originalModelsDescriptor && !originalModelsDescriptor.configurable) {
      diag.warn(
        "Could not patch GoogleGenAI.prototype.models: descriptor is non-configurable.",
      );
      return;
    }

    const patchData: ClassPatchData = {
      instrumentation: this,
      originalModelsDescriptor,
    };
    Object.defineProperty(GoogleGenAIClass, CLASS_PATCH_DATA_SYMBOL, {
      value: patchData,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    Object.defineProperty(GoogleGenAIClass.prototype, "models", {
      configurable: true,
      enumerable: originalModelsDescriptor?.enumerable ?? true,
      get: function () {
        if (originalModelsDescriptor?.get) {
          return originalModelsDescriptor.get.call(this);
        }
        return undefined;
      },
      set: function (value: any) {
        patchData.instrumentation.patchModelsInstance(value, patchData);
        if (originalModelsDescriptor?.set) {
          originalModelsDescriptor.set.call(this, value);
          return;
        }
        Object.defineProperty(this, "models", {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
  }

  private unpatchGoogleGenAIClass(GoogleGenAIClass: any): void {
    const classPatchData = GoogleGenAIClass[CLASS_PATCH_DATA_SYMBOL] as
      | ClassPatchData
      | undefined;
    if (!classPatchData) {
      return;
    }
    if (classPatchData.originalModelsDescriptor) {
      Object.defineProperty(
        GoogleGenAIClass.prototype,
        "models",
        classPatchData.originalModelsDescriptor,
      );
    } else {
      delete GoogleGenAIClass.prototype.models;
    }
    delete GoogleGenAIClass[CLASS_PATCH_DATA_SYMBOL];
  }

  private patchModelsInstance(
    models: any,
    classPatchData: ClassPatchData,
  ): void {
    if (!models || typeof models !== "object") return;
    if (typeof models.generateContent !== "function") return;
    if (typeof models.generateContentStream !== "function") return;

    // Guard against double-wrapping
    if (models[WRAPPED_SYMBOL]) return;

    const originalGenerateContent = models.generateContent.bind(models);
    const originalGenerateContentStream =
      models.generateContentStream.bind(models);
    models.generateContent = async function (params: any) {
      if (isTracingSuppressed(context.active())) {
        return originalGenerateContent(params);
      }

      const { instrumentation } = classPatchData;
      const { traceContent } = instrumentation;
      const span = instrumentation.startSpan({
        name: "gemini.generate_content",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, traceContent);

      return Laminar.withSpan(
        span,
        async () => {
          try {
            const response = await originalGenerateContent(params);
            setResponseAttributes(span, response, traceContent);
            return response;
          } catch (error) {
            span.setAttribute(
              "error.type",
              (error as Error).constructor?.name ?? "Error",
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          }
        },
        true,
      );
    };

    models.generateContentStream = async function (params: any) {
      if (isTracingSuppressed(context.active())) {
        return originalGenerateContentStream(params);
      }

      const { instrumentation } = classPatchData;
      const { traceContent } = instrumentation;
      const span = instrumentation.startSpan({
        name: "gemini.generate_content_stream",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, traceContent);

      try {
        const asyncGen = await originalGenerateContentStream(params);
        return wrapStreamingResponse(span, asyncGen, traceContent);
      } catch (error) {
        span.setAttribute(
          "error.type",
          (error as Error).constructor?.name ?? "Error",
        );
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    };

    models[WRAPPED_SYMBOL] = true;
  }
}

const resolveGoogleGenAIClass = (moduleOrClass: any): any => {
  if (typeof moduleOrClass === "function") {
    return moduleOrClass;
  }
  if (typeof moduleOrClass?.GoogleGenAI === "function") {
    return moduleOrClass.GoogleGenAI;
  }
  return undefined;
};
