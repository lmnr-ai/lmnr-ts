# Typescript SDK for Laminar AI

## Quickstart

```sh
npm install @lmnr-ai/lmnr
```

## Features

- Instrumentation of your JS/TS code
- Events and semantic events right from the code
- Make Laminar pipeline calls from your JS code

## Prerequisite

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
import { trace, ObservationContext } from '@lmnr-ai/lmnr';

import OpenAI from 'openai';

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const getRandomCountry = (s: ObservationContext): string => {
    // create the span without registering the input
    const span = s.span('getRandomCountry');
    const countries = ['United States', 'Canada', 'Australia', 'Germany', 'Japan'];
    const country =  countries[Math.floor(Math.random() * countries.length)];
    
    // end the span and register the output
    span.end({output: country});

    return country;
}

const foo = (question: string, t: ObservationContext) => {
    // create the span and register the input
    const span = t.span('foo', {input: {question}});

    // pass the span context down the function call if you want to trace it
    const country = getRandomCountry(span);
    question += country;
    const result = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{role: 'system', content: 'You are a helpful assistant.'}, {role: 'user', content: question}],
    }).then((response) => {
        const output = response.choices[0].message.content;

        // ask Laminar to check for a pre-defined event.
        // In this example correctness is pre-defined in the UI as "The data is factually correct"
        span.evalueateEvent('correctness', output ?? '');
        // end the span and register the output
        span.end({output});
    });
};

// Start the trace observation at the entry to your program
const t = trace();

// pass the trace context into the handler
foo("What is the capital of ", t);

```

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
