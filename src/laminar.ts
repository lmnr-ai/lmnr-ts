import { PipelineRunResponse, PipelineRunRequest, EvaluationDatapoint, EvaluationStatus } from './types';
import { Attributes, AttributeValue, context, createContextKey, isSpanContextValid, TimeInput, trace } from '@opentelemetry/api';
import { InitializeOptions, initialize as traceloopInitialize } from './sdk/node-server-sdk'
import { otelSpanIdToUUID, otelTraceIdToUUID } from './utils';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';

// quick patch to get the traceloop's default tracer, since their 
// `getTracer` function is not exported.
// Another option would be to import directly 
// like so: `import { getTracer } from '@traceloop/node-server-sdk/dist/src/lib/tracing/tracing';`
// which isn't too nice either.
const DEFAULT_TRACER_NAME = 'traceloop.tracer';

interface LaminarInitializeProps {
    projectApiKey?: string;
    env?: Record<string, string>;
    baseUrl?: string;
    instrumentModules?: InitializeOptions["instrumentModules"];
}

export class Laminar {
    private static baseUrl: string = 'https://api.lmnr.ai:8443';
    private static projectApiKey: string;
    private static env: Record<string, string> = {};
    private static isInitialized: boolean = false;

    /**
     * Initialize Laminar context across the application.
     * This method must be called before using any other Laminar methods or decorators.
     *
     * @param project_api_key - Laminar project api key. You can generate one by going
     * to the projects settings page on the Laminar dashboard.
     * If not specified, it will try to read from the LMNR_PROJECT_API_KEY environment variable.
     * @param env - Default environment passed to `run` and `evaluateEvent` requests,
     * unless overriden at request time. Usually, model provider keys are stored here.
     * @param baseUrl - Url of Laminar endpoint, or the custom open telemetry ingester.
     * If not specified, defaults to https://api.lmnr.ai:8443. For locally hosted Laminar,
     * default setting must be http://localhost:8001.
     * @param instrumentModules - List of modules to instrument.
     * If not specified, all auto-instrumentable modules will be instrumented, which include
     * LLM calls (OpenAI, Anthropic, etc), Langchain, VectorDB calls (Pinecone, Qdrant, etc).
     * Pass an empty object {} to disable any kind of automatic instrumentation.
     * If you only want to auto-instrument specific modules, then pass them in the object.
     * 
     * Example:
     * ```typescript
     * import { Laminar as L } from '@lmnr-ai/lmnr';
     * import { OpenAI } from 'openai';
     * import * as ChainsModule from "langchain/chains";
     * 
     * // Initialize Laminar while auto-instrumenting Langchain and OpenAI modules.
     * L.initialize({ projectApiKey: "<LMNR_PROJECT_API_KEY>", instrumentModules: {
     *  langchain: {
     *      chainsModule: ChainsModule
     *  },
     *  openAI: OpenAI
     * } });
     * ```
     *
     * @throws {Error} - If project API key is not set
     */
    public static initialize({
        projectApiKey,
        env,
        baseUrl,
        instrumentModules
    }: LaminarInitializeProps) {

        let key = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
        if (key === undefined) {
            throw new Error(
                'Please initialize the Laminar object with your project API key ' +
                'or set the LMNR_PROJECT_API_KEY environment variable'
            );
        }
        this.projectApiKey = key;
        if (baseUrl) {
            this.baseUrl = baseUrl;
        }
        this.isInitialized = true;
        this.env = env ?? {};

        const metadata = new Metadata();
        metadata.set('authorization', `Bearer ${this.projectApiKey}`);
        const exporter = new OTLPTraceExporter({
            url: this.baseUrl,
            metadata,
        });

        traceloopInitialize({
            exporter,
            silenceInitializationMessage: true,
            instrumentModules,
            disableBatch: false,
        });
    }

    /**
     * Check if Laminar has been initialized. Utility to make sure other methods
     * are called after initialization.
     */
    public static initialized(): boolean {
        return this.isInitialized;
    }

    /**
     * Sets the environment that will be sent to Laminar requests.
     * 
     * @param env - The environment variables to override. If not provided, the current environment will not be modified.
     */
    public static setEnv(env?: Record<string, string>) {
        if (env) {
            this.env = env;
        }
    }

    /**
     * Sets the project API key for authentication with Laminar.
     *
     * @param projectApiKey - The API key to be set. If not provided, the existing API key will not be modified.
     */
    public static setProjectApiKey(projectApiKey?: string) {
        if (projectApiKey) {
            this.projectApiKey = projectApiKey;
        }
    }

    /**
     * Runs the pipeline with the given inputs
     *
     * @param pipeline - The name of the Laminar pipeline. Pipeline must have a target version.
     * @param inputs - The inputs for the pipeline. Map from an input node name to input data.
     * @param env - The environment variables for the pipeline execution. Typically used for model provider keys.
     * @param metadata - Additional metadata for the pipeline run.
     * @param currentSpanId - The ID of the current span.
     * @param currentTraceId - The ID of the current trace.
     * @returns A promise that resolves to the response of the pipeline run.
     * @throws An error if the Laminar object is not initialized with a project API key. Or if the request fails.
     */
    public static async run({
        pipeline,
        inputs,
        env,
        metadata = {},
        currentSpanId,
        currentTraceId,
    }: PipelineRunRequest): Promise<PipelineRunResponse> {
        const currentSpan = trace.getActiveSpan();
        let parentSpanId: string | undefined;
        let traceId: string | undefined;
        if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
            parentSpanId = currentSpanId ?? otelSpanIdToUUID(currentSpan.spanContext().spanId);
            traceId = currentTraceId ?? otelTraceIdToUUID(currentSpan.spanContext().traceId);
        } else {
            parentSpanId = currentSpanId;
            traceId = currentTraceId;
        }
        if (this.projectApiKey === undefined) {
            throw new Error(
                'Please initialize the Laminar object with your project API key ' +
                'or set the LMNR_PROJECT_API_KEY environment variable'
            );
        }
        const envirionment = env === undefined ? this.env : env;

        const response = await fetch(`${this.baseUrl}/v1/pipeline/run`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                inputs,
                pipeline,
                env: envirionment,
                metadata,
                parentSpanId,
                traceId,
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to run pipeline ${pipeline}. Response: ${response.statusText}`);
        }
        try {
            return await response.json() as PipelineRunResponse;
        } catch (error) {
            throw new Error(`Failed to parse response from pipeline ${pipeline}. Error: ${error}`);
        }
    }

    /**
     * Associates an event with the current span. If event with such name never
     * existed, Laminar will create a new event and infer its type from the value.
     * If the event already exists, Laminar will append the value to the event
     * if and only if the value is of a matching type. Otherwise, the event won't
     * be recorded. Supported types are string, number, and boolean. If the value
     * is `null`, event is considered a boolean tag with the value of `true`.
     *
     * @param name - The name of the event.
     * @param value - The value of the event. Must be a primitive type. If not specified, boolean true is assumed in the backend.
     * @param timestamp - The timestamp of the event. If not specified, relies on the underlying OpenTelemetry implementation.
     *                    If specified as an integer, it must be epoch nanoseconds.
     */
    public static event(
        name: string,
        value?: AttributeValue,
        timestamp?: TimeInput,
    ) {
        const currentSpan = trace.getActiveSpan();
        if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
            console.warn("Laminar().event()\` called outside of span context." +
                ` Event '${name}' will not be recorded in the trace.` +
                " Make sure to annotate the function with a decorator"
            );
            return;
        }

        const event: Attributes = {
            "lmnr.event.type": "default",
        }
        if (value !== undefined) {
            event["lmnr.event.value"] = value;
        }

        currentSpan.addEvent(name, event, timestamp);
    }

    /**
     * Sends an event for evaluation to the Laminar backend.
     * 
     * @param name - The name of the event.
     * @param evaluator - The name of the pipeline that evaluates the event.
     * @param data - A map from input node name to its value in the evaluator pipeline.
     * @param env - Environment variables required to run the pipeline.
     * @param timestamp - If specified as an integer, it must be epoch nanoseconds.
     *                    If not specified, relies on the underlying OpenTelemetry implementation.
     */
    public static evaluateEvent(
        name: string,
        evaluator: string,
        data: Record<string, any>,
        env?: Record<string, string>,
        timestamp?: TimeInput,
    ) {
        const currentSpan = trace.getActiveSpan();

        if (currentSpan === undefined || !isSpanContextValid(currentSpan.spanContext())) {
            console.warn("Laminar().evaluateEvent()\` called outside of span context." +
                ` Evaluate event '${name}' will not be recorded in the trace.` +
                " Make sure to annotate the function with a decorator"
            );
            return;
        }

        const event = {
            "lmnr.event.type": "evaluate",
            "lmnr.event.evaluator": evaluator,
            "lmnr.event.data": JSON.stringify(data),
            "lmnr.event.env": JSON.stringify(env ?? {}),
        }

        currentSpan.addEvent(name, event, timestamp);
    }

    /**
     * Sets the session information for the current span and returns the context to use for the following spans.
     * 
     * Example:
     * ```typescript
     * import { context as contextApi } from '@opentelemetry/api';
     * import { Laminar } from '@lmnr-ai/laminar';
     * const context = Laminar.contextWithSession({ sessionId: "1234", userId: "5678" });
     * contextApi.with(context, () => {
     *    // Your code here
     * });
     * ```
     * 
     * @param sessionId - The session ID to associate with the span.
     * @param userId - The user ID to associate with the span.
     * @returns The updated context with the association properties.
     */
    public static contextWithSession({ sessionId, userId }: { sessionId?: string, userId?: string }) {

        const currentSpan = trace.getActiveSpan();
        if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
            if (sessionId) {
                currentSpan.setAttribute("traceloop.association.properties.session_id", sessionId);
            }
            if (userId) {
                currentSpan.setAttribute("traceloop.association.properties.user_id", userId);
            }
        }
        let associationProperties = {};
        if (sessionId) {
            associationProperties = { ...associationProperties, "session_id": sessionId };
        }
        if (userId) {
            associationProperties = { ...associationProperties, "user_id": userId };
        }
        return context.active().setValue(createContextKey("association_properites"), associationProperties);
    }

    public static async createEvaluation(name: string) {
        const response = await fetch(`${this.baseUrl}/v1/evaluations`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                name,
            })
        });

        return await response.json();
    }

    public static async postEvaluationResults<D, T, O>(
        evaluationName: string,
        data: EvaluationDatapoint<D, T, O>[]
    ): Promise<void> {
        const body = JSON.stringify({
            name: evaluationName,
            points: data,
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/evaluation-datapoints`;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers,
                body,
            });
            if (!response.ok) {
                console.error("Failed to send evaluation results. Response: ");
                response.text().then((text) => console.error(text));
            }
        } catch (error) {
            console.error("Failed to send evaluation results. Error: ", error);
        };
    }

    public static async updateEvaluationStatus(
        evaluationName: string,
        status: EvaluationStatus,
    ): Promise<void> {
        const body = JSON.stringify({
            name: evaluationName,
            status,
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/evaluations`;
        try {
            const response = await fetch(url, {
                method: "PUT",
                headers,
                body,
            });
            if (!response.ok) {
                console.error("Failed to update evaluation status. Response: ");
                response.text().then((text) => console.error(text));
            }
        } catch (error) {
            console.error("Failed to update evaluation status. Error: ", error);
        }
    }

    private static getHeaders() {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.projectApiKey}`,
        };
    };
}
