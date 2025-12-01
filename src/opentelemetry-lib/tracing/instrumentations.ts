import { Instrumentation } from "@opentelemetry/instrumentation";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { AzureOpenAIInstrumentation } from "@traceloop/instrumentation-azure";
import { BedrockInstrumentation } from "@traceloop/instrumentation-bedrock";
import { ChromaDBInstrumentation } from "@traceloop/instrumentation-chromadb";
import { CohereInstrumentation } from "@traceloop/instrumentation-cohere";
import { LangChainInstrumentation } from "@traceloop/instrumentation-langchain";
import { LlamaIndexInstrumentation } from "@traceloop/instrumentation-llamaindex";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { PineconeInstrumentation } from "@traceloop/instrumentation-pinecone";
import { QdrantInstrumentation } from "@traceloop/instrumentation-qdrant";
import { TogetherInstrumentation } from "@traceloop/instrumentation-together";
import {
  AIPlatformInstrumentation,
  VertexAIInstrumentation,
} from "@traceloop/instrumentation-vertexai";

import { PlaywrightInstrumentation } from "../../browser";
import { PuppeteerInstrumentation } from "../../browser/puppeteer";
import { StagehandV2Instrumentation } from "../../browser/stagehand/v2";
import { StagehandInstrumentation as StagehandV3Instrumentation } from "../../browser/stagehand/v3";
import { LaminarClient } from "../../client";
import { SessionRecordingOptions } from "../../types";
import { KernelInstrumentation } from "../instrumentation/kernel";
import { InitializeOptions } from "../interfaces";

/**
 * Initialize and return Laminar instrumentations.
 * Useful to use with libraries that initialize tracing and can register passed
 * instrumentations.
 *
 * @param options
 * @param {string} options.baseUrl - Base URL of the Laminar API.
 * @param {string} options.apiKey - Laminar project API key. If not provided, will use
 * the LMNR_PROJECT_API_KEY environment variable.
 * @param {number} options.httpPort - Laminar API http port. If not provided, will use
 * the port from the baseUrl or defaults to 443. Only required for Playwright/Puppeteer
 * instrumentations for sending browser sessions.
 * @param {boolean} options.suppressContentTracing - Whether to suppress content tracing.
 * @param {InitializeOptions["instrumentModules"]} options.instrumentModules - Record of modules
 * to instrument.
 * If not provided, all auto-instrumentable modules will be instrumented, which include
 * LLM calls (OpenAI, Anthropic, etc), Langchain, VectorDB calls (Pinecone, Qdrant, etc).
 * Pass an empty object {} to disable any kind of automatic instrumentation.
 * If you only want to auto-instrument specific modules, then pass them in the object.
 *
 * @returns {Instrumentation[]} Array of enabled instrumentations. It is your responsibility
 * to enable them and register them with the OpenTelemetry SDK. For example, you could use
 * registerInstrumentations from the opentelemetry-api to register them.
 */
export const initializeLaminarInstrumentations = (
  options: {
    baseUrl?: string,
    apiKey?: string,
    httpPort?: number,
    suppressContentTracing?: boolean,
    instrumentModules?: InitializeOptions["instrumentModules"],
    sessionRecordingOptions?: SessionRecordingOptions,
  } = {},
) => {
  const apiKey = options.apiKey ?? process.env.LMNR_PROJECT_API_KEY;

  // Only create client if we have an API key. That is, only send browser
  // session events to Laminar backend, but not other OTEL backends.
  let client: LaminarClient | undefined;
  if (apiKey) {
    const url = options.baseUrl ?? process?.env?.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const port = options.httpPort ?? (
      url.match(/:\d{1,5}$/g)
        ? parseInt(url.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const urlWithoutSlash = url.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    client = new LaminarClient({
      baseUrl: `${urlWithoutSlash}:${port}`,
      projectApiKey: apiKey,
    });
  }

  return options?.instrumentModules !== undefined
    ? manuallyInitInstrumentations(
      client,
      options.instrumentModules,
      options.suppressContentTracing,
      options.sessionRecordingOptions,
    )
    : initInstrumentations(
      client,
      options.suppressContentTracing,
      options.sessionRecordingOptions,
    );
};

/**
 * Get the appropriate Stagehand instrumentation based on the installed version.
 * Returns v3 instrumentation for stagehand >= 3.0.0, otherwise v2.
 */
const getStagehandInstrumentation = (
  playwrightInstrumentation: PlaywrightInstrumentation,
  client: LaminarClient,
  sessionRecordingOptions?: SessionRecordingOptions,
): StagehandV2Instrumentation | StagehandV3Instrumentation => {
  try {
    // Try to require the stagehand package to get its version
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stagehandPkg = require("@browserbasehq/stagehand/package.json");
    const version = stagehandPkg.version;
    const majorVersion = parseInt(version.split('.')[0], 10);

    if (majorVersion >= 3) {
      const stagehandInstrumentation = new StagehandV3Instrumentation(sessionRecordingOptions);
      stagehandInstrumentation.setClient(client);
      return stagehandInstrumentation;
    }
    else {
      return new StagehandV2Instrumentation(playwrightInstrumentation);
    }
  } catch {
    // If we can't find the package, default to v3
  }

  const stagehandInstrumentation = new StagehandV3Instrumentation(sessionRecordingOptions);
  stagehandInstrumentation.setClient(client);
  return stagehandInstrumentation;
};

const initInstrumentations = (
  client: LaminarClient | undefined,
  suppressContentTracing?: boolean,
  sessionRecordingOptions?: SessionRecordingOptions,
): Instrumentation[] => {
  const enrichTokens = false;
  const instrumentations: Instrumentation[] = [];

  instrumentations.push(new OpenAIInstrumentation({
    enrichTokens,
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new AnthropicInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new AzureOpenAIInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new CohereInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new VertexAIInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new AIPlatformInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new BedrockInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new PineconeInstrumentation());

  instrumentations.push(new LangChainInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new LlamaIndexInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new TogetherInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new ChromaDBInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  instrumentations.push(new QdrantInstrumentation({
    traceContent: !suppressContentTracing,
  }));

  // Browser instrumentations require a client (API key)
  if (client) {
    const playwrightInstrumentation = new PlaywrightInstrumentation(
      client,
      sessionRecordingOptions,
    );
    instrumentations.push(playwrightInstrumentation);

    instrumentations.push(getStagehandInstrumentation(
      playwrightInstrumentation,
      client,
      sessionRecordingOptions,
    ));

    instrumentations.push(new PuppeteerInstrumentation(client, sessionRecordingOptions));
  }

  instrumentations.push(new KernelInstrumentation());

  return instrumentations;
};

const manuallyInitInstrumentations = (
  client: LaminarClient | undefined,
  instrumentModules: InitializeOptions["instrumentModules"],
  suppressContentTracing?: boolean,
  sessionRecordingOptions?: SessionRecordingOptions,
): Instrumentation[] => {
  const enrichTokens = false;
  const instrumentations: Instrumentation[] = [];
  let playwrightInstrumentation: PlaywrightInstrumentation | undefined;

  if (instrumentModules?.OpenAI && instrumentModules?.openAI) {
    throw new Error(
      "`openAI` is deprecated, but both `OpenAI` and `openAI` are provided. " +
      "Please use `OpenAI` only.",
    );
  }

  if (instrumentModules?.openAI) {
    const openAIInstrumentation = new OpenAIInstrumentation({
      enrichTokens,
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(openAIInstrumentation);
    openAIInstrumentation.manuallyInstrument(instrumentModules.openAI);
  }

  if (instrumentModules?.OpenAI) {
    const openAIInstrumentation = new OpenAIInstrumentation({
      enrichTokens,
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(openAIInstrumentation);
    openAIInstrumentation.manuallyInstrument(instrumentModules.OpenAI);
  }

  if (instrumentModules?.anthropic) {
    const anthropicInstrumentation = new AnthropicInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(anthropicInstrumentation);
    anthropicInstrumentation.manuallyInstrument(instrumentModules.anthropic as any);
  }

  if (instrumentModules?.azureOpenAI) {
    const azureOpenAIInstrumentation = new AzureOpenAIInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(azureOpenAIInstrumentation as Instrumentation);
    azureOpenAIInstrumentation.manuallyInstrument(instrumentModules.azureOpenAI);
  }

  if (instrumentModules?.cohere) {
    const cohereInstrumentation = new CohereInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(cohereInstrumentation);
    cohereInstrumentation.manuallyInstrument(instrumentModules.cohere);
  }

  if (instrumentModules?.google_vertexai) {
    const vertexaiInstrumentation = new VertexAIInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(vertexaiInstrumentation);
    vertexaiInstrumentation.manuallyInstrument(
      instrumentModules.google_vertexai,
    );
  }

  if (instrumentModules?.google_aiplatform) {
    const aiplatformInstrumentation = new AIPlatformInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(aiplatformInstrumentation);
    aiplatformInstrumentation.manuallyInstrument(
      instrumentModules.google_aiplatform,
    );
  }

  if (instrumentModules?.bedrock) {
    const bedrockInstrumentation = new BedrockInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(bedrockInstrumentation);
    bedrockInstrumentation.manuallyInstrument(instrumentModules.bedrock);
  }

  if (instrumentModules?.pinecone) {
    const instrumentation = new PineconeInstrumentation();
    instrumentations.push(instrumentation as Instrumentation);
    instrumentation.manuallyInstrument(instrumentModules.pinecone);
  }

  if (instrumentModules?.langchain) {
    const langchainInstrumentation = new LangChainInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(langchainInstrumentation);
    langchainInstrumentation.manuallyInstrument(instrumentModules.langchain);
  }

  if (instrumentModules?.llamaIndex) {
    const llamaIndexInstrumentation = new LlamaIndexInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(llamaIndexInstrumentation);
    llamaIndexInstrumentation.manuallyInstrument(instrumentModules.llamaIndex);
  }

  if (instrumentModules?.chromadb) {
    const chromadbInstrumentation = new ChromaDBInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(chromadbInstrumentation);
    chromadbInstrumentation.manuallyInstrument(instrumentModules.chromadb);
  }

  if (instrumentModules?.qdrant) {
    const qdrantInstrumentation = new QdrantInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(qdrantInstrumentation);
    qdrantInstrumentation.manuallyInstrument(instrumentModules.qdrant);
  }

  if (instrumentModules?.together) {
    const togetherInstrumentation = new TogetherInstrumentation({
      traceContent: !suppressContentTracing,
    });
    instrumentations.push(togetherInstrumentation);
    togetherInstrumentation.manuallyInstrument(instrumentModules.together as any);
  }

  if (instrumentModules?.playwright && client) {
    playwrightInstrumentation = new PlaywrightInstrumentation(client, sessionRecordingOptions);
    instrumentations.push(playwrightInstrumentation);
    playwrightInstrumentation.manuallyInstrument(instrumentModules.playwright);
  }

  if (instrumentModules?.puppeteer && client) {
    const puppeteerInstrumentation = new PuppeteerInstrumentation(client, sessionRecordingOptions);
    instrumentations.push(puppeteerInstrumentation);
    puppeteerInstrumentation.manuallyInstrument(instrumentModules.puppeteer);
  }

  if (instrumentModules?.stagehand && client) {
    if (!playwrightInstrumentation) {
      playwrightInstrumentation = new PlaywrightInstrumentation(client, sessionRecordingOptions);
      instrumentations.push(playwrightInstrumentation);
    }
    const stagehandInstrumentation = getStagehandInstrumentation(
      playwrightInstrumentation,
      client,
      sessionRecordingOptions,
    );
    instrumentations.push(stagehandInstrumentation);
    stagehandInstrumentation.manuallyInstrument(instrumentModules.stagehand);
  }

  if (instrumentModules?.kernel) {
    const kernelInstrumentation = new KernelInstrumentation();
    instrumentations.push(kernelInstrumentation);
    kernelInstrumentation.manuallyInstrument(instrumentModules.kernel);
  }

  return instrumentations;
};
