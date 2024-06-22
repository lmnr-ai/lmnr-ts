export type ChatMessage = {
    role: 'user' | 'assistant';
    content: string;
}

export type NodeInput = ChatMessage[] | string;

export type EndpointRunRequest = {
    inputs: Record<string, NodeInput>;
    endpoint: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
}

export type EndpointRunResponse = {
    outputs: Record<string, NodeInput>;
    runId: string;
}
