# Typescript SDK for Laminar AI

## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

## Features

- Make Laminar endpoint calls from your JS code
- Make Laminar endpoint calls that can run your own functions as tools from your NodeJS code
- `LaminarRemoteDebugger` to execute your own functions while you test your flows in workshop

## Making Laminar endpoint calls

After you are ready to use your pipeline in your code, deploy it in Laminar following the [docs](https://docs.lmnr.ai/pipeline/run-save-deploy#deploying-a-pipeline-version).

Once your pipeline is deployed, you can call it from JS in just a few lines.

Example use:

```typescript
import { Laminar, NodeInput } from '@lmnr-ai/lmnr';

const l = new Laminar('<YOUR_PROJECT_API_KEY>');
const result = await l.run({
    endpoint: 'my_endpoint_name',
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

### Making calls to pipelines that run your own logic

If your pipeline contains tool call nodes, they will be able to call your local code.
The only difference is that you need to pass references
to the functions you want to call right into our SDK.

Tools must be functions that take in one object argument and perform
the ES5+ object destructuring magic, e.g. `foo({a, b})`. Tools must return
either a string or a list of chat messages

Please note that, if you specify tools, a bi-directional communication to Laminar API will be established.
This only works in Node execution context; browser context is not supported.

Example use:

```js
import { Laminar, NodeInput } from '@lmnr-ai/lmnr';

// make sure to setup arguments as object
const myTool = ({
  arg1, arg2
  }: {
    arg1: string,
    arg2: number
  }): NodeInput => {
  // this tool teaches LLMs the beauty of JavaScript!
  return arg1 + arg2;
}

const l = new Laminar('<YOUR_PROJECT_API_KEY>');
const result = await l.run({
    endpoint: 'my_endpoint_name',
    inputs: {'input': [{'role': 'user', 'content': 'hello'}]},
    env: {'OPENAI_API_KEY': 'sk-some-key'}, // optional
    metadata: {'session_id': 'your_custom_session_id'}, // optional
    // specify as many tools as needed,
    // Each tool name must match tool node name in the pipeline
    tools: [myTool],
});
```

### LaminarRemoteDebugger

If your pipeline contains tool call nodes, they will be able to call your local code.
If you want to test them from the Laminar workshop in your browser, you can attach to your
locally running debugger.

### Step-by-step instructions to use `LaminarRemoteDebugger`:

#### 1. Create your pipeline with tool call nodes

Add tool calls to your pipeline; node names must match the functions you want to call.

#### 2. Start LaminarRemoteDebugger in your code

Example:

```js
import { LaminarRemoteDebugger, NodeInput } from '@lmnr-ai/lmnr';

// make sure to setup arguments as object
const myTool = ({
  arg1, arg2
  }: {
    arg1: string,
    arg2: number
  }): NodeInput => {
  // this tool teaches LLMs the beauty of JavaScript!
  return arg1 + arg2;
}

const dbgr = new LaminarRemoteDebugger('<YOUR_PROJECT_API_KEY>', [myTool]);
dbgr.start();
// the session id will be printed to console.
// It is also returned from this promise, but you may not want to `await` it
```

This will establish a connection with Laminar API and allow for the pipeline execution
to call your local functions.

#### 3. Link lmnr.ai workshop to your debugger

Set up `DEBUGGER_SESSION_ID` environment variable in your pipeline.

#### 4. Run and experiment

You can run as many sessions as you need, experimenting with your flows.

