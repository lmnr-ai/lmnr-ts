import { context, diag, SpanStatusCode } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";
import {
  safeSetAttribute,
  setRequestAttributes,
  setResponseAttributes,
} from "../google-genai/utils";
import {
  setPredictRequestAttributes,
  setPredictResponseAttributes,
  toGenAiParams,
  VERTEX_AI_SYSTEM,
} from "./utils";

const logger = initializeLogger();

const PATCH_DATA_SYMBOL = Symbol("lmnr.google-aiplatform.patchData");

type MethodPatchData = {
  traceContent: boolean;
  original: (...args: any[]) => any;
};

type MethodWrapperFactory = (
  original: (...args: any[]) => any,
  patchData: MethodPatchData,
) => (...args: any[]) => any;

// Patch data lives on the exact prototype it wraps, never an inherited one.
const hasOwnPatchData = (proto: any): boolean =>
  Object.getOwnPropertyDescriptor(proto, PATCH_DATA_SYMBOL) !== undefined;

const GENERATIVE_MODEL_CLASSES = ["GenerativeModel", "GenerativeModelPreview"];

const markSpanError = (span: LaminarSpan, error: unknown): void => {
  span.setAttribute(
    "error.type",
    (error as Error)?.constructor?.name ?? "Error",
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
};

/**
 * Attribute extraction must never break the user's call.
 */
const safely = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    logger.debug(
      `Failed to set google-aiplatform span attributes: ${String(error)}`,
    );
  }
};

/**
 * Instruments Google Cloud Vertex AI:
 * - `@google-cloud/vertexai`: `GenerativeModel` (and `GenerativeModelPreview`)
 *   `generateContent` / `generateContentStream`.
 * - `@google-cloud/aiplatform`: `PredictionServiceClient.predict`.
 */
export class GoogleAIPlatformInstrumentation extends InstrumentationBase {
  private traceContent: boolean;

  constructor(config?: { traceContent?: boolean }) {
    super("@lmnr/google-aiplatform-instrumentation", SDK_VERSION, {
      enabled: true,
    });
    this.traceContent = config?.traceContent ?? true;
  }

  protected init(): InstrumentationModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        "@google-cloud/vertexai",
        [">=1.1.0"],
        this.patchVertexAI.bind(this),
        this.unpatchVertexAI.bind(this),
      ),
      new InstrumentationNodeModuleDefinition(
        "@google-cloud/aiplatform",
        [">=3.10.0"],
        this.patchAIPlatform.bind(this),
        this.unpatchAIPlatform.bind(this),
      ),
    ];
  }

  /**
   * Accepts the `@google-cloud/vertexai` module (or its `GenerativeModel`
   * class) and/or the `@google-cloud/aiplatform` module (or its
   * `PredictionServiceClient` class).
   */
  public manuallyInstrument(module: any): void {
    const modules = Array.isArray(module) ? module : [module];
    for (const mod of modules) {
      if (this.isVertexAIModule(mod)) {
        diag.debug("Manually instrumenting @google-cloud/vertexai");
        this.patchVertexAI(mod);
      } else if (this.isAIPlatformModule(mod)) {
        diag.debug("Manually instrumenting @google-cloud/aiplatform");
        this.patchAIPlatform(mod);
      } else if (typeof mod?.prototype?.generateContent === "function") {
        diag.debug("Manually instrumenting Vertex AI GenerativeModel class");
        this.patchGenerativeModelClass(mod);
      } else if (typeof mod?.prototype?.predict === "function") {
        diag.debug("Manually instrumenting PredictionServiceClient class");
        this.patchPredictionServiceClass(mod);
      } else {
        diag.warn(
          "Could not find GenerativeModel or PredictionServiceClient in " +
            "google_aiplatform manual instrumentation input. Pass the " +
            "@google-cloud/vertexai or @google-cloud/aiplatform module.",
        );
      }
    }
  }

  private isVertexAIModule(mod: any): boolean {
    return typeof mod?.GenerativeModel === "function";
  }

  private isAIPlatformModule(mod: any): boolean {
    return typeof mod?.PredictionServiceClient === "function";
  }

  private patchVertexAI(moduleExports: any): any {
    diag.debug("Patching @google-cloud/vertexai");
    for (const className of GENERATIVE_MODEL_CLASSES) {
      const cls = moduleExports?.[className];
      if (typeof cls === "function") {
        this.patchGenerativeModelClass(cls);
      }
    }
    return moduleExports;
  }

  private unpatchVertexAI(moduleExports: any): void {
    diag.debug("Unpatching @google-cloud/vertexai");
    for (const className of GENERATIVE_MODEL_CLASSES) {
      const cls = moduleExports?.[className];
      if (typeof cls === "function") {
        this.unpatchMethods(cls.prototype);
      }
    }
  }

  private patchAIPlatform(moduleExports: any): any {
    diag.debug("Patching @google-cloud/aiplatform");
    for (const cls of this.predictionServiceClasses(moduleExports)) {
      this.patchPredictionServiceClass(cls);
    }
    return moduleExports;
  }

  private unpatchAIPlatform(moduleExports: any): void {
    diag.debug("Unpatching @google-cloud/aiplatform");
    for (const cls of this.predictionServiceClasses(moduleExports)) {
      this.unpatchMethods(cls.prototype);
    }
  }

  private predictionServiceClasses(moduleExports: any): any[] {
    // The top-level export is the v1 client; v1beta1 has its own prototype.
    const classes = [
      moduleExports?.PredictionServiceClient,
      moduleExports?.v1?.PredictionServiceClient,
      moduleExports?.v1beta1?.PredictionServiceClient,
    ].filter((cls) => typeof cls === "function");
    return [...new Set(classes)];
  }

  private patchGenerativeModelClass(cls: any): void {
    this.patchMethod(cls.prototype, "generateContent", (original, data) =>
      this.wrapGenerateContent(original, data),
    );
    this.patchMethod(cls.prototype, "generateContentStream", (original, data) =>
      this.wrapGenerateContentStream(original, data),
    );
  }

  private patchPredictionServiceClass(cls: any): void {
    this.patchMethod(cls.prototype, "predict", (original, data) =>
      this.wrapPredict(original, data),
    );
  }

  /**
   * Replace `proto[method]` with a traced wrapper. Re-patching an already
   * patched prototype only refreshes `traceContent`, so repeated
   * initialization never double-wraps.
   */
  private patchMethod(
    proto: any,
    method: string,
    makeWrapper: MethodWrapperFactory,
  ): void {
    if (!proto || typeof proto[method] !== "function") return;

    if (!hasOwnPatchData(proto)) {
      Object.defineProperty(proto, PATCH_DATA_SYMBOL, {
        value: {},
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    const patches = proto[PATCH_DATA_SYMBOL] as Record<string, MethodPatchData>;
    const existing = patches[method];
    if (existing) {
      existing.traceContent = this.traceContent;
      return;
    }

    const patchData: MethodPatchData = {
      traceContent: this.traceContent,
      original: proto[method],
    };
    patches[method] = patchData;
    proto[method] = makeWrapper(patchData.original, patchData);
  }

  private unpatchMethods(proto: any): void {
    if (!proto || !hasOwnPatchData(proto)) {
      return;
    }
    const patches = proto[PATCH_DATA_SYMBOL] as Record<string, MethodPatchData>;
    for (const [method, patchData] of Object.entries(patches)) {
      proto[method] = patchData.original;
    }
    delete proto[PATCH_DATA_SYMBOL];
  }

  private wrapGenerateContent(
    original: (...args: any[]) => any,
    patchData: MethodPatchData,
  ) {
    return function (this: any, request: any, ...rest: any[]) {
      if (isTracingSuppressed(context.active())) {
        return original.call(this, request, ...rest);
      }

      const span = Laminar.startSpan({
        name: "vertexai.generate_content",
        spanType: "LLM",
      }) as LaminarSpan;
      const params = toGenAiParams(this, request);
      safely(() =>
        setRequestAttributes(
          span,
          params,
          patchData.traceContent,
          VERTEX_AI_SYSTEM,
        ),
      );

      return Laminar.withSpan(
        span,
        async () => {
          try {
            const result = await original.call(this, request, ...rest);
            safely(() =>
              setGenerateContentResponseAttributes(
                span,
                result?.response,
                params.model,
                patchData.traceContent,
              ),
            );
            return result;
          } catch (error) {
            markSpanError(span, error);
            throw error;
          }
        },
        true,
      );
    };
  }

  private wrapGenerateContentStream(
    original: (...args: any[]) => any,
    patchData: MethodPatchData,
  ) {
    return async function (this: any, request: any, ...rest: any[]) {
      if (isTracingSuppressed(context.active())) {
        return original.call(this, request, ...rest);
      }

      const span = Laminar.startSpan({
        name: "vertexai.generate_content_stream",
        spanType: "LLM",
      }) as LaminarSpan;
      const params = toGenAiParams(this, request);
      safely(() =>
        setRequestAttributes(
          span,
          params,
          patchData.traceContent,
          VERTEX_AI_SYSTEM,
        ),
      );

      let result: any;
      try {
        // withSpan records the exception if the call rejects.
        result = await Laminar.withSpan(span, () =>
          original.call(this, request, ...rest),
        );
      } catch (error) {
        markSpanError(span, error);
        span.end();
        throw error;
      }

      // `result.response` aggregates the stream on its own tee'd branch, so
      // it settles even if the caller never drains `result.stream`.
      const aggregated = result?.response;
      if (aggregated && typeof aggregated.then === "function") {
        aggregated.then(
          (response: any) => {
            safely(() =>
              setGenerateContentResponseAttributes(
                span,
                response,
                params.model,
                patchData.traceContent,
              ),
            );
            span.end();
          },
          (error: unknown) => {
            span.recordException(error as Error);
            markSpanError(span, error);
            span.end();
          },
        );
      } else {
        span.end();
      }
      return result;
    };
  }

  private wrapPredict(
    original: (...args: any[]) => any,
    patchData: MethodPatchData,
  ) {
    return function (this: any, ...args: any[]) {
      if (isTracingSuppressed(context.active())) {
        return original.apply(this, args);
      }

      const span = Laminar.startSpan({
        name: "aiplatform.predict",
        spanType: "LLM",
      }) as LaminarSpan;
      safely(() =>
        setPredictRequestAttributes(span, args[0], patchData.traceContent),
      );

      // Callback overloads: predict(request, callback) and
      // predict(request, options, callback) return void.
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback === "function") {
        const wrappedArgs = [...args];
        wrappedArgs[callbackIndex] = function (
          this: any,
          error: unknown,
          response: any,
          ...rest: any[]
        ) {
          if (error) {
            span.recordException(error as Error);
            markSpanError(span, error);
          } else {
            safely(() =>
              setPredictResponseAttributes(
                span,
                response,
                patchData.traceContent,
              ),
            );
          }
          span.end();
          return callback.call(this, error, response, ...rest);
        };
        try {
          return Laminar.withSpan(span, () =>
            original.apply(this, wrappedArgs),
          );
        } catch (error) {
          markSpanError(span, error);
          span.end();
          throw error;
        }
      }

      return Laminar.withSpan(
        span,
        async () => {
          try {
            const result = await original.apply(this, args);
            safely(() =>
              setPredictResponseAttributes(
                span,
                Array.isArray(result) ? result[0] : result,
                patchData.traceContent,
              ),
            );
            return result;
          } catch (error) {
            markSpanError(span, error);
            throw error;
          }
        },
        true,
      );
    };
  }
}

const setGenerateContentResponseAttributes = (
  span: LaminarSpan,
  response: any,
  requestModel: string | undefined,
  traceContent: boolean,
): void => {
  setResponseAttributes(span, response, traceContent);
  // Vertex AI responses don't always carry `modelVersion`.
  if (!response?.modelVersion) {
    safeSetAttribute(span, "gen_ai.response.model", requestModel);
  }
};
