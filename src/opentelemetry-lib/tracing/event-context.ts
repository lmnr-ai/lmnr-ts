import { isSpanContextValid, trace } from "@opentelemetry/api";

const MAX_CONTEXTS = 1000;
const LaminarEventContext = new Map<string, {
  sessionId?: string,
  userId?: string,
  lastAccessed: number,
}>();

const cleanupOldEntries = () => {
  if (LaminarEventContext.size >= MAX_CONTEXTS) {
    // Remove oldest 10% of entries to make room
    const entries = Array.from(LaminarEventContext.entries())
      .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
    const entriesToRemove = Math.floor(MAX_CONTEXTS * 0.1);
    for (let i = 0; i < entriesToRemove; i++) {
      LaminarEventContext.delete(entries[i][0]);
    }
  }
};

export const getEventAttributesFromCurrentContext = (): Record<string, string> => {
  const currentSpan = trace.getActiveSpan();
  const attributes: Record<string, string> = {};
  if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
    const traceId = currentSpan.spanContext().traceId;
    if (traceId !== undefined) {
      const laminarEventContext = LaminarEventContext.get(traceId);
      if (laminarEventContext) {
        // Update last accessed time for LRU
        laminarEventContext.lastAccessed = Date.now();

        if (laminarEventContext.sessionId !== undefined) {
          attributes["lmnr.event.session_id"] = laminarEventContext.sessionId;
        }
        if (laminarEventContext.userId !== undefined) {
          attributes["lmnr.event.user_id"] = laminarEventContext.userId;
        }
      }
    }
  }
  return attributes;
};


export const setLaminarEventContext = ({
  sessionId,
  userId,
}: {
  sessionId?: string,
  userId?: string,
}) => {
  const currentSpan = trace.getActiveSpan();
  if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
    const traceId = currentSpan.spanContext().traceId;
    if (traceId !== undefined) {
      const existingContext = LaminarEventContext.get(traceId);
      const existingSessionId = existingContext?.sessionId;
      const existingUserId = existingContext?.userId;

      // Clean up old entries if we're at the limit
      cleanupOldEntries();

      LaminarEventContext.set(traceId, {
        sessionId: sessionId ?? existingSessionId,
        userId: userId ?? existingUserId,
        lastAccessed: Date.now(),
      });
    }
  }
};
