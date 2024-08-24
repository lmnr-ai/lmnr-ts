export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type NodeInput = ChatMessage[] | string;

export type Tool = (...args: any) => NodeInput | Promise<NodeInput>;

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
