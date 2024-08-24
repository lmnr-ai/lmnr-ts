import { PipelineRunResponse, PipelineRunRequest } from './types';

export { NodeInput, PipelineRunResponse, PipelineRunRequest, ChatMessage } from './types';

export class Laminar {
    private readonly projectApiKey: string;
    private readonly url: string;
    private readonly response: PipelineRunResponse | null = null;

    constructor(projectApiKey: string) {
        this.projectApiKey = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
        this.url = 'https://api.lmnr.ai/v1/pipeline/run'
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

        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.projectApiKey}`
            },
            body: JSON.stringify({
                inputs,
                pipeline,
                env,
                metadata,
            })
        });

        return await response.json() as PipelineRunResponse;
    }
}
