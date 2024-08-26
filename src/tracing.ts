import { Span, Trace } from "./types";

export class Collector {
    private readonly flushInterval: number = 2.0; // seconds
    private readonly client = new Client(process.env.LMNR_PROJECT_API_KEY || "");
    private queue: (Span | Trace)[];

    constructor() {
        this.queue = [];
        setInterval(this.flush, this.flushInterval * 1000);
    }

    public addTask(task: Span | Trace) {
        this.queue.push(task);
    }
    
    private flush() {
        if (!this.queue || this.queue.length === 0) {
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
                console.error("Failed to send traces. Response: ", response);
            }
        }).catch((error) => {
            console.error("Failed to send traces. Error: ", error);
        });
    }
}
