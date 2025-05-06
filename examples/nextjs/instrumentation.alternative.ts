import { registerOTel } from '@vercel/otel';

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { LaminarSpanProcessor, initializeLaminarInstrumentations } = await import("../../dist");
    registerOTel({
      serviceName: "therapy-service",
      spanProcessors: [
        new LaminarSpanProcessor({
          // ...
        }),
      ],
      instrumentations: initializeLaminarInstrumentations({
        // instrumentModules: {
        //   openai: OpenAI,
        // }
      })
    });

  }
}
