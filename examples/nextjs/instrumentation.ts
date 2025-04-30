export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // In a real application, do:
    // const { Laminar } = await import("@lmnr-ai/lmnr");
    const { Laminar } = await import("../../dist");
    Laminar.initialize({
      // Uncomment the following lint to show full Next.js traces, which may be noisy, but sometimes useful for debugging.
      // preserveNextJsSpans: true,
    });
  }
}
