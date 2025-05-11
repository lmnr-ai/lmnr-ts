# Example Next.js app using AI SDK instrumented with Laminar

This is a very simplistic chat UI app that mimics emotional support helpline/therapist.

This does not store any information in the database or any storage, only works for demo purposes.

For LLM calls, the app uses Vercel's AI SDK.

## Installation

### 1. Clone the repository

```
git clone https://github.com/lmnr-ai/lmnr-ts
```

### 2. Open the directory

```
cd lmnr-ts/examples/nextjs-aisdk
```

### 3. Set up the environment variables

```
cp .env.local.example .env.local
```

And then fill in the `.env.local` file. Get [Laminar project API key](https://docs.lmnr.ai/tracing/introduction#2-initialize-laminar-in-your-application). Get [OpenAI API key](https://platform.openai.com/api-keys)

### 4. Install the dependencies

```
npm i
```

or `pnpm i`

### 5. [Optional] In real-world apps

Don't forget to properly install Laminar from npm. In package.json, replace

```
"@lmnr-ai/lmnr": "file:../../dist"
```
with the latest version of Laminar, e.g.

```
"@lmnr-ai/lmnr": "^0.6"
```

and then `npm i` again

## Run the app

```
npm run dev
```

## Test the call with the UI

Navigate to `http://localhost:3000` and interact with the UI.

## See the results on Laminar dashboard

In your browser, open https://www.lmnr.ai, navigate to your project's traces page, and you will see the auto-instrumented AI SDK span containing OpenAI span

## Understanding Laminar tracing in detail

### `registerOTel` from `@vercel/otel`.

This function is the main entrypoint to OpenTelemetry tracing of your Next.js app. It is a flexible configurable function that (among other things) does the following:

- Initialize the Next.js and underlying node/fetch/undici instrumentations,
- Configure default trace export destination to DataDog or New Relic, as described in Vercel's [docs](https://vercel.com/docs/otel).

#### Do I need this function?

If you only need the Laminar tracing, you can skip the `registerOTel` initialization. We've only added it to this example, so that you can see how `@vercel/otel` and `Laminar.initialize()` work together.

### `Laminar.initialize()`

This function is similar to register OTel, but it configures instrumentations and destinations differently. It does the following

- Initialize the LLM and browser instrumentations as you specify in `instrumentModules`,
- Configure default trace export destination to Laminar cloud,
- Try to register this in the least intrusive way possible.

### `getTracer` from `@lmnr-ai/lmnr`

This function exposes Laminar tracer if one has been created by calling `Laminar.initialize()` or a global OpenTelemetry tracer otherwise.

#### Why do I have to pass this to every call to AI SDK?

AI SDK manages its own instrumentation internally and can create traces and spans as needed using a global OpenTelemetry tracer.

Laminar could register its tracer globally as the default in OpenTelemetry, but this causes nasty conflicts with other OpenTelemetry providers, such as Sentry or (default setup of) `@vercel/otel`. To avoid this, we made our SDK least intrusive, but you need to pass the Laminar tracer to AI SDK calls.

### [Advanced] Why do I need to place `Laminar.initialize()` after other tracing initializations?

OpenTelemetry has the concept of ContextManager, which is the main singleton entrypoint to all `context` OpenTelemetry API interactions. This can be set once globally in the process lifetime. Subsequent attempts to set a new global context manager will have no effect on the app, and will log an error.

Similarly to this, a full tracing library also needs to setup a global tracer provider and propagator in the app.

Most tracing SDKs, such as `@sentry/node` or `@vercel/otel` set the context manager, tracer provider, and propagator globally always. In contrast, Laminar does not register the tracer provider globally and makes best effort to connect to an existing context manager, only creating one if there is none.

That is, if you initialize another tracing SDK after Laminar, it is likely that Laminar has created its own context manager by that time, and another library trying to do so will cause conflicts. If you initialize Laminar after the other tracing libraries, Laminar will just try to connect to the context manager created by other libraries.

### [Advanced] Other tracing options, `LaminarSpanProcessor`, and `instrumentation.alternative.ts`.

If you want your existing tracing SDK to send all the data to Laminar (exclusively, or in addition to its existing destinations), you can configure that using `LaminarSpanProcessor`. For example,

```javascript instrumentation.alternative.ts
const { LaminarSpanProcessor } = await import("@lmnr-ai/lmnr");
registerOTel({
    serviceName: "therapy-service",
    spanProcessors: [
        new LaminarSpanProcessor({
            // ...
        }),
    ],
});
```

In this example, Laminar span processor will make sure traces created by the default `@vercel/otel` instrumentations are sent to the Laminar backend (or as you configure at the SpanProcessor initialization).

#### LaminarSpanProcessor

By default, Laminar span processor sends the data to Laminar cloud using an OTLP/grpc exporter.


Configuring Laminar span processor to send traces to self-hosted Laminar instance. Also see [Laminar self-hosting docs](https://docs.lmnr.ai/self-hosting)

```javascript
new LaminarSpanProcessor({
    baseUrl: 'http://laminar.your-domain.com',
    port: 8001, // your custom gRPC port
})
```

Configuring Laminar span processor to export to a custom backend.

```javascript
new LaminarSpanProcessor({
    baseUrl: 'http://your-domain.com',
    port: 8001, // HTTP port
    forceHttp: true, // most OTel backends are HTTP, so set this flag to true.
});
```

Configuring Laminar span processor to not batch the spans to export.

```javascript
new LaminarSpanProcessor({
    disableBatch: true,
})
```

#### [Advanced] What is a span processor and a span exporter?

**Span exporter** is an OpenTelemetry object that is responsible for encoding finished spans and sending them to the backend. Exporters carry the information about the backend, such as the endpoint and port. In addition, exporters differ by type based on the encoding that a backend accepts. To learn more about the encodings, read our docs on [exporters](https://docs.lmnr.ai/tracing/otel#exporters). Default Laminar span exporter is OTLP/gRPC configured to send data to `https://api.lmnr.ai:8443`.

**Span processor** is an OpenTelemetry object that is responsible for pre-processing spans before export. One span processor may have one span exporter, and span processors are responsible for calling `export` methods on exporters, when they are ready to export spans. Exporters may batch spans before exporting or sending spans as soon as they are finished. Most of the pre-processing happens in `onStart` on span processors. Laminar span processor adds Laminar specific attributes on spans.
