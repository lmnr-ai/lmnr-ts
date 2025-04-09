/**
 * Agent resource for interacting with Laminar agents.
 */

import { trace } from "@opentelemetry/api";
import pino from "pino";
import pinoPretty from "pino-pretty";

import { otelSpanIdToUUID, otelTraceIdToUUID, StringUUID } from "../../utils";
import { BaseResource } from "./index";


const logger = pino(pinoPretty({
  colorize: true,
  minimumLevel: "info",
}));

/**
 * Model provider options
 */
export type ModelProvider = string;

export type ActionResult = {
  isDone: boolean;
  content?: string | null;
  error?: string | null;
};

/**
 * Agent output type
 *
 * @property {string} state - The state of the agent. May be relatively large.
 * @property {ActionResult} result - The result of the agent run.
 */
export type AgentOutput = {
  result?: ActionResult;
};

/**
 * Request for running an agent
 */
export type RunAgentRequest = {
  prompt: string;
  parentSpanContext?: string;
  modelProvider?: ModelProvider;
  model?: string;
  stream: boolean;
  enableThinking: boolean;
};

export type RunAgentStepChunk = {
  chunkType: "step";
  messageId: StringUUID;
  actionResult: ActionResult;
  summary: string;
};

export type RunAgentFinalChunk = {
  chunkType: "finalOutput";
  messageId: StringUUID;
  content: AgentOutput;
};

/**
 * Chunk type for streaming responses
 */
export type RunAgentResponseChunk = RunAgentStepChunk | RunAgentFinalChunk;

type RunAgentOptions = {
  prompt: string;
  parentSpanContext?: string;
  modelProvider?: ModelProvider;
  model?: string;
  stream?: boolean;
  enableThinking?: boolean;
};

/**
 * Resource for interacting with Laminar agents
 */
export class AgentResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }


  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { string } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { boolean } [options.enableThinking] - Whether to enable thinking. Defaults to true.
   * @returns { Promise<AgentOutput> } The agent output
   */
  public run(options: Omit<RunAgentOptions, 'stream'>): Promise<AgentOutput>;

  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { string } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { boolean } [options.enableThinking] - Whether to enable thinking. Defaults to true.
   * @returns { Promise<AgentOutput> } The agent output
   */
  public run(options: Omit<RunAgentOptions, 'stream'> & { stream?: false }): Promise<AgentOutput>;

  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { string } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { boolean } [options.enableThinking] - Whether to enable thinking. Defaults to true.
   * @returns { Promise<ReadableStream<RunAgentResponseChunk>> } The agent output streamed
   */
  public run(options: Omit<RunAgentOptions, 'stream'> & { stream: true }):
    Promise<ReadableStream<RunAgentResponseChunk>>;

  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { string } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { boolean } [options.stream] - Whether to stream the response. Defaults to false.
   * @param { boolean } [options.enableThinking] - Whether to enable thinking. Defaults to true.
   * @returns { Promise<AgentOutput | ReadableStream<RunAgentResponseChunk>> }
   *    The agent output or a stream of response chunks
   */
  public async run({
    prompt,
    parentSpanContext,
    modelProvider,
    model,
    stream,
    enableThinking,
  }: RunAgentOptions): Promise<AgentOutput | ReadableStream<RunAgentResponseChunk>> {
    // Handle parent span context from current context if not provided
    let requestParentSpanContext = parentSpanContext;

    if (!requestParentSpanContext) {
      const currentSpan = trace.getActiveSpan();
      if (currentSpan && currentSpan.isRecording()) {
        const traceId = otelTraceIdToUUID(currentSpan.spanContext().traceId) as StringUUID;
        const spanId = otelSpanIdToUUID(currentSpan.spanContext().spanId) as StringUUID;
        requestParentSpanContext = JSON.stringify({
          trace_id: traceId,
          span_id: spanId,
          is_remote: currentSpan.spanContext().isRemote,
        });
      }
    }

    const request: RunAgentRequest = {
      prompt,
      parentSpanContext: requestParentSpanContext,
      modelProvider,
      model,
      stream: true,
      enableThinking: enableThinking ?? true,
    };

    // For streaming case, return the ReadableStream directly
    if (stream) {
      return this.runStreaming(request);
    } else {
      // For non-streaming case, process all chunks and return the final result
      return await this.runNonStreaming(request);
    }
  }

  /**
   * Run agent in streaming mode
   */
  private async runStreaming(
    request: RunAgentRequest,
  ): Promise<ReadableStream<RunAgentResponseChunk>> {
    const response = await fetch(this.baseHttpUrl + "/v1/agent/run", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
    if (!response.body) {
      throw new Error("Response body is null");
    }

    return response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        start(this: { buffer: string }) {
          this.buffer = "";
        },
        transform(this: { buffer: string }, chunk, controller) {
          this.buffer += chunk;

          // Split buffer into lines
          const lines = this.buffer.split("\n");
          // Keep the last (potentially incomplete) line in the buffer
          this.buffer = lines.pop() || "";

          // Process complete lines
          for (const line of lines) {
            if (line.startsWith("[DONE]")) {
              controller.terminate();
              return;
            }
            if (!line.startsWith("data: ")) {
              continue;
            }
            const jsonStr = line.substring(6);
            if (jsonStr) {
              try {
                const parsed = JSON.parse(jsonStr) as RunAgentResponseChunk;
                controller.enqueue(parsed);
              } catch (error) {
                logger.error("Error parsing JSON: " +
                  `${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        },
        flush(this: { buffer: string }, controller) {
          // Process any remaining data in the buffer
          if (this.buffer) {
            if (this.buffer.startsWith("data: ")) {
              const jsonStr = this.buffer.substring(6);
              if (jsonStr) {
                try {
                  const parsed = JSON.parse(jsonStr) as RunAgentResponseChunk;
                  controller.enqueue(parsed);
                } catch (error) {
                  logger.error("Error parsing JSON: " +
                    `${error instanceof Error ? error.message : String(error)}`);
                }
              }
            }
          }
        },
      }));
  }

  /**
   * Run agent in non-streaming mode
   */
  private async runNonStreaming(request: RunAgentRequest): Promise<AgentOutput> {
    const stream = await this.runStreaming(request);
    const reader = stream.getReader();
    let finalChunk: RunAgentResponseChunk | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.chunkType === "finalOutput") {
          finalChunk = value;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return finalChunk?.content || {};
  }
}
