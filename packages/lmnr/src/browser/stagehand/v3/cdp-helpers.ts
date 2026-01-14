import { SessionRecordingOptions } from "@lmnr-ai/types";

import { RECORDER } from "../../recorder";
import { injectScript } from "../../utils";
import {
  CDP_OPERATION_TIMEOUT_MS,
  logger,
  SKIP_URL_PATTERNS,
} from "./constants";
import {
  type FrameTree,
  type RuntimeBindingCalledEvent,
  type RuntimeEvaluateResult,
  type StagehandCdpConnection,
  type StagehandV3Page,
  type V3RecorderState,
} from "./types";

/**
 * Check if a URL should be skipped for recording (error pages, blank pages, etc.)
 */
export function shouldSkipUrl(url: string): boolean {
  if (!url) return true;
  return SKIP_URL_PATTERNS.some(pattern => url.startsWith(pattern));
}

/**
 * Create an isolated world for a page and return the execution context ID
 */
export async function getOrCreateIsolatedWorld(
  page: StagehandV3Page,
): Promise<{ contextId: number; frameId: string } | null> {
  try {
    // Get the frame tree to find the main frame
    const frameTreeResult = await Promise.race([
      page.sendCDP<{ frameTree: FrameTree }>("Page.getFrameTree"),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout getting frame tree")), CDP_OPERATION_TIMEOUT_MS),
      ),
    ]);

    if (!frameTreeResult) return null;

    const frameId = frameTreeResult.frameTree.frame.id;

    // Create isolated world
    const isolatedWorldResult = await Promise.race([
      page.sendCDP<{ executionContextId: number }>("Page.createIsolatedWorld", {
        frameId,
        worldName: "laminar-recorder",
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(
          new Error("Timeout creating isolated world")), CDP_OPERATION_TIMEOUT_MS,
        ),
      ),
    ]);

    if (!isolatedWorldResult) return null;

    return {
      contextId: isolatedWorldResult.executionContextId,
      frameId,
    };
  } catch (error) {
    logger.debug("Failed to create isolated world: " +
      `${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Check if the session recorder is already present in the page
 */
export async function isRecorderPresent(
  page: StagehandV3Page,
  contextId: number,
): Promise<boolean> {
  try {
    const result = await Promise.race([
      page.sendCDP<RuntimeEvaluateResult>("Runtime.evaluate", {
        expression: "typeof window.lmnrRrweb !== 'undefined'",
        contextId,
        returnByValue: true,
      }),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout checking recorder")), CDP_OPERATION_TIMEOUT_MS),
      ),
    ]);

    if (!result) return true; // On timeout, assume present to avoid double injection
    return result.result?.value === true;
  } catch (error) {
    logger.debug("Failed to check if recorder is present: " +
      `${error instanceof Error ? error.message : String(error)}`);
    return true; // On error, assume present to be safe
  }
}

/**
 * Inject the session recorder into a page using CDP
 */
export async function injectRecorderViaCDP(
  page: StagehandV3Page,
  state: V3RecorderState,
  conn: StagehandCdpConnection,
  sessionRecordingOptions?: SessionRecordingOptions,
  bindingHandler?: (event: RuntimeBindingCalledEvent) => void,
): Promise<number | null> {
  try {
    // Check if we should skip this page
    let url: string;
    try {
      url = page.url();
    } catch (error) {
      logger.debug("Failed to get page URL, page might be closed: " +
        `${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    if (shouldSkipUrl(url)) {
      logger.debug(`Skipping recorder injection for URL: ${url}`);
      return null;
    }

    // Get or create isolated world
    const worldResult = await getOrCreateIsolatedWorld(page);
    if (!worldResult) {
      logger.debug("Failed to get isolated world for page");
      return null;
    }

    const { contextId, frameId } = worldResult;

    // Check if already injected
    if (await isRecorderPresent(page, contextId)) {
      logger.debug("Recorder already present, skipping injection");
      // Still register the context mapping
      state.contextIdToSession.set(contextId, {
        sessionId: state.sessionId,
        traceId: state.traceId,
      });
      return contextId;
    }

    // Inject rrweb base
    try {
      await page.sendCDP("Runtime.evaluate", {
        expression: RECORDER,
        contextId,
      });
    } catch (error) {
      logger.debug("Failed to inject rrweb: " +
        `${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    // Inject recording setup script using the existing injectScript function
    // Convert function to string and create an IIFE with options
    // Pass true for stringifyCallbackArgs since CDP bindings require stringified arguments
    const optionsJson = JSON.stringify(sessionRecordingOptions ?? {});
    const injectExpression = `(${injectScript.toString()})(${optionsJson}, true);`;
    try {
      await page.sendCDP("Runtime.evaluate", {
        expression: injectExpression,
        contextId,
      });
    } catch (error) {
      logger.debug("Failed to inject recording setup: " +
        `${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    // Add binding globally (not scoped to execution context)
    // The Runtime.bindingCalled event will include the executionContextId
    try {
      await page.sendCDP("Runtime.addBinding", {
        name: "lmnrSendEvents",
      });
      logger.debug(`Added binding 'lmnrSendEvents' for page ${frameId}, context ${contextId}`);
    } catch (error) {
      // Binding might already exist, that's ok
      logger.debug("Binding may already exist: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }

    // Set up binding handler on this page using the internal Stagehand CDP session
    // The page.sendCDP method goes through the page's mainSession, so we need to listen there
    // We can access the session through the connection's internal structure
    if (bindingHandler) {
      try {
        const pageTargetId = page.targetId();
        if (!state.pageSessionHandlers.has(pageTargetId)) {
          // Access the connection's sessions map to find the session for this page
          const connInternal = conn as unknown as {
            getSession(sessionId: string): {
              on<P>(event: string, handler: (params: P) => void): void
            } | undefined;
            sessions: Map<string, unknown>;
          };

          // In Stagehand v3, each page has a corresponding session
          // We need to find the session that owns this page/target
          // The session for a page target is tracked in the context
          // We can iterate sessions and try to set up the listener
          if (connInternal.sessions) {
            for (const [sessionId, session] of connInternal.sessions.entries()) {
              try {
                // Set up the handler on each session (the correct one will receive the events)
                const sessionTyped = session as {
                  on<P>(event: string, handler: (params: P) => void): void
                };
                if (sessionTyped.on) {
                  sessionTyped.on<RuntimeBindingCalledEvent>(
                    "Runtime.bindingCalled",
                    bindingHandler,
                  );
                  logger.debug(`Set up binding handler on session ${sessionId}`);
                }
              } catch (error) {
                // Session might be closed, continue with next session
                logger.debug(`Failed to set up binding handler on session ${sessionId}: ` +
                  `${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          state.pageSessionHandlers.set(pageTargetId, bindingHandler);
        }
      } catch (error) {
        logger.debug("Failed to set up binding handler: " +
          `${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Register context mapping
    state.contextIdToSession.set(contextId, {
      sessionId: state.sessionId,
      traceId: state.traceId,
    });
    logger.debug(
      `Registered context mapping: contextId=${contextId}, sessionId=${state.sessionId}`,
    );

    // Mark page as instrumented
    state.instrumentedPageIds.add(frameId);

    logger.debug(`Successfully injected recorder into page ${frameId}`);
    return contextId;
  } catch (error) {
    logger.debug("Error injecting recorder: " +
      `${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
