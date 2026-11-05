# Laminar TypeScript

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
import { Laminar } from "@lmnr-ai/lmnr";

Laminar.initialize({ projectApiKey: "<PROJECT_API_KEY>" });
```

This will automatically instrument most of the LLM, Vector DB, and related
calls with OpenTelemetry-compatible instrumentation.

[Read docs](https://laminar.sh/docs) to learn more.

### Where to place Laminar.initialize()

Laminar.initialize() must be called
- once in your application,
- as early as possible, but after other instrumentation libraries

### Environment variables

| Variable                       | Meaning                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LMNR_PROJECT_API_KEY`         | Project API key, if not passed to `initialize()`                                                                                                                                                                        |
| `LMNR_BASE_URL`                | Laminar API base URL (default `https://api.lmnr.ai`)                                                                                                                                                                    |
| `LMNR_RELEASE`                 | Release (e.g. git SHA) stamped on spans; detected if unset                                                                                                                                                              |
| `LMNR_TRAJECTORY_PATH`         | Write the run as a trajectory file in Harbor's ATIF format (with Laminar's `lmnr-atif` extension) at this path instead of exporting spans; no API key needed. May contain `{trace_id}` (one file per trace) and `{pid}` |
| `LMNR_TRAJECTORY_FORCE_EXPORT` | With `LMNR_TRAJECTORY_PATH`: also export spans to Laminar (needs an API key)                                                                                                                                            |

`Laminar.initialize({ writeTrajectory: false })` ignores `LMNR_TRAJECTORY_PATH`, for a process whose environment is meant for an agent it runs.

## Instrumentation

In addition to automatic instrumentation, we provide a simple `@observe()` decorator.
This can be useful if you want to trace a request handler or a function which combines multiple LLM calls.

### Example

```javascript
import { OpenAI } from "openai";
import { Laminar as L, observe } from "@lmnr-ai/lmnr";

L.initialize({ projectApiKey: "<LMNR_PROJECT_API_KEY>" });

const client = new OpenAI({ apiKey: "<OPENAI_API_KEY>" });

const poemWriter = async (topic = "turbulence") => {
  const prompt = `write a poem about ${topic}`;
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ],
  });

  const poem = response.choices[0].message.content;
  return poem;
};

// Observe the function like this
await observe(
  { name: "poemWriter" },
  async () => await poemWriter("laminar flow"),
);
```

### Pi Durable

`laminarPiDurable()` traces a [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) (`@earendil-works/pi-durable` 1.4+) Harness. Each run is one trace: a root span with the user's input and the final answer, an LLM span per model request (messages including the system prompt, tool definitions, tokens, cost) and a TOOL span per tool call. A run resumed after a restart, in a new process, continues its trace.

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Laminar, laminarPiDurable } from "@lmnr-ai/lmnr";

Laminar.initialize();

const lmnr = laminarPiDurable({
  userId: "user-123",
  metadata: { app: "support-bot" },
  // sessionId defaults to Pi's per-conversation session id
});

const registry = createRegistry();
registry.install(myExtension);
registry.install(lmnr.extension); // last

const harness = await Harness.open(
  await openNodeSqliteStorage("./session.sqlite"),
  { models, registry, telemetry: lmnr.telemetry },
  BACKGROUND_CONTEXT,
);
```

- Both halves are needed: `telemetry` gives runs their trace (and carries it across restarts), and the extension's hooks record the LLM and TOOL spans. If a conversation selects its extensions explicitly (`settings.extensions` or `configure({ extensions: [...] })`), include `lmnr.extension`.
- Install `lmnr.extension` last (or list it last). Pi passes each `beforeRequest` hook the messages as the hooks before it changed them, so LLM spans only show what was really sent when Laminar's hook runs after every extension that changes requests.
- The extension is named `@lmnr-ai/lmnr`. Pi's `registry.install` replaces an installed extension of the same name, so don't give one of yours that name.
- To send agent traces to another project than the rest of the app, pass `projectApiKey` (or your own `tracerProvider`). `Laminar.initialize()` isn't needed then; call `await lmnr.shutdown()` before the process exits.
- Options: `sessionId` and `userId` (a string, or a function of the conversation), `metadata`, `spanNames` (`{ run, llm, tool }`, defaults `pi.run`, `pi.chat` and the tool name), and `systemPrompt` to report another system prompt than the one Pi sent.
- Pi's own `pi.durable.*` spans are not exported. Generation runs with tracing suppressed, so Laminar's OpenAI, Anthropic and Google instrumentations don't add a second LLM span for the SDK calls pi-ai makes.

Without code changes, `Laminar.initialize({ instrumentModules: { piDurable } })` patches `Harness.open` to pass the telemetry and install the extension in the Harness's registry, after the extensions already in it (if the registry already has a non-Laminar extension named `@lmnr-ai/lmnr`, Laminar warns and leaves it in place):

```typescript
import * as piDurable from "@earendil-works/pi-durable";

Laminar.initialize({ instrumentModules: { piDurable } });
```

pi-durable is ESM-only, so Laminar's `require` hook never sees it: pass the module as above, and initialize Laminar before the first `Harness.open()`. The patch changes the `Harness` object of the copy you pass. With Next.js, list `@earendil-works/pi-durable` in `serverExternalPackages`; if it is bundled instead, the app's bundled copy is not the one patched. When in doubt, use `laminarPiDurable()`.

## Evaluations

### Quickstart

Install the package:

```sh
npm install @lmnr-ai/lmnr
```

Create a file named `my-first-eval.ts` with the following code:

```javascript
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
- `groupName` – optional group name for evaluation. Evaluations within the same group can be compared visually side by side.
- `config` – optional additional override parameters.

\* If you already have the outputs of executors you want to evaluate, you can specify the executor as an identity function, that takes in `data` and returns only needed value(s) from it.

[Read docs](https://laminar.sh/docs/evaluations/introduction) to learn more about evaluations.

## Client for HTTP operations

Various interactions with Laminar API are available in `LaminarClient`. [Learn more](https://laminar.sh/docs/sdk/client)
