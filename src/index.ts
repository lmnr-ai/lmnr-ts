import { EndpointRunResponse, EndpointRunRequest, NodeWebSocketMessage, WebSocketError, ToolCallRequest, ToolCallResponse, ToolCallError } from './types';
import { isBrowser, isNode } from 'browser-or-node';
import { WebSocket } from 'ws';

export { NodeInput, EndpointRunResponse, EndpointRunRequest, ChatMessage } from './types';
export { RemoteDebugger as LaminarRemoteDebugger } from './remote_debugger';

export class Laminar {
    private readonly projectApiKey: string;
    private readonly url: string;
    private readonly ws_url: string;
    private readonly response: EndpointRunResponse | null = null;

    constructor(projectApiKey: string) {
        this.projectApiKey = projectApiKey;
        this.url = 'https://api.lmnr.ai/v2/endpoint/run'
        this.ws_url = 'wss://api.lmnr.ai/v2/endpoint/ws'
    }

    public async run(request: EndpointRunRequest): Promise<EndpointRunResponse> {
        if (this.projectApiKey === undefined) {
            throw new Error('Please initialize the Laminar object with your project API key');
        }

        if (request.tools !== undefined && request.tools.length > 0) {
            return this._ws_run(request);
        }
        return this._run(request);
    }

    private async _run({
        endpoint,
        inputs,
        env = {},
        metadata = {}
    }: EndpointRunRequest): Promise<EndpointRunResponse> {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.projectApiKey}`
            },
            body: JSON.stringify({
                inputs,
                endpoint,
                env,
                metadata
            })
        });

        return await response.json() as EndpointRunResponse;
    }

    private async _ws_run(request: EndpointRunRequest): Promise<EndpointRunResponse> {
        if (isBrowser) {
            throw new Error('Running tools in the browser is not supported. Please use the Node.js environment.');
        } else if (isNode) {
            return this._ws_run_node(request);
        } else {
            throw new Error('Unsupported environment');
        }
    }

    private async _ws_run_node({
        endpoint,
        inputs,
        env = {},
        metadata = {},
        tools = [],
    }: EndpointRunRequest): Promise<EndpointRunResponse> {
        const socket = new  WebSocket(this.ws_url, [], {headers: {'Authorization': `Bearer ${this.projectApiKey}`}});
        let response: EndpointRunResponse | null = null;
        let reqId: string | null = null;
        
        socket.on('open', () => {
            socket.send(JSON.stringify({
                inputs,
                endpoint,
                env,
                metadata,
                tools,
            }));
        });
        socket.on('message', (data: NodeWebSocketMessage) => {
            try {
                const toolCall = JSON.parse(data.toString()) as ToolCallRequest;
                reqId = toolCall.reqId;
                const matchingTool = tools.find(tool => tool.name === toolCall.toolCall.function.name);
                if (!matchingTool) {
                    throw new WebSocketError(
                        `Tool ${toolCall.toolCall.function.name} not found. ` +
                         `Registered tools: ${tools.map(tool => tool.name).join(', ')}`
                    );
                }
                let args = {}
                try {
                    args = JSON.parse(toolCall.toolCall.function.arguments);
                } catch (e) {}
                try {
                    const result = matchingTool(args);
                    const toolResponse = {
                        reqId,
                        response: result
                    } as ToolCallResponse;
                    socket.send(JSON.stringify(toolResponse));
                } catch (e) {
                    socket.send(JSON.stringify({
                        reqId,
                        error: (e as Error).message
                    } as ToolCallError));
                }
            } catch (e) {
                if (e instanceof WebSocketError) {
                    throw e;
                }
                response = JSON.parse(data.toString()) as EndpointRunResponse;
                socket.close();
            }
        });

        // TODO: Implement a better way to wait for the response
        while (!response) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        return response;
    }
}