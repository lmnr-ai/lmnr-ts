/**
 * LangSmith → Laminar bridge (`Laminar.initialize({ bridges: ["langsmith"] })`).
 *
 * LangSmith's SDK isn't built on OpenTelemetry: it sends runs to LangSmith's
 * REST API. The bridge taps the runs in process, at the point where
 * LangSmith's client has sampled and redacted them and is about to queue them
 * for sending, and records each one as a Laminar span. What LangSmith sends
 * is unchanged.
 *
 * - `tap.ts`: where and how the LangSmith SDK is hooked.
 * - `runs.ts`: merging a run's create and update halves into one span.
 * - `translate.ts`: pure run → Laminar attribute conversions.
 */
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../../utils";
import { getSpanProcessor } from "../../tracing/index";
import {
  type Bridge,
  type BridgeContext,
  type InstrumentationKey,
} from "../types";
import { ExitHooks } from "./exit";
import { LangSmithRunRecorder } from "./runs";
import { LangSmithTap, langsmithCopies } from "./tap";

const logger = initializeLogger();

export class LangSmithBridge implements Bridge {
  readonly name = "langsmith" as const;
  /**
   * What LangSmith's wrappers, integrations and LangChain tracer record:
   * provider SDK calls (directly or under LangChain chat models), LangChain
   * and LangGraph runs, and the agent SDKs LangSmith integrates with
   * (`wrapClaudeAgentSDK`, the OpenAI Agents processor). Same set as
   * lmnr-python's `LangSmithBridge.conflicting_instruments`, less the
   * instruments TS doesn't have.
   */
  readonly conflictingInstrumentations: readonly InstrumentationKey[] = [
    "OpenAI",
    "anthropic",
    "cohere",
    "google_genai",
    "google_aiplatform",
    "openrouter",
    "langchain",
    "openAIAgents",
    "claudeAgentSDK",
  ];
  readonly inheritsGlobalContext = false;

  private tap: LangSmithTap | undefined;
  private recorder: LangSmithRunRecorder | undefined;
  private exitHooks: ExitHooks | undefined;

  isAvailable(): boolean {
    try {
      if (langsmithCopies().some((copy) => copy.client)) return true;
    } catch (e) {
      logger.debug(`Laminar langsmith bridge: ${errorMessage(e)}`);
    }
    logger.warn(
      "Laminar langsmith bridge: the langsmith package could not be " +
        "resolved from @lmnr-ai/lmnr or the working directory, skipping.",
    );
    return false;
  }

  install(_ctx: BridgeContext): void {
    this.uninstall();
    const recorder = new LangSmithRunRecorder();
    const tap = new LangSmithTap(recorder);
    try {
      if (!tap.install()) {
        tap.uninstall();
        return;
      }
    } catch (e) {
      logger.warn(
        `Failed to install the Laminar langsmith bridge: ${errorMessage(e)}`,
      );
      tap.uninstall();
      return;
    }
    this.tap = tap;
    this.recorder = recorder;
    // Runs still open when the process exits are recorded as incomplete.
    // Flush the processor itself: `forceFlush()` first waits up to 5 s for
    // pending streams, which never finish once the process is exiting (Ctrl-C
    // mid-response), and would outlast the signal path's 3 s cap.
    this.exitHooks = new ExitHooks(
      () => recorder.endOpenRuns(),
      async () => {
        await getSpanProcessor()?.forceFlush();
      },
    );
    this.exitHooks.install();
    tap.installImported().catch((e: unknown) => {
      logger.debug(
        `Laminar langsmith bridge: patching imported copies failed: ${errorMessage(e)}`,
      );
    });
    logger.debug("Laminar langsmith bridge installed");
  }

  /**
   * Record the runs that haven't ended as incomplete, before Laminar's final
   * flush: once the bridge is uninstalled, their updates can't arrive.
   */
  onShutdown(): void {
    try {
      const ended = this.recorder?.endOpenRuns() ?? 0;
      if (ended > 0) {
        logger.debug(`Laminar langsmith bridge: ${ended} runs had not ended`);
      }
    } catch (e) {
      logger.debug(
        `Laminar langsmith bridge: ending open runs failed: ${errorMessage(e)}`,
      );
    }
  }

  uninstall(): void {
    try {
      this.exitHooks?.uninstall();
      this.tap?.uninstall();
    } catch (e) {
      logger.debug(
        `Failed to uninstall the Laminar langsmith bridge: ${errorMessage(e)}`,
      );
    } finally {
      this.tap = undefined;
      this.recorder = undefined;
      this.exitHooks = undefined;
    }
  }
}
