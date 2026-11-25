/**
 * Child process for the bridge's exit tests (`langsmith-bridge.test.ts`): an
 * agent whose last LangSmith run never ends, then a process exit.
 *
 * Modes:
 * - `beforeExit`: the run awaits a promise that never settles, so the event
 *   loop empties.
 * - `signal`: the run waits on a long timer; the parent sends SIGINT.
 * - `signal-handled`: as `signal`, with the app's own SIGINT handler, which
 *   shuts Laminar down and exits with code 7.
 * - `signal-stream`: as `signal`, while a streamed response is still being
 *   read (`Laminar.flush()` would wait up to 5 s for it).
 *
 * Writes `ready` once the runs are open, and `exported <name> <incomplete>`
 * per span the exporter received (after a delay, so the line only appears if
 * the exit waited for the export). Writes are synchronous: the process may
 * end by a signal right after.
 */
import { writeSync } from "node:fs";

import { ExportResultCode } from "@opentelemetry/core";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

import { Laminar, LaminarSpanProcessor, observe } from "../../src/index";

const mode = process.argv[2];
const write = (line: string) => writeSync(1, `${line}\n`);

Laminar.initialize({
  projectApiKey: "test",
  bridges: ["langsmith"],
  spanProcessor: new LaminarSpanProcessor({
    // Batched, as by default: spans wait in the buffer until a flush.
    disableBatch: false,
    exporter: {
      export: (spans: any[], done: (result: any) => void) => {
        setTimeout(() => {
          for (const span of spans) {
            const incomplete = span.attributes["langsmith.run.incomplete"];
            write(`exported ${span.name} ${incomplete === true}`);
          }
          done({ code: ExportResultCode.SUCCESS });
        }, 100);
      },
      shutdown: () => Promise.resolve(),
    } as any,
  }),
});

if (mode === "signal-handled") {
  process.on("SIGINT", () => {
    void Laminar.shutdown().then(() => process.exit(7));
  });
}

const client = new Client({
  apiUrl: "http://langsmith.test",
  apiKey: "ls-test",
  fetchImplementation: (async () => Response.json({})) as typeof fetch,
});
const options = { client, tracingEnabled: true };
const lookup = traceable(async () => "found", {
  ...options,
  name: "lookup",
  run_type: "tool",
});
const stuck = traceable(
  () =>
    mode === "beforeExit"
      ? new Promise<void>(() => undefined)
      : new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
  { ...options, name: "stuck", run_type: "tool" },
);
const agent = traceable(
  async (_question: string) => {
    await lookup();
    await stuck();
  },
  { ...options, name: "agent" },
);

if (mode === "signal-stream") {
  // A stream that never ends, like an LLM response cut off by Ctrl-C.
  const stream = observe({ name: "stream" }, () =>
    (async function* () {
      yield "partial";
      await new Promise<void>(() => undefined);
    })(),
  );
  void (async () => {
    for await (const _ of stream) {
      // Read until the process exits.
    }
  })();
}

void agent("plan a trip");
setTimeout(() => write("ready"), 300);
