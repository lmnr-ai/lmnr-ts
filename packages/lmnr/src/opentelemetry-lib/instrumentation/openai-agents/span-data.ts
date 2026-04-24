import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { LaminarAttributes } from "../../tracing/attributes";
import {
  getCurrentSystemInstructions,
  nameFromSpanData,
  spanKind,
} from "./helpers";
import {
  applyLlmAttributes,
  responseToLlmData,
  setGenAiInputMessages,
  setGenAiOutputMessages,
  setGenAiOutputMessagesFromResponse,
  setLmnrSpanIo,
  setToolDefinitionsFromResponse,
} from "./messages";

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export const applySpanError = (lmnrSpan: Span, span: any): void => {
  const error = span?.error;
  if (!error) {
    return;
  }
  try {
    const message = error.message ?? String(error);
    lmnrSpan.setStatus({ code: SpanStatusCode.ERROR, message });
  } catch {
    // ignore
  }
};

// ---------------------------------------------------------------------------
// Span data extraction
// ---------------------------------------------------------------------------

export const applySpanData = (lmnrSpan: Span, spanData: any): void => {
  if (spanData == null) {
    return;
  }

  const kind = spanKind(spanData);

  if (kind === "agent") {
    applyAgentSpanData(lmnrSpan, spanData);
  } else if (kind === "function" || kind === "tool") {
    applyFunctionSpanData(lmnrSpan, spanData);
  } else if (kind === "generation") {
    applyGenerationSpanData(lmnrSpan, spanData);
  } else if (kind === "response") {
    applyResponseSpanData(lmnrSpan, spanData);
  } else if (kind === "handoff") {
    applyHandoffSpanData(lmnrSpan, spanData);
  } else if (kind === "guardrail") {
    applyGuardrailSpanData(lmnrSpan, spanData);
  } else if (kind === "custom") {
    applyCustomSpanData(lmnrSpan, spanData);
  } else if (kind === "mcp_list_tools" || kind === "mcp_tools") {
    applyMcpSpanData(lmnrSpan, spanData);
  } else if (kind === "speech") {
    applySpeechSpanData(lmnrSpan, spanData);
  } else if (kind === "transcription") {
    applyTranscriptionSpanData(lmnrSpan, spanData);
  } else if (kind === "speech_group") {
    applySpeechGroupSpanData(lmnrSpan, spanData);
  } else {
    // Fallback: set generic I/O
    setLmnrSpanIo(lmnrSpan, spanData?.input, spanData?.output);
  }
};

const applyAgentSpanData = (lmnrSpan: Span, spanData: any): void => {
  const res: Record<string, any> = {};
  const name = spanData?.name;
  if (name) {
    res.name = name;
  }
  const handoffs = spanData?.handoffs;
  if (handoffs) {
    res.handoffs = handoffs;
  }
  const tools = spanData?.tools;
  if (tools) {
    res.tools = tools;
  }
  const outputType = spanData?.output_type;
  if (outputType) {
    res.output_type = outputType;
  }
  setLmnrSpanIo(lmnrSpan, res, null);
};

const applyFunctionSpanData = (lmnrSpan: Span, spanData: any): void => {
  setLmnrSpanIo(lmnrSpan, spanData?.input, spanData?.output);
};

const applyGenerationSpanData = (lmnrSpan: Span, spanData: any): void => {
  const inputData = spanData?.input;
  setGenAiInputMessages(lmnrSpan, inputData, getCurrentSystemInstructions());

  const outputData = spanData?.output;
  setGenAiOutputMessages(lmnrSpan, outputData);

  const llmData: Record<string, any> = {
    model: spanData?.model,
    usage: spanData?.usage,
    response_id: spanData?.response_id ?? spanData?.id,
  };
  applyLlmAttributes(lmnrSpan, llmData);
};

const applyResponseSpanData = (lmnrSpan: Span, spanData: any): void => {
  // TS SDK stores the raw response under `_response` and raw input under `_input`
  // for non-OpenAI exporters (the OpenAI exporter strips them via
  // removePrivateFields). See
  // @openai/agents-core/dist/tracing/spans.d.ts::ResponseSpanData.
  const response = spanData?._response ?? spanData?.response;
  const responseInput = spanData?._input ?? spanData?.input;

  setGenAiInputMessages(lmnrSpan, responseInput, getCurrentSystemInstructions());

  if (response != null) {
    setGenAiOutputMessagesFromResponse(lmnrSpan, response);
    setToolDefinitionsFromResponse(lmnrSpan, response);
    applyLlmAttributes(lmnrSpan, responseToLlmData(response));
  } else if (spanData?.response_id) {
    // If we only have the response_id (OpenAI path strips the response body),
    // still surface it so callers can correlate.
    lmnrSpan.setAttribute("gen_ai.response.id", spanData.response_id);
  }
};

const applyHandoffSpanData = (lmnrSpan: Span, spanData: any): void => {
  const fromAgent = spanData?.from_agent;
  const toAgent = spanData?.to_agent;
  if (fromAgent) {
    lmnrSpan.setAttribute("openai.agents.handoff.from", nameFromSpanData(fromAgent));
  }
  if (toAgent) {
    lmnrSpan.setAttribute("openai.agents.handoff.to", nameFromSpanData(toAgent));
  }
};

const applyGuardrailSpanData = (lmnrSpan: Span, spanData: any): void => {
  const name = spanData?.name;
  if (name) {
    lmnrSpan.setAttribute("openai.agents.guardrail.name", name);
  }
  const triggered = spanData?.triggered;
  if (triggered !== undefined && triggered !== null) {
    lmnrSpan.setAttribute("openai.agents.guardrail.triggered", Boolean(triggered));
  }
};

const applyCustomSpanData = (lmnrSpan: Span, spanData: any): void => {
  const name = spanData?.name;
  if (name) {
    lmnrSpan.setAttribute("openai.agents.custom.name", name);
  }
  const customData = spanData?.data;
  if (customData !== undefined && customData !== null) {
    lmnrSpan.setAttribute("openai.agents.custom.data", JSON.stringify(customData));
  }
};

const applyMcpSpanData = (lmnrSpan: Span, spanData: any): void => {
  const server = spanData?.server;
  if (server) {
    lmnrSpan.setAttribute("openai.agents.mcp.server", server);
  }
  const result = spanData?.result;
  if (result !== undefined && result !== null) {
    lmnrSpan.setAttribute("openai.agents.mcp.result", JSON.stringify(result));
  }
};

const applySpeechSpanData = (lmnrSpan: Span, spanData: any): void => {
  const model = spanData?.model;
  if (model) {
    lmnrSpan.setAttribute(LaminarAttributes.REQUEST_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.RESPONSE_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.PROVIDER, "openai");
  }

  const inputText = spanData?.input;
  if (inputText) {
    setGenAiInputMessages(lmnrSpan, inputText);
  }

  const outputData = spanData?.output;
  if (outputData) {
    if (typeof outputData === "object" && !Array.isArray(outputData)) {
      // Speech output is {data: ..., format: ...}
      setGenAiOutputMessages(lmnrSpan, outputData.data);
    } else {
      setGenAiOutputMessages(lmnrSpan, outputData);
    }
  }
};

const applyTranscriptionSpanData = (lmnrSpan: Span, spanData: any): void => {
  const model = spanData?.model;
  if (model) {
    lmnrSpan.setAttribute(LaminarAttributes.REQUEST_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.RESPONSE_MODEL, model);
    lmnrSpan.setAttribute(LaminarAttributes.PROVIDER, "openai");
  }

  const inputData = spanData?.input;
  if (inputData) {
    if (typeof inputData === "object" && !Array.isArray(inputData)) {
      setGenAiInputMessages(lmnrSpan, inputData.data);
    } else {
      setGenAiInputMessages(lmnrSpan, inputData);
    }
  }

  const outputText = spanData?.output;
  if (outputText) {
    setGenAiOutputMessages(lmnrSpan, outputText);
  }
};

const applySpeechGroupSpanData = (lmnrSpan: Span, spanData: any): void => {
  const inputText = spanData?.input;
  if (inputText) {
    setGenAiInputMessages(lmnrSpan, inputText);
  }

  const outputText = spanData?.output;
  if (outputText) {
    setGenAiOutputMessages(lmnrSpan, outputText);
  }
};
