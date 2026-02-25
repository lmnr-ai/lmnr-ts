import { context, diag, SpanStatusCode } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { setRequestAttributes, setResponseAttributes, wrapStreamingResponse } from "./utils";

const WRAPPED_SYMBOL = Symbol("lmnr.google-genai.wrapped");
const CLASS_PATCH_DATA_SYMBOL = Symbol("lmnr.google-genai.classPatchData");

type ClassPatchData = {
  instrumentation: GoogleGenAiInstrumentation;
  traceContent: boolean;
  originalModelsDescriptor: PropertyDescriptor | undefined;
};

/* eslint-disable
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
    const GoogleGenAIClass = this.resolveGoogleGenAIClass(genaiModule);
    if (GoogleGenAIClass) {
      this.patchGoogleGenAIClass(GoogleGenAIClass);
    } else {
      diag.warn(
        "Could not find GoogleGenAI class in google_genai manual instrumentation input. " +
        "Pass either GoogleGenAI class or module object with GoogleGenAI export.",
      );
    }
  }

  private patch(moduleExports: any): any {
    diag.debug("Patching @google/genai");
    const GoogleGenAIClass = this.resolveGoogleGenAIClass(moduleExports);
    if (GoogleGenAIClass) {
      this.patchGoogleGenAIClass(GoogleGenAIClass);
    }
    return moduleExports;
  }

  private unpatch(moduleExports: any): void {
    diag.debug("Unpatching @google/genai");
    const GoogleGenAIClass = this.resolveGoogleGenAIClass(moduleExports);
    if (GoogleGenAIClass) {
      this.unpatchGoogleGenAIClass(GoogleGenAIClass);
    }
  }

  private resolveGoogleGenAIClass(moduleOrClass: any): any {
    if (typeof moduleOrClass === "function") {
      return moduleOrClass;
    }
    if (moduleOrClass?.GoogleGenAI && typeof moduleOrClass.GoogleGenAI === "function") {
      return moduleOrClass.GoogleGenAI;
    }
    return undefined;
  }

  private patchGoogleGenAIClass(GoogleGenAIClass: any): void {
    const classPatchData = (
      GoogleGenAIClass[CLASS_PATCH_DATA_SYMBOL] as ClassPatchData | undefined
    );
    if (classPatchData) {
      classPatchData.instrumentation = this;
      classPatchData.traceContent = this.traceContent;
      return;
    }

    const originalModelsDescriptor = Object.getOwnPropertyDescriptor(
      GoogleGenAIClass.prototype,
      "models",
    );
    if (originalModelsDescriptor && !originalModelsDescriptor.configurable) {
      diag.warn("Could not patch GoogleGenAI.prototype.models: descriptor is non-configurable.");
      return;
    }

    const patchData: ClassPatchData = {
      instrumentation: this,
      traceContent: this.traceContent,
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
    const classPatchData = GoogleGenAIClass[CLASS_PATCH_DATA_SYMBOL] as ClassPatchData | undefined;
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

  private patchModelsInstance(models: any, classPatchData: ClassPatchData): void {
    if (!models || typeof models !== "object") return;
    if (typeof models.generateContent !== "function") return;
    if (typeof models.generateContentStream !== "function") return;

    // Guard against double-wrapping
    if (models[WRAPPED_SYMBOL]) return;

    const originalGenerateContent = models.generateContent.bind(models);
    const originalGenerateContentStream = models.generateContentStream.bind(models);
    models.generateContent = async function (params: any) {
      if (isTracingSuppressed(context.active())) {
        return originalGenerateContent(params);
      }

      const span = Laminar.startSpan({
        name: "gemini.generate_content",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, classPatchData.traceContent);

      return Laminar.withSpan(span, async () => {
        try {
          const response = await originalGenerateContent(params);
          setResponseAttributes(span, response, classPatchData.traceContent);
          span.end();
          return response;
        } catch (error) {
          span.setAttribute("error.type", (error as Error).constructor?.name ?? "Error");
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          throw error;
        }
      });
    };

    models.generateContentStream = async function (params: any) {
      if (isTracingSuppressed(context.active())) {
        return originalGenerateContentStream(params);
      }

      const span = Laminar.startSpan({
        name: "gemini.generate_content_stream",
        spanType: "LLM",
      });

      setRequestAttributes(span, params, classPatchData.traceContent);

      return Laminar.withSpan(span, async () => {
        try {
          const asyncGen = await originalGenerateContentStream(params);
          return wrapStreamingResponse(span, asyncGen, classPatchData.traceContent);
        } catch (error) {
          span.setAttribute("error.type", (error as Error).constructor?.name ?? "Error");
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          throw error;
        }
      });
    };

    models[WRAPPED_SYMBOL] = true;
  }
}
/* eslint-enable
  @typescript-eslint/no-unsafe-return
*/
