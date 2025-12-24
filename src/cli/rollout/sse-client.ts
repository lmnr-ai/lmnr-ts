import { EventEmitter } from 'events';
import { createParser } from 'eventsource-parser';
import { RolloutHandshakeEvent, RolloutParam, RolloutRunEvent } from '../../types';

const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const MAX_MISSED_HEARTBEATS = 3; // N missed intervals before reconnect

export interface SSEClientOptions {
  baseUrl: string;
  sessionId: string;
  projectApiKey: string;
  params: RolloutParam[];
}

/**
 * SSE client for rollout debugging sessions
 * Connects to the Laminar backend and listens for run events
 */
export class SSEClient extends EventEmitter {
  private baseUrl: string;
  private sessionId: string;
  private projectApiKey: string;
  private params: RolloutParam[];
  private abortController?: AbortController;
  private reconnectTimer?: NodeJS.Timeout;
  private lastHeartbeat: number = Date.now();
  private heartbeatCheckTimer?: NodeJS.Timeout;
  private isShutdown: boolean = false;

  constructor(options: SSEClientOptions) {
    super();
    this.baseUrl = options.baseUrl;
    this.sessionId = options.sessionId;
    this.projectApiKey = options.projectApiKey;
    this.params = options.params;
  }

  /**
   * Connects to the SSE endpoint
   */
  async connect(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.abortController = new AbortController();
    this.lastHeartbeat = Date.now();

    try {
      const response = await fetch(
        `${this.baseUrl}/v1/rollouts/${this.sessionId}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.projectApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify({ params: this.params }),
          signal: this.abortController.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      this.emit('connected');
      this.startHeartbeatCheck();

      // Parse SSE stream
      await this.parseSSEStream(response.body);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Connection was aborted intentionally
        return;
      }

      this.emit('error', error);

      if (!this.isShutdown) {
        // Attempt to reconnect
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Parses SSE stream and emits events
   */
  private async parseSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    // Create SSE parser with proper event handling
    const parser = createParser({
      onEvent: (event: any) => {
        this.processSSEEvent(event);
      },
    });

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Feed the chunks to the parser
        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    // Connection ended, try to reconnect if not shutdown
    if (!this.isShutdown) {
      this.scheduleReconnect();
    }
  }

  /**
   * Processes a parsed SSE event
   */
  private processSSEEvent(event: any): void {
    if (!event.data) {
      return;
    }

    try {
      // The event.event field contains the event type ('heartbeat' or 'run')
      // The event.data field contains the JSON payload
      if (event.event === 'heartbeat') {
        this.lastHeartbeat = Date.now();
        this.emit('heartbeat');
      } else if (event.event === 'run') {
        const parsedData = JSON.parse(event.data);
        const runEvent: RolloutRunEvent = {
          event_type: 'run',
          data: parsedData,
        };
        this.emit('run', runEvent);
      } else if (event.event === 'handshake') {
        const parsedData = JSON.parse(event.data);
        const handshakeEvent: RolloutHandshakeEvent = {
          event_type: 'handshake',
          data: parsedData,
        }
        this.emit('handshake', handshakeEvent);
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse SSE event data: ${error}`));
    }
  }

  /**
   * Starts checking for missed heartbeats
   */
  private startHeartbeatCheck(): void {
    this.stopHeartbeatCheck();

    this.heartbeatCheckTimer = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
      const maxAllowedTime = HEARTBEAT_INTERVAL * MAX_MISSED_HEARTBEATS;

      if (timeSinceLastHeartbeat > maxAllowedTime) {
        this.emit('heartbeat_timeout');
        this.reconnect();
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stops heartbeat checking
   */
  private stopHeartbeatCheck(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = undefined;
    }
  }

  /**
   * Schedules a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShutdown) {
      return;
    }

    this.emit('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnect();
    }, 1000); // Wait 1 second before reconnecting
  }

  /**
   * Reconnects to the SSE endpoint
   */
  private reconnect(): void {
    this.disconnect(false);
    this.connect().catch(error => {
      this.emit('error', error);
    });
  }

  /**
   * Disconnects from the SSE endpoint
   */
  private disconnect(stopReconnect: boolean = true): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }

    this.stopHeartbeatCheck();

    if (stopReconnect && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Shuts down the SSE client gracefully
   */
  shutdown(): void {
    this.isShutdown = true;
    this.disconnect(true);
    this.removeAllListeners();
    this.emit('shutdown');
  }
}

/**
 * Creates an SSE client (does not auto-connect)
 * Call client.connect() after registering event listeners
 */
export function createSSEClient(options: SSEClientOptions): SSEClient {
  return new SSEClient(options);
}
