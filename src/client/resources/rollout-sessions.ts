import { BaseResource } from "./index";

interface SessionResponse {
  span: {
    name: string;
    input: string;
    output: string;
    attributes: Record<string, any>;
  };
  pathToCount: Record<string, number>;
}

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  public async get({
    path,
    index,
    sessionId,
  }: {
    path: string;
    index: number;
    sessionId: string;
  }): Promise<SessionResponse | undefined> {
    // TODO: Remove this once the API is updated to return the spans.
    // const spans = [
    //   {
    //     "name": "ai.generateText.doGenerate",
    //     "path": "handle.ai.generateText.ai.generateText.doGenerate",
    //     "input": "[{\"role\":\"system\",\"content\":\"You are a helpful assistant.\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What is the weather in SF?\"}]}]",
    //     "output": "[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_call\",\"name\":\"get_weather\",\"id\":\"call_bGP7gTwfDkxJyGS1HcWrHiwa\",\"arguments\":{\"location\":\"San Francisco, CA\"}}]}]",
    //     "attributes": "{\"ai.usage.promptTokens\":106,\"gen_ai.response.finish_reasons\":[\"tool-calls\"],\"ai.telemetry.functionId\":\"v5-auto-tools\",\"ai.response.model\":\"gpt-4.1-nano-2025-04-14\",\"ai.response.finishReason\":\"tool-calls\",\"resource.name\":\"v5-auto-tools\",\"gen_ai.usage.cost\":0.000024200000000000005,\"ai.operationId\":\"ai.generateText.doGenerate\",\"gen_ai.usage.input_tokens\":106,\"operation.name\":\"ai.generateText.doGenerate v5-auto-tools\",\"lmnr.span.instrumentation_source\":\"javascript\",\"ai.request.headers.user-agent\":\"ai/6.0.0-beta.138\",\"ai.model.id\":\"gpt-4.1-nano\",\"gen_ai.usage.output_tokens\":34,\"ai.telemetry.metadata.key\":\"value\",\"ai.telemetry.metadata.user_id\":\"user_123\",\"gen_ai.system\":\"openai\",\"gen_ai.usage.output_cost\":0.000013600000000000002,\"ai.telemetry.metadata.session_id\":\"session_123\",\"ai.telemetry.metadata.tags\":[\"tag1\",\"tag2\"],\"lmnr.span.sdk_version\":\"0.7.12\",\"ai.prompt.tools\":[{\"description\":\"Get the weather in a given location\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\",\"description\":\"The city and state, e.g. San Francisco, CA\"}},\"required\":[\"location\"],\"additionalProperties\":false,\"$schema\":\"http://json-schema.org/draft-07/schema#\"},\"type\":\"function\",\"name\":\"get_weather\"},{\"description\":\"Get the time in a given location\",\"type\":\"function\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\",\"description\":\"The city and state, e.g. San Francisco, CA\"}},\"required\":[\"location\"],\"additionalProperties\":false,\"$schema\":\"http://json-schema.org/draft-07/schema#\"},\"name\":\"get_time\"}],\"lmnr.span.language_version\":\"node@23.3.0\",\"ai.usage.completionTokens\":34,\"lmnr.span.ids_path\":[\"00000000-0000-0000-4f06-1bdfe10220ef\",\"00000000-0000-0000-9573-bcb70f5b5644\",\"00000000-0000-0000-c863-fca43efc5df3\"],\"ai.response.timestamp\":\"2025-12-19T16:50:05.000Z\",\"ai.response.id\":\"resp_04cd749df3605334006945823d13b08196a9cd0731de6bb7dd\",\"ai.prompt.toolChoice\":\"{\\\"type\\\":\\\"auto\\\"}\",\"ai.model.provider\":\"openai.responses\",\"ai.response.providerMetadata\":\"{\\\"openai\\\":{\\\"responseId\\\":\\\"resp_04cd749df3605334006945823d13b08196a9cd0731de6bb7dd\\\",\\\"serviceTier\\\":\\\"default\\\"}}\",\"lmnr.span.path\":[\"handle\",\"ai.generateText\",\"ai.generateText.doGenerate\"],\"gen_ai.usage.input_cost\":0.000010600000000000002,\"ai.settings.maxRetries\":2,\"gen_ai.request.model\":\"gpt-4.1-nano\",\"gen_ai.response.model\":\"gpt-4.1-nano-2025-04-14\",\"gen_ai.response.id\":\"resp_04cd749df3605334006945823d13b08196a9cd0731de6bb7dd\"}"
    //   },
    //   {
    //     "name": "ai.generateText.doGenerate",
    //     "path": "handle.ai.generateText.ai.generateText.doGenerate",
    //     "input": "[{\"role\":\"system\",\"content\":\"You are a helpful assistant.\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What is the weather in SF?\"}]},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_call\",\"name\":\"get_weather\",\"id\":\"call_bGP7gTwfDkxJyGS1HcWrHiwa\",\"arguments\":{\"location\":\"San Francisco, CA\"}}]},{\"role\":\"tool\",\"content\":[{\"type\":\"tool-result\",\"toolCallId\":\"call_bGP7gTwfDkxJyGS1HcWrHiwa\",\"output\":{\"type\":\"json\",\"value\":{\"location\":\"San Francisco, CA\",\"weather\":\"Sunny as always!\"}},\"toolName\":\"get_weather\"}]}]",
    //     "output": "[{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"The weather in San Francisco is sunny!\"}]}]",
    //     "attributes": "{\"gen_ai.system\":\"openai\",\"ai.usage.completionTokens\":10,\"ai.usage.promptTokens\":144,\"ai.prompt.toolChoice\":\"{\\\"type\\\":\\\"auto\\\"}\",\"ai.response.model\":\"gpt-4.1-nano-2025-04-14\",\"ai.response.timestamp\":\"2025-12-19T16:50:06.000Z\",\"ai.prompt.tools\":[{\"type\":\"function\",\"description\":\"Get the weather in a given location\",\"name\":\"get_weather\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\",\"description\":\"The city and state, e.g. San Francisco, CA\"}},\"required\":[\"location\"],\"additionalProperties\":false,\"$schema\":\"http://json-schema.org/draft-07/schema#\"}},{\"name\":\"get_time\",\"description\":\"Get the time in a given location\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\",\"description\":\"The city and state, e.g. San Francisco, CA\"}},\"required\":[\"location\"],\"additionalProperties\":false,\"$schema\":\"http://json-schema.org/draft-07/schema#\"},\"type\":\"function\"}],\"gen_ai.usage.input_tokens\":144,\"gen_ai.response.model\":\"gpt-4.1-nano-2025-04-14\",\"gen_ai.usage.cost\":0.0000184,\"lmnr.span.language_version\":\"node@23.3.0\",\"gen_ai.usage.output_tokens\":10,\"ai.response.finishReason\":\"stop\",\"ai.telemetry.metadata.tags\":[\"tag1\",\"tag2\"],\"lmnr.span.path\":[\"handle\",\"ai.generateText\",\"ai.generateText.doGenerate\"],\"ai.model.provider\":\"openai.responses\",\"ai.telemetry.functionId\":\"v5-auto-tools\",\"lmnr.span.ids_path\":[\"00000000-0000-0000-4f06-1bdfe10220ef\",\"00000000-0000-0000-9573-bcb70f5b5644\",\"00000000-0000-0000-0118-506c96ff7f2b\"],\"operation.name\":\"ai.generateText.doGenerate v5-auto-tools\",\"ai.telemetry.metadata.session_id\":\"session_123\",\"resource.name\":\"v5-auto-tools\",\"ai.request.headers.user-agent\":\"ai/6.0.0-beta.138\",\"gen_ai.response.id\":\"resp_04cd749df3605334006945823e8ab08196b56b1917bc9744fe\",\"ai.settings.maxRetries\":2,\"gen_ai.response.finish_reasons\":[\"stop\"],\"ai.telemetry.metadata.key\":\"value\",\"gen_ai.usage.input_cost\":0.000014400000000000001,\"ai.response.id\":\"resp_04cd749df3605334006945823e8ab08196b56b1917bc9744fe\",\"ai.response.providerMetadata\":\"{\\\"openai\\\":{\\\"responseId\\\":\\\"resp_04cd749df3605334006945823e8ab08196b56b1917bc9744fe\\\",\\\"serviceTier\\\":\\\"default\\\"}}\",\"ai.operationId\":\"ai.generateText.doGenerate\",\"lmnr.span.sdk_version\":\"0.7.12\",\"ai.telemetry.metadata.user_id\":\"user_123\",\"lmnr.span.instrumentation_source\":\"javascript\",\"gen_ai.usage.output_cost\":4e-6,\"gen_ai.request.model\":\"gpt-4.1-nano\",\"ai.model.id\":\"gpt-4.1-nano\"}"
    //   }
    // ]
    // return {
    //   span: {
    //     name: spans[0].name,
    //     input: spans[0].input,
    //     output: spans[0].output,
    //     attributes: JSON.parse(spans[0].attributes),
    //   },
    //   pathToCount: {
    //     'handle.ai.generateText.ai.generateText.doGenerate': 1
    //   }
    // }
    const response = await fetch(`${this.baseHttpUrl}/v1/rollouts/${sessionId}`, {
      method: "POST",
      headers: {
        ...this.headers(),
      },
      body: JSON.stringify({
        path,
        index,
      }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return;
      }
      throw new Error(`${response.status} ${await response.text()}`);
    }

    return await response.json() as SessionResponse;
  }
}
