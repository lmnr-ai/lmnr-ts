import {
    PipelineRunResponse,
    PipelineRunRequest,
    EvaluationDatapoint,
    CreateEvaluationResponse,
    GetDatapointsResponse
} from './types';
import {
    Attributes,
    AttributeValue,
    context,
    isSpanContextValid,
    TimeInput,
    trace
} from '@opentelemetry/api';
import { InitializeOptions, initialize as traceloopInitialize } from './sdk/node-server-sdk'
import { otelSpanIdToUUID, otelTraceIdToUUID } from './utils';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import { ASSOCIATION_PROPERTIES_KEY } from './sdk/tracing/tracing';
import { forceFlush } from './sdk/node-server-sdk';
import { SESSION_ID, USER_ID, LaminarAttributes } from './sdk/tracing/attributes';


interface LaminarInitializeProps {
    projectApiKey?: string;
    env?: Record<string, string>;
    baseUrl?: string;
    httpPort?: number;
    grpcPort?: number;
    instrumentModules?: InitializeOptions["instrumentModules"];
}

export class Laminar {
    private static baseHttpUrl: string;
    private static baseGrpcUrl: string;
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
     * @param env - Default environment passed to `run` requests, unless overriden at request
     * time. Usually, model provider keys are stored here.
     * @param baseUrl - Laminar API url. Do not include the port, use
     * `httpPort` and `grpcPort` instead.
     * If not specified, defaults to https://api.lmnr.ai.
     * @param httpPort - Laminar API http port.
     * If not specified, defaults to 443.
     * @param grpcPort - Laminar API grpc port.
     * If not specified, defaults to 8443.
     * @param instrumentModules - List of modules to instrument.
     * If not specified, all auto-instrumentable modules will be instrumented, which include
     * LLM calls (OpenAI, Anthropic, etc), Langchain, VectorDB calls (Pinecone, Qdrant, etc).
     * Pass an empty object {} to disable any kind of automatic instrumentation.
     * If you only want to auto-instrument specific modules, then pass them in the object.
     * 
     * @example
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
     *
     * @throws {Error} - If project API key is not set
     */
    public static initialize({
        projectApiKey,
        env,
        baseUrl,
        httpPort,
        grpcPort,
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
        if (baseUrl?.match(/:\d{1,5}$/g)) {
            throw new Error(
                'Port should be passed separately in `httpPort` and `grpcPort`'
            );
        }

        this.baseHttpUrl = `${baseUrl ?? 'https://api.lmnr.ai'}:${httpPort ?? 443}`;
        this.baseGrpcUrl = `${baseUrl ?? 'https://api.lmnr.ai'}:${grpcPort ?? 8443}`;

        this.isInitialized = true;
        this.env = env ?? {};

        const metadata = new Metadata();
        metadata.set('authorization', `Bearer ${this.projectApiKey}`);
        const exporter = new OTLPTraceExporter({
            url: this.baseGrpcUrl,
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
     * @param env - The environment variables to override. If not provided, the
     * current environment will not be modified.
     */
    public static setEnv(env?: Record<string, string>) {
        if (env) {
            this.env = env;
        }
    }

    /**
     * Sets the project API key for authentication with Laminar.
     *
     * @param projectApiKey - The API key to be set. If not provided, the existing
     * API key will not be modified.
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
     * @param env - The environment variables for the pipeline execution.
     * Typically used for model provider keys.
     * @param metadata - Additional metadata for the pipeline run.
     * @param currentSpanId - The ID of the current span.
     * @param currentTraceId - The ID of the current trace.
     * @returns A promise that resolves to the response of the pipeline run.
     * @throws An error if the Laminar object is not initialized with a project API
     * key or if the request fails.
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

        const response = await fetch(`${this.baseHttpUrl}/v1/pipeline/run`, {
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
     * @param value - The value of the event. Must be a primitive type. If not
     * specified, boolean true is assumed in the backend.
     * @param timestamp - The timestamp of the event. If not specified, relies on
     * the underlying OpenTelemetry implementation.
     * If specified as an integer, it must be epoch nanoseconds.
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
     * Sets the session information for the current span and returns the
     * context to use for the following spans.
     * 
     * @param sessionId - The session ID to associate with the span.
     * @param userId - The user ID to associate with the span.
     * @returns The updated context with the association properties.
     * 
     * @example
     * import { context as contextApi } from '@opentelemetry/api';
     * import { Laminar } from '@lmnr-ai/laminar';
     * const context = Laminar.contextWithSession({ sessionId: "1234", userId: "5678" });
     * contextApi.with(context, () => {
     *    // Your code here
     * });
     */
    public static contextWithSession({
        sessionId,
        userId
    }: { sessionId?: string, userId?: string }) {
        const currentSpan = trace.getActiveSpan();
        if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
            if (sessionId) {
                currentSpan.setAttribute(SESSION_ID, sessionId);
            }
            if (userId) {
                currentSpan.setAttribute(USER_ID, userId);
            }
        }
        let associationProperties = {};
        if (sessionId) {
            associationProperties = { ...associationProperties, "session_id": sessionId };
        }
        if (userId) {
            associationProperties = { ...associationProperties, "user_id": userId };
        }

        let entityContext = context.active();
        const currentAssociationProperties = entityContext.getValue(ASSOCIATION_PROPERTIES_KEY);
        if (associationProperties) {
            entityContext = entityContext.setValue(
                ASSOCIATION_PROPERTIES_KEY,
                { ...(currentAssociationProperties ?? {}), ...associationProperties },
            );
        }

        return entityContext;
    }

    /**
     * Set attributes for the current span. Useful for manual
     * instrumentation.
     * @param attributes - The attributes to set for the current span.
     * 
     * @example
     * import { Laminar as L, observe } from '@lmnr-ai/laminar';
     * await observe({ name: 'mySpanName', spanType: 'LLM' }, async (msg: string) => {
     *   const response = await myCustomCallToOpenAI(msg);
     *   L.setSpanAttributes({
     *     [LaminarAttributes.PROVIDER]: 'openai',
     *     [LaminarAttributes.REQUEST_MODEL]: "requested_model",
     *     [LaminarAttributes.RESPONSE_MODEL]: response.model,
     *     [LaminarAttributes.INPUT_TOKEN_COUNT]: response.usage.prompt_tokens,
     *     [LaminarAttributes.OUTPUT_TOKEN_COUNT]: response.usage.completion_tokens,
     *   })
     * }, userMessage);
     */
    public static setSpanAttributes(
        attributes: Record<typeof LaminarAttributes[keyof typeof LaminarAttributes], AttributeValue>
    ) {
        const currentSpan = trace.getActiveSpan();
        if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
            for (const [key, value] of Object.entries(attributes)) {
                currentSpan.setAttribute(key, value);
            }
        }
    }

    public static async shutdown() {
        await forceFlush();
    }

    public static async createEvaluation<D, T, O>({
        groupId,
        name,
        data
    }: {
        groupId?: string,
        name?: string,
        data: EvaluationDatapoint<D, T, O>[]
    }): Promise<CreateEvaluationResponse> {
        const response = await fetch(`${this.baseHttpUrl}/v1/evaluations`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                groupId: groupId ?? null,
                name: name ?? null,
                points: data,
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to create evaluation ${name}. Response: ${response.statusText}`);
        }

        return await response.json() as CreateEvaluationResponse;
    }

    public static async getDatapoints<D, T>({
        datasetName,
        offset,
        limit,
    }: {
        datasetName: string,
        offset: number,
        limit: number,
    }): Promise<GetDatapointsResponse<D, T>> {
        const params = new URLSearchParams({
            name: datasetName,
            offset: offset.toString(),
            limit: limit.toString()
        });
        const response = await fetch(`${this.baseHttpUrl}/v1/datasets/datapoints?${params.toString()}`, {
            method: 'GET',
            headers: this.getHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Failed to get datapoints for dataset ${datasetName}. Response: ${response.statusText}`);
        }

        return await response.json() as GetDatapointsResponse<D, T>;
    }

    private static getHeaders() {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.projectApiKey}`,
        };
    };
}
