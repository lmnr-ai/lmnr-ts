import { Laminar } from "./client";
import { Span, Trace } from "./types";

export class Collector {
    private readonly flushInterval: number = 2.0; // seconds
    private readonly client = new Laminar(process.env.LMNR_PROJECT_API_KEY || "");
    private readonly maxQueueSize: number = 1000;
    private queue: (Span | Trace)[];
    private flushTimeout: NodeJS.Timeout | number | null;

    constructor() {
        this.queue = [];
        this.flushTimeout = setTimeout(this.flush.bind(this), this.flushInterval * 1000);
    }

    public addTask(task: Span | Trace) {
        this.queue.push(task);
        if (this.queue.length >= this.maxQueueSize) {
            this.flush();
        }
        
        if (!this.flushTimeout) {
            this.flushTimeout = setTimeout(this.flush.bind(this), this.flushInterval * 1000);
        }
    }
    
    private flush() {
        if (this.flushTimeout != null) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        if (this.queue.length === 0) {
            return;
        }
        this.client.batchPostTraces(this.queue)
            .finally(() => {
                this.queue = [];
            });
    }
}

export class CollectorSingleton {
    private static instance: Collector | null = null;

    public static getInstance(): Collector {
        if (this.instance === null) {
            this.instance = new Collector();
        }
        return this.instance;
    }
}
