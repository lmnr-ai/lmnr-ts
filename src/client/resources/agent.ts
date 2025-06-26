/**
 * Agent resource for interacting with Laminar agents.
 */

import { trace } from "@opentelemetry/api";

import { initializeLogger, otelSpanIdToUUID, otelTraceIdToUUID, StringUUID } from "../../utils";
import { BaseResource } from "./index";

const logger = initializeLogger();

/**
 * Model provider options
 */
export type ModelProvider = 'anthropic' | 'bedrock' | 'openai' | 'gemini';

export type ActionResult = {
  isDone: boolean;
  content?: string | null;
  error?: string | null;
};

/**
 * Agent output type
 *
 * @property {string} agentState - The state of the agent. Can be used in subsequent runs
 * to resume the agent. Only set if returnAgentState is true. Is a very large
 * stringified JSON object.
 * @property {string} storageState - The storage state of the browser, including auth, cookies, etc.
 * Only set if returnStorageState is true. Is a relatively large stringified JSON object.
 * @property {ActionResult} result - The result of the agent run.
 */
export type AgentOutput = {
  result: ActionResult;
  agentState?: string | null;
  storageState?: string | null;
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
  agentState?: string | null;
  storageState?: string | null;
  enableThinking: boolean;
  timeout?: number;
  cdpUrl?: string;
  maxSteps?: number;
  thinkingTokenBudget?: number;
  startUrl?: string;
  userAgent?: string;
  returnScreenshots?: boolean;
  returnAgentState?: boolean;
  returnStorageState?: boolean;
  disableGiveControl?: boolean;
};

export type RunAgentStepChunk = {
  chunkType: "step";
  messageId: StringUUID;
  actionResult: ActionResult;
  summary: string;
  screenshot?: string | null;
};

// This chunk indicates that the explicit timeout has been reached.
// This is the last chunk in the stream. The only difference between this and a normal step chunk is
// the chunkType.
export type RunAgentTimeoutChunk = {
  chunkType: "timeout";
  messageId: StringUUID;
  actionResult: ActionResult;
  summary: string;
  screenshot?: string | null;
};

export type RunAgentFinalChunk = {
  chunkType: "finalOutput";
  messageId: StringUUID;
  content: AgentOutput;
};

export type RunAgentErrorChunk = {
  chunkType: "error";
  messageId: StringUUID;
  error: string;
};

/**
 * Chunk type for streaming responses
 */
export type RunAgentResponseChunk = RunAgentStepChunk
  | RunAgentFinalChunk | RunAgentErrorChunk | RunAgentTimeoutChunk;

type RunAgentOptions = {
  prompt: string;
  parentSpanContext?: string;
  modelProvider?: ModelProvider;
  agentState?: string;
  storageState?: string;
  model?: string;
  stream?: boolean;
  enableThinking?: boolean;
  timeout?: number;
  cdpUrl?: string;
  maxSteps?: number;
  thinkingTokenBudget?: number;
  startUrl?: string;
  userAgent?: string;
  returnScreenshots?: boolean;
  returnAgentState?: boolean;
  returnStorageState?: boolean;
  disableGiveControl?: boolean;
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
   * @param { ModelProvider } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { string } [options.agentState] - The agent state to resume the agent from as returned
   * by a previous run.
   * @param { string } [options.storageState] - The browser storage state as returned by a
   * previous run.
   * @param { boolean } [options.enableThinking] - Whether to enable thinking in the underlying
   * LLM. Defaults to true.
   * @param { number } [options.timeout] - The timeout in seconds for the agent. Note: This is a
   * soft timeout. The agent will finish a step even after the timeout has been reached.
   * @param { string } [options.cdpUrl] - The URL of an existing Chrome DevTools Protocol (CDP)
   * browser instance.
   * @param { number } [options.maxSteps] - The maximum number of steps the agent can take.
   * Defaults to 100.
   * @param { number } [options.thinkingTokenBudget] - The maximum number of tokens the underlying
   * LLM can spend on thinking per step, if supported by the LLM provider.
   * @param { string } [options.startUrl] - The URL to start the agent on. Make sure it's a
   * valid URL - refer to https://playwright.dev/docs/api/class-page#page-goto
   * If not specified, the agent will infer this from the prompt.
   * @param { string } [options.userAgent] - The user agent to set in the browser.
   * If not specified, Laminar will use the default user agent.
   * @param { boolean } [options.returnScreenshots] - IGNORED in non-streaming mode.
   * Defaults to false. Set stream to true for doc comments.
   * @param { boolean } [options.returnAgentState] - Whether to return the agent state.
   * Agent state can be used to resume the agent in subsequent runs.
   * CAUTION: Agent state is a very large object. Defaults to false.
   * @param { boolean } [options.returnStorageState] - Whether to return the storage state.
   * Storage state includes browser cookies, auth, etc.
   * CAUTION: Storage state is a relatively large object. Defaults to false.
   * @param { boolean } [options.disableGiveControl] - Whether to NOT direct the agent
   * to give control back to the user for tasks such as logging in. Defaults to false.
   * @returns { Promise<AgentOutput> } The agent output
   */
  public run(options: Omit<RunAgentOptions, 'stream'>): Promise<AgentOutput>;

  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { ModelProvider } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { string } [options.agentState] - The agent state to resume the agent from as
   * returned by a previous run.
   * @param { string } [options.storageState] - The browser storage state as returned by a
   * previous run.
   * @param { boolean } [options.enableThinking] - Whether to enable thinking in the
   * underlying LLM. Defaults to true.
   * @param { number } [options.timeout] - The timeout in seconds for the agent.
   * Note: This is a soft timeout. The agent will finish a step even after the timeout has
   * been reached.
   * @param { string } [options.cdpUrl] - The URL of an existing Chrome DevTools Protocol
   * (CDP) browser instance.
   * @param { number } [options.maxSteps] - The maximum number of steps the agent can take.
   * Defaults to 100.
   * @param { number } [options.thinkingTokenBudget] - The maximum number of tokens the
   * underlying LLM can spend on thinking per step, if supported by the LLM provider.
   * @param { string } [options.startUrl] - The URL to start the agent on. Make sure it's
   * a valid URL - refer to https://playwright.dev/docs/api/class-page#page-goto
   * If not specified, the agent will infer this from the prompt.
   * @param { string } [options.userAgent] - The user agent to set in the browser.
   * If not specified, Laminar will use the default user agent.
   * @param { boolean } [options.returnScreenshots] - IGNORED in non-streaming mode.
   * Defaults to false. Set stream to true for doc comments.
   * @param { boolean } [options.returnAgentState] - Whether to return the agent state.
   * Agent state can be used to resume the agent in subsequent runs.
   * CAUTION: Agent state is a very large object. Defaults to false.
   * @param { boolean } [options.returnStorageState] - Whether to return the storage state.
   * Storage state includes browser cookies, auth, etc.
   * CAUTION: Storage state is a relatively large object. Defaults to false.
   * @param { boolean } [options.disableGiveControl] - Whether to NOT direct the agent
   * to give control back to the user for tasks such as logging in. Defaults to false.
   * @returns { Promise<AgentOutput> } The agent output
   */
  public run(options: Omit<RunAgentOptions, 'stream'> & { stream?: false }): Promise<AgentOutput>;

  /**
   * Run Laminar index agent
   *
   * @param { RunAgentOptions } options - The options for running the agent
   * @param { string } options.prompt - The prompt for the agent
   * @param { string } [options.parentSpanContext] - The parent span context for tracing
   * @param { ModelProvider } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { string } [options.agentState] - The agent state to resume the agent from as
   * returned by a previous run.
   * @param { string } [options.storageState] - The browser storage state as returned by
   * a previous run.
   * @param { boolean } [options.enableThinking] - Whether to enable thinking in the
   * underlying LLM. Defaults to true.
   * @param { number } [options.timeout] - The timeout in seconds for the agent. Note:
   * This is a soft timeout. The agent will finish a step even after the timeout has
   * been reached.
   * @param { string } [options.cdpUrl] - The URL of an existing Chrome DevTools Protocol
   * (CDP) browser instance.
   * @param { number } [options.maxSteps] - The maximum number of steps the agent can take.
   * Defaults to 100.
   * @param { number } [options.thinkingTokenBudget] - The maximum number of tokens the
   * underlying LLM can spend on thinking per step, if supported by the LLM provider.
   * @param { string } [options.startUrl] - The URL to start the agent on. Make sure it's
   * a valid URL - refer to https://playwright.dev/docs/api/class-page#page-goto
   * If not specified, the agent will infer this from the prompt.
   * @param { string } [options.userAgent] - The user agent to set in the browser.
   * If not specified, Laminar will use the default user agent.
   * @param { boolean } [options.returnScreenshots] - Whether to return screenshots with
   * each step. Defaults to false. Set stream to true for doc comments.
   * @param { boolean } [options.returnAgentState] - Whether to return the agent state.
   * Agent state can be used to resume the agent in subsequent runs.
   * CAUTION: Agent state is a very large object. Defaults to false.
   * @param { boolean } [options.returnStorageState] - Whether to return the storage state.
   * Storage state includes browser cookies, auth, etc.
   * CAUTION: Storage state is a relatively large object. Defaults to false.
   * @param { boolean } [options.disableGiveControl] - Whether to NOT direct the agent
   * to give control back to the user for tasks such as logging in. Defaults to false.
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
   * @param { ModelProvider } [options.modelProvider] - LLM provider to use
   * @param { string } [options.model] - The model name as specified in the provider API
   * @param { boolean } [options.stream] - Whether to stream the response. Defaults to false.
   * @param { boolean } [options.enableThinking] - Whether to enable thinking in the underlying
   * LLM. Defaults to true.
   * @param { number } [options.timeout] - The timeout in seconds for the agent.
   * Note: This is a soft timeout. The agent will finish a step even after the timeout has
   * been reached.
   * @param { string } [options.cdpUrl] - The URL of an existing Chrome DevTools Protocol
   * (CDP) browser instance.
   * @param { number } [options.maxSteps] - The maximum number of steps the agent can take.
   * Defaults to 100.
   * @param { number } [options.thinkingTokenBudget] - The maximum number of tokens the underlying
   * LLM can spend on thinking per step, if supported by the LLM provider.
   * @param { string } [options.startUrl] - The URL to start the agent on.
   * Make sure it's a valid URL - refer to https://playwright.dev/docs/api/class-page#page-goto
   * If not specified, the agent will infer this from the prompt.
   * @param { string } [options.userAgent] - The user agent to set in the browser.
   * If not specified, Laminar will use the default user agent.
   * @param { boolean } [options.returnScreenshots] - Whether to return screenshots with
   * each step. Defaults to false.
   * @param { boolean } [options.returnAgentState] - Whether to return the agent state.
   * Agent state can be used to resume the agent in subsequent runs.
   * CAUTION: Agent state is a very large object. Defaults to false.
   * @param { boolean } [options.returnStorageState] - Whether to return the storage state.
   * Storage state includes browser cookies, auth, etc.
   * CAUTION: Storage state is a relatively large object. Defaults to false.
   * @param { boolean } [options.disableGiveControl] - Whether to NOT direct the agent
   * to give control back to the user for tasks such as logging in. Defaults to false.
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
    timeout,
    cdpUrl,
    agentState,
    storageState,
    maxSteps,
    thinkingTokenBudget,
    startUrl,
    userAgent,
    returnScreenshots,
    returnAgentState,
    returnStorageState,
    disableGiveControl,
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
      timeout,
      cdpUrl,
      agentState,
      storageState,
      maxSteps,
      thinkingTokenBudget,
      startUrl,
      userAgent,
      returnScreenshots: returnScreenshots ?? false,
      returnAgentState: returnAgentState ?? false,
      returnStorageState: returnStorageState ?? false,
      disableGiveControl: disableGiveControl ?? false,
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
    let errorChunk: RunAgentErrorChunk | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.chunkType === "finalOutput") {
          finalChunk = value;
          break;
        } else if (value.chunkType === "error") {
          errorChunk = value;
          break;
        } else if (value.chunkType === "timeout") {
          errorChunk = {
            chunkType: "error",
            messageId: value.messageId,
            error: "Timeout",
          };
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (errorChunk) {
      throw new Error(errorChunk.error);
    }

    return finalChunk?.content || { result: { isDone: true } };
  }
}
