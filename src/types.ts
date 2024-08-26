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
}

export type PipelineRunResponse = {
    outputs: Record<string, Record<string, NodeInput>>;
    runId: string;
}

export type EvaluateEvent = {
    name: string;
    data: string;
}

export type Event = {
    id: string; // UUID
    templateName: string;
    timestamp: Date;
    spanId: string; // UUID
    value: number | string | null; // number must be integer
}

export type Span = {
    version: string;
    spanType: 'DEFAULT' | 'LLM';
    id: string; // UUID
    parentSpanId: string | null; // UUID
    traceId: string; // UUID
    name: string;
    startTime: Date;
    // generated at end of span, so it's optional
    endTime: Date | null;
    attributes: Record<string, any>;
    input: any | null;
    output: any | null;
    metadata: Record<string, any> | null;
    evaluateEvents: EvaluateEvent[];
    events: Event[];
}

export type Trace = {
    id: string; // UUID
    version: string;
    success: boolean;
    startTime: Date | null;
    endTime: Date | null;
    userId: string | null;
    sessionId: string | null;
    release: string;
    metadata: Record<string, any> | null;
}
