import type { Context, Span } from "@opentelemetry/api";

export interface OperationState {
  span: Span;
  ctx: Context;
  operationId?: string;
  provider?: string;
  modelId?: string;
}

export interface StepState {
  span: Span;
  ctx: Context;
  stepNumber: number;
}

export interface LlmState {
  span: Span;
  textDeltas: string[];
}

export interface ToolState {
  span: Span;
  ctx: Context;
  callId: string;
}

export const stepKey = (callId: string, stepNumber: number): string =>
  `${callId}:${stepNumber}`;
