# Example Next.js app instrumented with Laminar

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
cd lmnr-ts/examples/nextjs
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

Don't forget that in `instrumentation.ts` Laminar TS SDK is imported from local dist,
and you need to replace it with `const { Laminar } = await import("@lmnr-ai/lmnr");` if you copy this setup to other apps.

## Run the app

```
npm run dev
```

## Test the call with curl

Navigate to `http://localhost:3000` and interact with theu UI.

## See the results on Laminar dashboard

In your browser, open https://www.lmnr.ai, navigate to your project's traces page, and you will see the auto-instrumented AI SDK span containing OpenAI span
