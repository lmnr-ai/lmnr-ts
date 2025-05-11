import { registerOTel } from '@vercel/otel';

export async function register() {
  // Only use this function if you want to send Next.js traces to DataDog or New Relic.
  // Otherwise, you can just use the `Laminar.initialize()` directly.
  registerOTel({
    serviceName: "therapy-service",
  });
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { Laminar } = await import("@lmnr-ai/lmnr");

    // Make sure this happens after any other OpenTelemetry initialization.
    Laminar.initialize();
  }
}
