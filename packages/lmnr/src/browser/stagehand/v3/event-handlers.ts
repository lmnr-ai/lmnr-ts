import { type SessionRecordingOptions, type StringUUID } from "@lmnr-ai/types";

import { EventChunk, sendEvents } from "../../utils";
import { injectRecorderViaCDP, shouldSkipUrl } from "./cdp-helpers";
import { logger } from "./constants";
import {
  RuntimeBindingCalledEvent,
  StagehandV3Context,
  TargetCreatedEvent,
  TargetInfoChangedEvent,
  V3RecorderState,
} from "./types";

/**
 * Handle Runtime.bindingCalled events
 */
export function createBindingHandler(
  state: V3RecorderState,
): (event: RuntimeBindingCalledEvent) => void {
  return (event: RuntimeBindingCalledEvent) => {
    if (event.name !== "lmnrSendEvents") return;
    const sessionInfo = state.contextIdToSession.get(event.executionContextId);
    if (!sessionInfo) {
      logger.debug("No session info found for context ID: " + event.executionContextId);
      // Try to find any matching session (for cases where context ID changed)
      // This is a fallback - normally the context should be mapped
      if (state.contextIdToSession.size > 0) {
        // Use the first available session info as fallback
        const [, fallbackInfo] = state.contextIdToSession.entries().next().value as
          [number, { sessionId: StringUUID; traceId: StringUUID }];
        if (fallbackInfo) {
          try {
            const chunk = JSON.parse(event.payload) as EventChunk;
            void sendEvents(
              chunk,
              state.client,
              state.chunkBuffers,
              fallbackInfo.sessionId,
              fallbackInfo.traceId,
            );
          } catch (error) {
            logger.debug("Failed to parse binding payload: " +
              `${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return;
    }

    try {
      const chunk = JSON.parse(event.payload) as EventChunk;
      void sendEvents(
        chunk,
        state.client,
        state.chunkBuffers,
        sessionInfo.sessionId,
        sessionInfo.traceId,
      );
    } catch (error) {
      logger.debug("Failed to handle binding event: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * Handle Target.targetCreated events for new pages
 */
export function createTargetCreatedHandler(
  context: StagehandV3Context,
  state: V3RecorderState,
  sessionRecordingOptions?: SessionRecordingOptions,
): (event: TargetCreatedEvent) => Promise<void> {
  return async (event: TargetCreatedEvent) => {
    try {
      if (event.targetInfo.type !== "page") return;

      // Wait a bit for the page to be available in the context
      await new Promise(resolve => setTimeout(resolve, 200));
      // Try to inject into all uninstrumented pages
      for (const page of context.pages()) {
        try {
          const pageId = page.mainFrameId();
          if (!state.instrumentedPageIds.has(pageId)) {
            await injectRecorderViaCDP(
              page,
              state,
              context.conn,
              sessionRecordingOptions,
              state.bindingHandler ?? undefined,
            );
          }
        } catch (error) {
          // Page might have been closed or CDP session lost, continue with next page
          logger.debug("Error injecting recorder into new page: " +
            `${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      logger.debug("Error handling target created event: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * Handle Target.targetInfoChanged events for URL changes/navigation
 */
export function createTargetInfoChangedHandler(
  context: StagehandV3Context,
  state: V3RecorderState,
  sessionRecordingOptions?: SessionRecordingOptions,
): (event: TargetInfoChangedEvent) => Promise<void> {
  return async (event: TargetInfoChangedEvent) => {
    // Only handle page targets
    if (event.targetInfo.type !== "page") return;

    const url = event.targetInfo.url;

    if (shouldSkipUrl(url)) return;

    logger.debug(`Target URL changed to ${url}, checking if recorder injection needed`);

    await new Promise(resolve => setTimeout(resolve, 150));

    try {
      for (const page of context.pages()) {
        // Try to match by target ID
        const targetId = page.targetId();
        if (targetId === event.targetInfo.targetId) {
          await injectRecorderViaCDP(
            page, state, context.conn, sessionRecordingOptions, state.bindingHandler ?? undefined,
          );
          break;
        }
      }
    } catch (error) {
      logger.debug("Error handling target info change: " +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
