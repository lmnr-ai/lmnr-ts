import { registerOTel } from '@vercel/otel';

export async function register() {
  // Only use this function if you want to send Next.js traces to DataDog or New Relic.
  // Otherwise, you can just use the `Laminar.initialize()` directly.
  registerOTel({
    serviceName: "therapy-service",
  });
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // In a real application, do:
    // const { Laminar } = await import("@lmnr-ai/lmnr");
    const { Laminar } = await import("../../dist");

    // Make sure this happens after any other OpenTelemetry initialization.
    Laminar.initialize();
  }
}
