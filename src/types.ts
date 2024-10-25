import { Datapoint } from "./evaluations";
import { StringUUID } from "./utils";

export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type NodeInput = ChatMessage[] | string | boolean | number;

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
    groupId: string,
    name: string,
    projectId: StringUUID,
}

export type EvaluationDatapoint<D, T, O> = {
    data: Record<string, any> & D;
    target: Record<string, any> & T;
    executorOutput: any & O,
    scores: Record<string, number>;
    traceId: string;
}

export type GetDatapointsResponse<D, T> = {
    items: Datapoint<D, T>[];
    totalCount: number;
    anyInProject: boolean;
}

/**
 * Span types to categorize spans.
 * 
 * LLM spans are auto-instrumented LLM spans.
 * Pipeline spans are top-level spans created by the pipeline runner.
 * Executor and evaluator spans are top-level spans added automatically when doing evaluations.
 */
export type SpanType = 'DEFAULT' | 'LLM' | 'PIPELINE' | 'EXECUTOR' | 'EVALUATOR' | 'EVALUATION'


/**
 * Trace types to categorize traces.
 * They are used as association properties passed to all spans in a trace.
 * 
 * EVENT traces are traces created by the event runner.
 * They are used to mark traces created by the "online" evaluations for semantic events.
 */
export type TraceType = 'DEFAULT' | 'EVENT' | 'EVALUATION'
