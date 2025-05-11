import { registerOTel } from '@vercel/otel';

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { LaminarSpanProcessor } = await import("@lmnr-ai/lmnr");
    registerOTel({
      serviceName: "therapy-service",
      spanProcessors: [
        new LaminarSpanProcessor({
          // ...
        }),
      ],
    });

  }
}
