# Laminar Typescript

OpenTelemetry log sender for [Laminar](https://github.com/lmnr-ai/lmnr) for TS code.

 <a href="https://www.npmjs.com/package/@lmnr-ai/lmnr"> ![NPM Version](https://img.shields.io/npm/v/%40lmnr-ai%2Flmnr?label=lmnr&logo=npm&logoColor=CB3837) </a>
 ![NPM Downloads](https://img.shields.io/npm/dm/%40lmnr-ai%2Flmnr)


## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

And then in the code

```typescript
import { Laminar as L } from '@lmnr-ai/lmnr'

L.initialize({ projectApiKey: '<PROJECT_API_KEY>' })
```

This will automatically instrument most of the LLM, Vector DB, and related
calls with OpenTelemetry-compatible instrumentation.

We rely on the amazing [OpenLLMetry](https://github.com/traceloop/openllmetry), open-source package
by TraceLoop, to achieve that.

## Instrumentation

In addition to automatic instrumentation, we provide a simple `@observe()` decorator, if you want more fine-grained tracing
or to trace other functions.

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

Note that to run an evaluate event, you need to crate an evaluator pipeline and create a target version for it.

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

## Running offline evaluations on your data

You can evaluate your code with your own data and send it to Laminar using the `Evaluation` class.

Evaluation takes in the following parameters:
- `name` – the name of your evaluation. If no such evaluation exists in the project, it will be created. Otherwise, data will be pushed to the existing evaluation
- `data` – an array of `Datapoint` objects, where each `Datapoint` has two keys: `target` and `data`, each containing a key-value object.
- `executor` – the logic you want to evaluate. This function must take `data` as the first argument, and produce any output. *
- `evaluators` – evaluaton logic. List of functions that take output of executor as the first argument, `target` as the second argument and produce a numeric scores. Each function can produce either a single number or `Record<string, number>` of scores.
- `config` – optional additional override parameters.

\* If you already have the outputs of executors you want to evaluate, you can specify the executor as an identity function, that takes in `data` and returns only needed value(s) from it.

### Example

```javascript
import { Evaluation } from '@lmnr-ai/lmnr';

import OpenAI from 'openai';

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const getCapital = async ({country} : {country: string}): Promise<string> => {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: 'You are a helpful assistant.'
            }, {
                role: 'user',
                content: `What is the capital of ${country}? 
                Just name the city and nothing else`
            }
        ],
    });
    return response.choices[0].message.content ?? ''
}

const e = new Evaluation( 'my-evaluation', {
    data: [
        { data: { country: 'Canada' }, target: { capital: 'Ottawa' } },
        { data: { country: 'Germany' }, target: { capital: 'Berlin' } },
        { data: { country: 'Tanzania' }, target: { capital: 'Dodoma' } },
    ],
    executor: async (data) => await getCapital(data),
    evaluators: [
        async (output, target) => (await output) === target.capital ? 1 : 0
    ],
    config: {
        projectApiKey: process.env.LMNR_PROJECT_API_KEY
    }
})

e.run();
```
