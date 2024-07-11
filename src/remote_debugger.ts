import {
    DeregisterDebuggerRequest,
    NodeWebSocketMessage,
    RegisterDebuggerRequest,
    Tool,
    ToolCallRequest,
    ToolCallError,
    ToolCallResponse,
} from "./types";
import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';


export class RemoteDebugger {
    private readonly projectApiKey: string;
    private readonly url: string = 'wss://api.lmnr.ai/v2/endpoint/ws';
    private readonly tools: Tool[];
    private sessionId: string | null = null;
    private socket;

    constructor(projectApiKey: string, tools: Tool[]) {
        this.projectApiKey = projectApiKey;
        this.tools = tools;
        this.socket = new  WebSocket(this.url, [], {headers: {'Authorization': `Bearer ${this.projectApiKey}`}});
    }

    public async start(): Promise<string> {
        this.sessionId = this.generateSessionId();
        console.log(this.formatSessionIdAndRegisteredTools());
        let reqId: string | null = null;

        this.socket.on('open', () => {
            this.socket.send(JSON.stringify({
                debuggerSessionId: this.sessionId
            } as RegisterDebuggerRequest));
        });

        this.socket.on('message', (data: NodeWebSocketMessage) => {
            try {
                const toolCall = JSON.parse(data.toString()) as ToolCallRequest;
                reqId = toolCall.reqId;
                const matchingTool = this.tools.find(tool => tool.name === toolCall.toolCall.function.name);
                if (!matchingTool) {
                    const errMsg = `Tool ${toolCall.toolCall.function.name} not found. ` + 
                        `Registered tools: ${this.tools.map(tool => tool.name).join(', ')}`;
                    console.error(errMsg);
                    this.socket.send(JSON.stringify({
                        reqId,
                        error: errMsg
                    } as ToolCallError));
                    return;
                }
                let args = {}
                try {
                    args = JSON.parse(toolCall.toolCall.function.arguments);
                } catch (e) {}
                try {
                    const result = matchingTool(args); // NodeInput
                    const toolResponse = {
                        reqId,
                        response: result
                    } as ToolCallResponse;
                    this.socket.send(JSON.stringify(toolResponse));
                } catch (e) {
                    this.socket.send(JSON.stringify({
                        reqId,
                        error: (e as Error).message
                    } as ToolCallError));
                }
            } catch (e) {
                console.error(`Received invalid message: ${data.toString()}`);
                this.socket.send(JSON.stringify({
                    deregister: true,
                    debuggerSessionId: this.sessionId
                } as RegisterDebuggerRequest));
                this.socket.close();
            }
        });

        return this.sessionId;
    }

    public stop() {
        this.socket.send(JSON.stringify({
            deregister: true,
            debuggerSessionId: this.sessionId
        } as DeregisterDebuggerRequest));
        this.socket.close();
    }

    public getSessionId(): string | null {
        return this.sessionId;
    }

    private generateSessionId(): string {
        return uuidv4();
    }

    private formatSessionIdAndRegisteredTools(): string {
        return `
========================================
Debugger Session ID:
${this.sessionId}
========================================

Registered functions:
${this.tools.map(tool => '- ' + tool.name).join(',\n')}
========================================
`
    }
}