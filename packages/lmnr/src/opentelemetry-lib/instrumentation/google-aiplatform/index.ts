import { context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { LaminarSpan } from "../../tracing/span";
import {
  setRequestAttributes,
  setResponseAttributes,
} from "../google-genai/utils";
import {
  InstrumentedModule,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../shared/base";
import {
  callWithSpan,
  finishSpan,
  recordSpanError,
  safely,
  safeSetAttribute,
  traceCall,
} from "../shared/utils";
import {
  setPredictRequestAttributes,
  setPredictResponseAttributes,
  toGenAiParams,
  VERTEX_AI_SYSTEM,
} from "./utils";

const VERTEXAI = "@google-cloud/vertexai";
const AIPLATFORM = "@google-cloud/aiplatform";

const GENERATIVE_MODEL_CLASSES = ["GenerativeModel", "GenerativeModelPreview"];
const GENERATIVE_MODEL_METHODS = ["generateContent", "generateContentStream"];

/**
 * Instruments Google Cloud Vertex AI:
 * - `@google-cloud/vertexai`: `GenerativeModel` (and `GenerativeModelPreview`)
 *   `generateContent` / `generateContentStream`.
 * - `@google-cloud/aiplatform`: `PredictionServiceClient.predict`.
 */
export class GoogleAIPlatformInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("google-aiplatform", config);
  }

  /**
   * Manual instrumentation accepts the `@google-cloud/vertexai` module (or
   * its `GenerativeModel` class) and/or the `@google-cloud/aiplatform` module
   * (or its `PredictionServiceClient` class), alone or in an array.
   */
  protected modules(): InstrumentedModule[] {
    return [
      {
        name: VERTEXAI,
        supportedVersions: [">=1.1.0"],
        patch: (moduleExports) => {
          for (const proto of generativeModelPrototypes(moduleExports)) {
            this.wrapMethod(proto, "generateContent", wrapGenerateContent);
            this.wrapMethod(
              proto,
              "generateContentStream",
              wrapGenerateContentStream,
            );
          }
        },
        unpatch: (moduleExports) => {
          for (const proto of generativeModelPrototypes(moduleExports)) {
            for (const method of GENERATIVE_MODEL_METHODS) {
              this.unwrapMethod(proto, method);
            }
          }
        },
        accepts: (input) => generativeModelPrototypes(input).length > 0,
      },
      {
        name: AIPLATFORM,
        supportedVersions: [">=3.10.0"],
        patch: (moduleExports) => {
          for (const proto of predictionServicePrototypes(moduleExports)) {
            this.wrapMethod(proto, "predict", wrapPredict);
          }
        },
        unpatch: (moduleExports) => {
          for (const proto of predictionServicePrototypes(moduleExports)) {
            this.unwrapMethod(proto, "predict");
          }
        },
        accepts: (input) => predictionServicePrototypes(input).length > 0,
      },
    ];
  }
}

/**
 * `GenerativeModel` / `GenerativeModelPreview` prototypes of the
 * `@google-cloud/vertexai` module, or the prototype of a bare model class.
 */
const generativeModelPrototypes = (moduleOrClass: any): any[] => {
  if (typeof moduleOrClass?.GenerativeModel === "function") {
    return GENERATIVE_MODEL_CLASSES.map((className) => moduleOrClass[className])
      .filter((cls) => typeof cls === "function")
      .map((cls) => cls.prototype);
  }
  if (typeof moduleOrClass?.prototype?.generateContent === "function") {
    return [moduleOrClass.prototype];
  }
  return [];
};

/**
 * `PredictionServiceClient` prototypes of the `@google-cloud/aiplatform`
 * module, or the prototype of a bare client class.
 */
const predictionServicePrototypes = (moduleOrClass: any): any[] => {
  if (typeof moduleOrClass?.PredictionServiceClient === "function") {
    // The top-level export is the v1 client; v1beta1 has its own prototype.
    const classes = [
      moduleOrClass.PredictionServiceClient,
      moduleOrClass.v1?.PredictionServiceClient,
      moduleOrClass.v1beta1?.PredictionServiceClient,
    ].filter((cls) => typeof cls === "function");
    return [...new Set(classes)].map((cls) => cls.prototype);
  }
  if (typeof moduleOrClass?.prototype?.predict === "function") {
    return [moduleOrClass.prototype];
  }
  return [];
};

const wrapGenerateContent = (patched: PatchedMethod) =>
  function (this: any, request: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, ...rest);
    }

    const span = instrumentation.startSpan(
      { name: "vertexai.generate_content", spanType: "LLM" },
      VERTEXAI,
    );
    const params = toGenAiParams(this, request);
    safely(() =>
      setRequestAttributes(
        span,
        params,
        instrumentation.traceContent,
        VERTEX_AI_SYSTEM,
      ),
    );

    return traceCall(
      span,
      () => original.call(this, request, ...rest),
      (result) => {
        safely(() =>
          setGenerateContentResponseAttributes(
            span,
            result?.response,
            params.model,
            instrumentation.traceContent,
          ),
        );
        span.end();
        return result;
      },
    );
  };

const wrapGenerateContentStream = (patched: PatchedMethod) =>
  function (this: any, request: any, ...rest: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.call(this, request, ...rest);
    }

    const span = instrumentation.startSpan(
      { name: "vertexai.generate_content_stream", spanType: "LLM" },
      VERTEXAI,
    );
    const params = toGenAiParams(this, request);
    safely(() =>
      setRequestAttributes(
        span,
        params,
        instrumentation.traceContent,
        VERTEX_AI_SYSTEM,
      ),
    );

    return traceCall(
      span,
      () => original.call(this, request, ...rest),
      (result) => {
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
                  instrumentation.traceContent,
                ),
              );
              span.end();
            },
            (error: unknown) => finishSpan(span, error),
          );
        } else {
          span.end();
        }
        return result;
      },
    );
  };

const wrapPredict = (patched: PatchedMethod) =>
  function (this: any, ...args: any[]) {
    const { instrumentation, original } = patched;
    if (isTracingSuppressed(context.active())) {
      return original.apply(this, args);
    }

    const span = instrumentation.startSpan(
      { name: "aiplatform.predict", spanType: "LLM" },
      AIPLATFORM,
    );
    safely(() =>
      setPredictRequestAttributes(span, args[0], instrumentation.traceContent),
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
          recordSpanError(span, error);
        } else {
          safely(() =>
            setPredictResponseAttributes(
              span,
              response,
              instrumentation.traceContent,
            ),
          );
        }
        span.end();
        return callback.call(this, error, response, ...rest);
      };
      try {
        return callWithSpan(span, () => original.apply(this, wrappedArgs));
      } catch (error) {
        finishSpan(span, error);
        throw error;
      }
    }

    return traceCall(
      span,
      () => original.apply(this, args),
      (result) => {
        safely(() =>
          setPredictResponseAttributes(
            span,
            Array.isArray(result) ? result[0] : result,
            instrumentation.traceContent,
          ),
        );
        span.end();
        return result;
      },
    );
  };

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
