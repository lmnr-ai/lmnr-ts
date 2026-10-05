import type { Context, Span } from "@opentelemetry/api";

// Laminar association properties resolved once per operation (from
// runtimeContext / toolsContext on top of the parent context) and stamped on
// the operation span and every child span the integration creates.
export interface AssociationProperties {
  userId?: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
}

export interface OperationState {
  span: Span;
  ctx: Context;
  operationId?: string;
  provider?: string;
  modelId?: string;
  associationProperties: AssociationProperties;
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
