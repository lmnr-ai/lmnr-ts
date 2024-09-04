import { StringUUID } from "./utils";

export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type NodeInput = ChatMessage[] | string;

export type PipelineRunRequest = {
    inputs: Record<string, NodeInput>;
    pipeline: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
    currentSpanId?: StringUUID;
    currentTraceId?: StringUUID;
}

export type PipelineRunResponse = {
    outputs: Record<string, Record<string, NodeInput>>;
    runId: StringUUID;
}

export type EvaluateEvent = {
    name: string;
    evaluator: string;
    data: Record<string, NodeInput>;
    timestamp?: Date;
    env?: Record<string, NodeInput>;
}

export type Event = {
    id: StringUUID;
    templateName: string;
    timestamp: Date;
    spanId: StringUUID;
    value: number | string | null; // number
}

export type CreateEvaluationResponse = {
    id: StringUUID,
    createdAt: Date,
    name: string,
    status: EvaluationStatus
    projectId: StringUUID,
    metadata: Record<string, any> | null,
}

export type EvaluationDatapoint<D, T, O> = {
    data: Record<string, any> & D;
    target: Record<string, any> & T;
    executorOutput: any & O,
    scores: Record<string, number>;
}

export type EvaluationStatus = 'Started' | 'Finished' | 'Error';
