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
import {
  type Bridge,
  type BridgeContext,
  type InstrumentationKey,
} from "../types";
import { LangSmithRunRecorder } from "./runs";
import {
  isSupportedVersion,
  LangSmithTap,
  langsmithCopies,
  MIN_LANGSMITH_VERSION,
} from "./tap";

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

  isAvailable(): boolean {
    try {
      const clients = langsmithCopies().filter((copy) => copy.client);
      if (clients.some((copy) => isSupportedVersion(copy.version))) {
        return true;
      }
      if (clients.length > 0) {
        logger.warn(
          `Laminar langsmith bridge: needs langsmith >= ${MIN_LANGSMITH_VERSION}, ` +
            `found ${clients.map((copy) => copy.version).join(", ")}; skipping.`,
        );
        return false;
      }
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
    const tap = new LangSmithTap(new LangSmithRunRecorder());
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
    tap.installImported().catch((e: unknown) => {
      logger.debug(
        `Laminar langsmith bridge: patching imported copies failed: ${errorMessage(e)}`,
      );
    });
    logger.debug("Laminar langsmith bridge installed");
  }

  uninstall(): void {
    try {
      this.tap?.uninstall();
    } catch (e) {
      logger.debug(
        `Failed to uninstall the Laminar langsmith bridge: ${errorMessage(e)}`,
      );
    } finally {
      this.tap = undefined;
    }
  }
}
