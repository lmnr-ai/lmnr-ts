/**
 * Records the LangSmith runs still open when the process is about to exit.
 *
 * A run reaches Laminar when it ends, so a run cut off by the exit would be
 * lost, while LangSmith keeps it as in progress (it sent the run's create at
 * its start). Python does this with one `atexit` hook; Node has no single
 * exit point an asynchronous export can run in:
 *
 * - `beforeExit`: the event loop is empty, so a run still open never ends
 *   (an abandoned async generator, an awaited promise that never settles).
 *   The export keeps the loop alive; the event fires again afterwards, with
 *   nothing left to end.
 * - `SIGINT` / `SIGTERM`: Node exits at once by default, and any listener
 *   turns that off. So the hook acts only when it is the sole listener: it
 *   removes itself, exports (at most `SIGNAL_FLUSH_TIMEOUT_MS`), and raises
 *   the signal again, which now exits the way it would have. With another
 *   listener the app owns the signal, and `Laminar.shutdown()` in its
 *   handler ends the open runs (`LangSmithBridge.onShutdown`).
 * - `process.exit()` and `exit` listeners can't wait for an export: runs
 *   still open there are lost, like any span not yet exported.
 */
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../../utils";

const logger = initializeLogger();

const EXIT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

// A second Ctrl-C exits at once anyway: the hook is gone by then.
export const SIGNAL_FLUSH_TIMEOUT_MS = 3_000;

export class ExitHooks {
  private installed = false;

  /**
   * @param endOpenRuns emits the open runs and returns how many.
   * @param flush exports Laminar's pending spans.
   */
  constructor(
    private readonly endOpenRuns: () => number,
    private readonly flush: () => Promise<void>,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on("beforeExit", this.onBeforeExit);
    for (const signal of EXIT_SIGNALS) process.on(signal, this.onSignal);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.removeListener("beforeExit", this.onBeforeExit);
    for (const signal of EXIT_SIGNALS) {
      process.removeListener(signal, this.onSignal);
    }
  }

  private readonly onBeforeExit = (): void => {
    if (this.end() === 0) return;
    this.flush().catch((e: unknown) => {
      logger.debug(`LangSmith bridge exit flush failed: ${errorMessage(e)}`);
    });
  };

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    if (process.listenerCount(signal) > 1) return;
    this.uninstall();
    let raised = false;
    const exit = () => {
      if (raised) return;
      raised = true;
      process.kill(process.pid, signal);
    };
    if (this.end() === 0) {
      exit();
      return;
    }
    const timer = setTimeout(exit, SIGNAL_FLUSH_TIMEOUT_MS);
    this.flush()
      .catch((e: unknown) => {
        logger.debug(
          `LangSmith bridge flush on ${signal} failed: ${errorMessage(e)}`,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        exit();
      });
  };

  private end(): number {
    try {
      return this.endOpenRuns();
    } catch (e) {
      logger.debug(
        `LangSmith bridge: ending open runs failed: ${errorMessage(e)}`,
      );
      return 0;
    }
  }
}
