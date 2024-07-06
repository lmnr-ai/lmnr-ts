export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type NodeInput = ChatMessage[] | string;

export type EndpointRunRequest = {
    inputs: Record<string, NodeInput>;
    endpoint: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
    tools?: ((params: Record<string, any>) => NodeInput | Promise<NodeInput>)[];
}

export type EndpointRunResponse = {
    outputs: Record<string, Record<string, NodeInput>>;
    runId: string;
}

export type ToolFunctionCall = {
    name: string;
    arguments: string;
}

export type ToolCall = {
    id: string;
    type: 'function';
    function: ToolFunctionCall;
}

export type NodeWebSocketMessage = {
    type: 'utf8' | 'binary';
    utf8Data?: string;
}

const bar = ({a }: {a: string}): string => a;