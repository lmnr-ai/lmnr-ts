# Typescript SDK for Laminar

## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

## Features

- Instrumentation of your JS/TS code
- Events and semantic events right from the code
- Make Laminar pipeline calls from your JS code

## Prerequisites

- Laminar project created at https://lmnr.ai
- Export (or set using .env) a variable `LMNR_PROJECT_API_KEY` with the value from the project settings page

## Code instrumentation 

For manual instrumetation you will need to import the following:
- `trace` - this is a function to start a trace. It returns a `TraceContext`
- `TraceContext` - a pointer to the current trace that you can pass around functions as you want.
- `SpanContext` - a pointer to the current span that you can pass around functions as you want
- `ObservationContext` – parent class of `TraceContext` and `SpanContext`. Useful, if you don't want to import the separate context types in TS.

Both `TraceContext` and `SpanContext` expose the following interfaces:
- `span(name: string, props: CreateSpanProps)` - create a child span within the current context. Returns `SpanContext`
- `update(props)` - update the current trace or span and return it. Returns `TraceContext` or `SpanContext`. Useful when some metadata becomes known later during the program execution

In addition, `SpanContext` allows you to:
- `event(templateName: string, props: SpanEventProps)` - emit a custom event at any point
- `evaluateEvent(templateName: string, data: str, props: SpanEvaluateEventProps)` - register a possible event for automatic checking by Laminar.
- `end(props: UpdateSpanProps)` – update the current span, and terminate it

### Example

```javascript
// `trace()` is the main entrypoint into the observation of your app
// `ObservationContext` is a parent class for `SpanContext` and `TraceContext`
import {
    initialize as lmnrInitialize,
    trace,
    SpanContext,
    TraceContext
} from '@lmnr-ai/lmnr';

import OpenAI from 'openai';

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const getRandomCountry = (s: SpanContext): string => {
    // create the span without registering the input
    const span = s.span('getRandomCountry');
    const countries = ['United States', 'Canada', 'Australia', 'Germany', 'Japan'];
    const country =  countries[Math.floor(Math.random() * countries.length)];
    
    // end the span and register the output
    span.end({output: country});

    return country;
}

const foo = (question: string, t: TraceContext) => {
    // create the span and register the input
    const span = t.span('foo', {input: {question}});

    // pass the span context down the function call if you want to trace it
    const country = getRandomCountry(span);
    question += country;
    const result = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {role: 'system', content: 'You are a helpful assistant.'}, 
            {role: 'user', content: question}
        ],
    }).then((response) => {
        const output = response.choices[0].message.content;

        // ask Laminar to check for a pre-defined event.
        // In this example the event will be called correctness,
        // and the value will be determined by calling the "myCorrectnessEvaluator" pipeline
        span.evaluateEvent(
            'correctness',
            'myCorrectnessEvaluator',
            { llmOutput: output ?? '' }
        );
        // end the span and register the output
        span.end({ output });
    });
};

lmnrInitialize({
    projectApiKey: process.env.LMNR_PROJECT_API_KEY,
    // this is the env that will be passed to the Laminar evaluator and
    // be used during the event evaluation
    env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY
    }
})
// Start the trace observation at the entry to your program
const t = trace();

// pass the trace context into the handler
foo("What is the capital of ", t);
```

Here's the UI result you get by calling that function 4 times in parallel, awaiting an artificial 500ms delay in `getRandomCountry`.

![](/images//exampleTrace.png).

Yellow vertical bars represent the times where correctness was registered, because clearly gpt-4o-mini knows the capitals of these countries.

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

```
> console.log(result)
{
  outputs: { output: { value: { role: 'user', content: 'hello' } } },
  runId: '05383a95-d316-4391-a64b-06c54d12982a'
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
