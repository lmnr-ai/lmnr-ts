export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type NodeInput = ChatMessage[] | string;

export type Tool = (...args: any) => NodeInput | Promise<NodeInput>;

export type EndpointRunRequest = {
    inputs: Record<string, NodeInput>;
    endpoint: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
    tools?: Tool[];
}

export type EndpointRunResponse = {
    outputs: Record<string, Record<string, NodeInput>>;
    runId: string;
}

export type ToolCallRequest = {
    reqId: string;
    toolCall: ToolCall;
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

export type ToolCallResponse = {
    reqId: string;
    response: NodeInput;
}

export type NodeWebSocketMessage = {
    type: 'utf8' | 'binary';
    utf8Data?: string;
}

export type RegisterDebuggerRequest = {
    debuggerSessionId: string;
}

export type DeregisterDebuggerRequest = {
    deregister: true;
    debuggerSessionId: string;
}

export type ToolCallError = {
    reqId: string;
    error: string;
}

export class WebSocketError extends Error {}
