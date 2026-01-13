import { LaminarClient } from "@lmnr-ai/client";
import { type StringUUID } from "@lmnr-ai/types";
import { ChunkBuffer } from "../../utils";

/**
 * CDP Protocol types for Stagehand V3 Page
 */
export interface FrameTree {
  frame: {
    id: string;
    loaderId?: string;
    url?: string;
  };
  childFrames?: FrameTree[];
}

export interface RuntimeEvaluateResult {
  result?: {
    type: string;
    value?: unknown;
  };
  exceptionDetails?: {
    text: string;
  };
}

/**
 * Interface for Stagehand V3 Page that exposes sendCDP
 */
export interface StagehandV3Page {
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  url(): string;
  mainFrameId(): string;
  targetId(): string;
}

/**
 * Interface for Stagehand V3 Context
 */
export interface StagehandV3Context {
  conn: StagehandCdpConnection;
  pages(): StagehandV3Page[];
  activePage(): StagehandV3Page | undefined;
}

/**
 * Interface for CDP Connection from Stagehand
 */
export interface StagehandCdpConnection {
  on<P = unknown>(event: string, handler: (params: P) => void): void;
  off<P = unknown>(event: string, handler: (params: P) => void): void;
}

/**
 * CDP Runtime.bindingCalled event
 */
export interface RuntimeBindingCalledEvent {
  name: string;
  payload: string;
  executionContextId: number;
}

/**
 * CDP Target.targetCreated event
 */
export interface TargetCreatedEvent {
  targetInfo: {
    targetId: string;
    type: string;
    url?: string;
  };
}

/**
 * CDP Target.targetInfoChanged event - fires when a target's info (including URL) changes
 */
export interface TargetInfoChangedEvent {
  targetInfo: {
    targetId: string;
    type: string;
    url: string;
    title?: string;
    attached?: boolean;
  };
}

/**
 * State for session recording per Stagehand instance
 */
export interface V3RecorderState {
  sessionId: StringUUID;
  traceId: StringUUID;
  client: LaminarClient;
  chunkBuffers: Map<string, ChunkBuffer>;
  contextIdToSession: Map<number, { sessionId: StringUUID; traceId: StringUUID }>;
  instrumentedPageIds: Set<string>;
  bindingHandler: ((event: RuntimeBindingCalledEvent) => void) | null;
  targetCreatedHandler: ((event: TargetCreatedEvent) => void) | null;
  targetInfoChangedHandler: ((event: TargetInfoChangedEvent) => void) | null;
  pageSessionHandlers: Map<string, ((event: RuntimeBindingCalledEvent) => void)>;
}

/**
 * Stagehand Agent Client interface
 */
export type AgentClient = {
  execute: (
    instructionOrOptions: string | object,
  ) => Promise<object>;
};
