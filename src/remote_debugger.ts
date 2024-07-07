import { NodeWebSocketMessage, RegisterDebuggerRequest, Tool, ToolCall, WebSocketError } from "./types";
import { v4 as uuidv4 } from 'uuid';

export class RemoteDebugger {
    private readonly projectApiKey: string;
    private readonly url: string = 'wss://api.lmnr.ai/v2/endpoint/ws';
    private readonly tools: Tool[];
    private sessionId: string | null = null;
    private socket;

    constructor(projectApiKey: string, tools: Tool[]) {
        this.projectApiKey = projectApiKey;
        this.tools = tools;
        const WebSocketClient = require('websocket').client;
        this.socket = new WebSocketClient();
        
        this.socket.on('connectFailed', (error: any) => {
            console.log('Connect Error: ' + error.toString());
        });
    }

    public async start(): Promise<string> {
        this.sessionId = this.generateSessionId();
        console.log(this.formatSessionId());

        this.socket.on('connect', (connection: any) => {
            connection.send(JSON.stringify({
                debuggerSessionId: this.sessionId
            } as RegisterDebuggerRequest));
            connection.on('message', (data: NodeWebSocketMessage) => {
                try {
                    const toolCall = JSON.parse(data["utf8Data"]!) as ToolCall;
                    const matchingTool = this.tools.find(tool => tool.name === toolCall.function.name);
                    if (!matchingTool) {
                        throw new WebSocketError(
                            `Tool ${toolCall.function.name} not found. Registered tools: ${this.tools.map(tool => tool.name).join(', ')}`
                        );
                    }
                    let args = {}
                    try {
                        args = JSON.parse(toolCall.function.arguments);
                    } catch (e) {}
                    const result = matchingTool(args);
                    connection.send(JSON.stringify(result));
                } catch (e) {
                    if (e instanceof WebSocketError) {
                        throw e;
                    }
                }
            });
        });

        this.socket.connect(
            this.url,
            '',  // protocols. If specified, server tries to match one of these, and fails
            null,  // origin. Makes more sense in a browser context
            {'Authorization': `Bearer ${this.projectApiKey}`}
        );

        return this.sessionId;
    }

    public stop() {
        this.socket.close();
    }

    public getSessionId(): string | null {
        return this.sessionId;
    }

    private generateSessionId(): string {
        return uuidv4();
    }

    private formatSessionId(): string {
        return `
========================================
Debugger Session ID:
${this.sessionId}
========================================
`
    }
}