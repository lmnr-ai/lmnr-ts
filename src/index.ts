import { NodeInput, EndpointRunResponse, EndpointRunRequest } from './types';

export class Laminar {
    private projectApiKey: string;
    private url: string;

    constructor(projectApiKey: string) {
        this.projectApiKey = projectApiKey;
        this.url = 'https://api.lmnr.ai/v2/endpoint/run'
    }

    async run({
        endpoint,
        inputs,
        env = {},
        metadata = {}
    }: EndpointRunRequest): Promise<EndpointRunResponse> {
        if (this.projectApiKey === undefined) {
            throw new Error('Please initialize the Laminar object with your project API key');
        }
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
}
