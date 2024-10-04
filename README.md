# Laminar Typescript

JavaScript/TypeScript SDK for [Laminar](https://www.lmnr.ai).

[Laminar](https://www.lmnr.ai) is an open-source platform for engineering LLM products. Trace, evaluate, annotate, and analyze LLM data. Bring LLM applications to production with confidence.

Check our [open-source repo](https://github.com/lmnr-ai/lmnr) and don't forget to star it ⭐

 <a href="https://www.npmjs.com/package/@lmnr-ai/lmnr"> ![NPM Version](https://img.shields.io/npm/v/%40lmnr-ai%2Flmnr?label=lmnr&logo=npm&logoColor=CB3837) </a>
 ![NPM Downloads](https://img.shields.io/npm/dm/%40lmnr-ai%2Flmnr)

## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

And then in the code

```typescript
# Only if you are using Next.js
export NEXT_OTEL_FETCH_DISABLED=1

import { Laminar as L } from '@lmnr-ai/lmnr'

L.initialize({ projectApiKey: '<PROJECT_API_KEY>' })
```

This will automatically instrument most of the LLM, Vector DB, and related
calls with OpenTelemetry-compatible instrumentation.

[Read docs](https://docs.lmnr.ai) to learn more.

Autoinstrumentations are provided by [OpenLLMetry](https://github.com/traceloop/openllmetry-js), open-source package by TraceLoop.

## Instrumentation

In addition to automatic instrumentation, we provide a simple `@observe()` decorator.
This can be useful if you want to trace a request handler or a function which combines multiple LLM calls.

### Example

```javascript
const { Configuration, OpenAIApi } = require("openai");
import { OpenAI } from 'openai';
import { Laminar as L, observe } from '@lmnr-ai/lmnr';

L.initialize({ projectApiKey: "<LMNR_PROJECT_API_KEY>" });

const client = new OpenAI({ apiKey: '<OPENAI_API_KEY>' });

const poemWriter = async (topic = "turbulence") => {
  const prompt = `write a poem about ${topic}`;
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt }
    ]
  });

  const poem = response.choices[0].message.content;
  return poem;
}

// Observe the function like this
await observe({name: 'poemWriter'}, async () => await poemWriter('laminar flow'))
```

### Sending events

You can send events in two ways:
- `.event(name, value)` – for a pre-defined event with one of possible values.
- `.evaluate_event(name, evaluator, data, env)` – for an event that is evaluated by evaluator pipeline based on the data.

Note that to run an evaluate event, you need to create an evaluator pipeline and create a target version for it.

Read our [docs](https://docs.lmnr.ai) to learn more about event types and how they are created and evaluated.

### Example

```javascript
import { Laminar as L } from '@lmnr-ai/lmnr';
// ...
const poem = response.choices[0].message.content;

// this will register True or False value with Laminar
L.event('topic alignment', poem.includes(topic))

// this will run the pipeline `checkWordy` with `poem` set as the value
// of `textInput` node, and write the result as an event with name
// "excessiveWordiness"
L.evaluateEvent('excessiveWordiness', 'checkWordy', {'textInput': 'poem'})
```

## Evaluations

### Quickstart

Install the package:

```sh
npm install @lmnr-ai/lmnr
```

Create a file named `my-first-eval.ts` with the following code:

```typescript
import { evaluate } from '@lmnr-ai/lmnr';

const writePoem = ({topic}: {topic: string}) => {
    return `This is a good poem about ${topic}`
}

evaluate({
    data: [
        { data: { topic: 'flowers' }, target: { poem: 'This is a good poem about flowers' } },
        { data: { topic: 'cars' }, target: { poem: 'I like cars' } },
    ],
    executor: (data) => writePoem(data),
    evaluators: {
        containsPoem: (output, target) => target.poem.includes(output) ? 1 : 0
    },
    groupId: 'my_first_feature'
})
```

Run the following commands:

```sh
export LMNR_PROJECT_API_KEY=<LMNR_PROJECT_API_KEY>  # get from Laminar project settings
npx lmnr eval my-first-eval.ts
```

Visit the URL printed in the console to see the results.

### Overview

Bring rigor to the development of your LLM applications with evaluations.

You can run evaluations locally by providing executor (part of the logic used in your application) and evaluators (numeric scoring functions) to `evaluate` function.

`evaluate` takes in the following parameters:
- `data` – an array of `Datapoint` objects, where each `Datapoint` has two keys: `target` and `data`, each containing a key-value object.
- `executor` – the logic you want to evaluate. This function must take `data` as the first argument, and produce any output.
- `evaluators` – Object which maps evaluator names to evaluators. Each evaluator is a function that takes output of executor as the first argument, `target` as the second argument and produces numeric scores. Each function can produce either a single number or `Record<string, number>` of scores.
- `name` – optional name for the evaluation. Automatically generated if not provided.
- `config` – optional additional override parameters.

\* If you already have the outputs of executors you want to evaluate, you can specify the executor as an identity function, that takes in `data` and returns only needed value(s) from it.

[Read docs](https://docs.lmnr.ai/evaluations/introduction) to learn more about evaluations.

## Laminar pipelines as prompt chain managers

You can create Laminar pipelines in the UI and manage chains of LLM calls there.

After you are ready to use your pipeline in your code, deploy it in Laminar by selecting the target version for the pipeline.

Once your pipeline target is set, you can call it from Python in just a few lines.
Example use:

```typescript
import { Laminar } from '@lmnr-ai/lmnr';

const l = new Laminar('<YOUR_PROJECT_API_KEY>');
const result = await l.run({
    pipeline: 'my_pipeline_name',
    inputs: {'input': [{'role': 'user', 'content': 'hello'}]},
    env: {'OPENAI_API_KEY': 'sk-some-key'}, // optional
    metadata: {'metadata_key': 'metadata_value'}, // optional
});
```

Resulting in:

```
> console.log(result)
{
  outputs: { output: { value: { role: 'user', content: 'hello' } } },
  runId: '05383a95-d316-4091-a64b-06c54d12982a'
}
```
