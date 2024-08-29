import { Span, Trace } from "./types";

export class Collector {
    private readonly flushInterval: number = 2.0; // seconds
    private readonly client = new Client(process.env.LMNR_PROJECT_API_KEY || "");
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
        this.client.batchPost(this.queue);
        this.queue = [];
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

class Client {
    private readonly baseUrl = "http://localhost:8000";
    private projectApiKey: string;

    constructor(projectApiKey: string) {
        this.projectApiKey = projectApiKey;
    }

    private getHeaders() {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.projectApiKey}`,
        };
    };

    public batchPost(data: (Span | Trace)[]) {
        const body = JSON.stringify({
            traces: data
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/traces`;
        fetch(url, {
            method: "POST",
            headers,
            body,
        }).then((response) => {
            if (!response.ok) {
                console.error("Failed to send traces. Response: ");
                response.text().then((text) => console.error(text));
            }
        }).catch((error) => {
            console.error("Failed to send traces. Error: ", error);
        });
    }
}
