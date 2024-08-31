import { PipelineRunResponse, PipelineRunRequest, Span, Trace, EvaluationDatapoint, EvaluationStatus } from './types';

export class Laminar {
    private readonly projectApiKey: string;
    private readonly baseUrl: string;

    constructor(projectApiKey: string) {
        this.projectApiKey = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
        this.baseUrl = 'https://api.lmnr.ai'
    }

    public async run({
        pipeline,
        inputs,
        env = {},
        metadata = {},
    }: PipelineRunRequest): Promise<PipelineRunResponse> {
        if (this.projectApiKey === undefined) {
            throw new Error(
                'Please initialize the Laminar object with your project API key ' +
                'or set the LMNR_PROJECT_API_KEY environment variable'
            );
        }

        const response = await fetch(`${this.baseUrl}/v1/pipeline/run`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                inputs,
                pipeline,
                env,
                metadata,
            })
        });

        return await response.json() as PipelineRunResponse;
    }

    public async batchPostTraces(data: (Span | Trace)[]) {
        const body = JSON.stringify({
            traces: data
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/traces`;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers,
                body,
            });
            if (!response.ok) {
                console.error("Failed to send traces. Response: ");
                response.text().then((text) => console.error(text));
            }
        } catch(error) {
            console.error("Failed to send traces. Error: ", error);
        };
    }

    public async createEvaluation(name: string) {
        const response = await fetch(`${this.baseUrl}/v1/evaluations`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                name,
            })
        });

        return await response.json();
    }

    public async postEvaluationResults<D, T, O>(
        evaluationName: string,
        data: EvaluationDatapoint<D, T, O>[]
    ): Promise<void> {
        const body = JSON.stringify({
            name: evaluationName,
            points: data,
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/evaluation-datapoints`;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers,
                body,
            });
            if (!response.ok) {
                console.error("Failed to send evaluation results. Response: ");
                response.text().then((text) => console.error(text));
            }
        } catch(error) {
            console.error("Failed to send evaluation results. Error: ", error);
        };
    }

    public async updateEvaluationStatus(
        evaluationName: string,
        status: EvaluationStatus,
    ): Promise<void> {
        const body = JSON.stringify({
            name: evaluationName,
            status,
        });
        const headers = this.getHeaders();
        const url = `${this.baseUrl}/v1/evaluations`;
        try {
            const response = await fetch(url, {
                method: "PUT",
                headers,
                body,
            });
            if (!response.ok) {
                console.error("Failed to update evaluation status. Response: ");
                response.text().then((text) => console.error(text));
            }
        } catch(error) {
            console.error("Failed to update evaluation status. Error: ", error);
        }
    }

    private getHeaders() {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.projectApiKey}`,
        };
    };
}
