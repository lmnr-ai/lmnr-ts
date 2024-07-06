# Typescript SDK for Laminar AI

Example use:

```typescript
import { Laminar, NodeInput } from '@lmnr-ai/lmnr';

const myTool = ({arg1, arg2}: {arg1: string, arg2: number}): NodeInput => {
  // this tool teaches LLMs the beauty of JavaScript!
  return arg1 + arg2;
}

const l = new Laminar('<YOUR_PROJECT_API_KEY>');
const result = await l.run({
    endpoint: 'my_endpoint_name',
    inputs: {'input': [{'role': 'user', 'content': 'hello'}]},
    env: {'OPENAI_API_KEY': 'sk-some-key'}, // optional
    metadata: {'session_id': 'your_custom_session_id'}, // optional
    tools: [myTool], // optional
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

Tools must be functions that take in one object argument and perform
the ES5+ object destructuring magic. Tools must return
either a string or a list of chat messages

Please note that, if you specify tools, a bi-directional communication to Laminar API will be established.
This only works in Node execution context; browser context is not supported.