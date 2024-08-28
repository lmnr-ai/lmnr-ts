# Typescript SDK for Laminar AI

## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

## Features

- Make Laminar endpoint calls from your JS code
- Make Laminar endpoint calls that can run your own functions as tools from your NodeJS code
- `LaminarRemoteDebugger` to execute your own functions while you test your flows in workshop

## Making Laminar pipeline calls

After you are ready to use your pipeline in your code, deploy it in Laminar by selecting the target version for the pipeline.

Once your pipeline target is set, you can call it from JS in just a few lines.

Example use:

```typescript
import { Laminar } from '@lmnr-ai/lmnr';

const l = new Laminar('<YOUR_PROJECT_API_KEY>');
const result = await l.run({
    pipeline: 'my_pipeline_name',
    inputs: {'input': [{'role': 'user', 'content': 'hello'}]},
    env: {'OPENAI_API_KEY': 'sk-some-key'}, // optional
    metadata: {'session_id': 'your_custom_session_id'}, // optional
});
```

Resulting in:

```typecript
> console.log(result)
{
  outputs: { output: { value: { role: 'user', content: 'hello' } } },
  runId: '05383a95-d316-4391-a64b-06c54d12982a'
}
```
