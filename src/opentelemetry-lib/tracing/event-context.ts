import { isSpanContextValid, trace } from "@opentelemetry/api";

const LaminarEventContext: Record<string, {
  sessionId?: string,
  userId?: string,
}> = {};

export const getEventAttributesFromCurrentContext = (): Record<string, string> => {
  const currentSpan = trace.getActiveSpan();
  const attributes: Record<string, string> = {};
  if (currentSpan !== undefined && isSpanContextValid(currentSpan.spanContext())) {
    const traceId = currentSpan.spanContext().traceId;
    if (traceId !== undefined) {
      const laminarEventContext = LaminarEventContext[traceId];
      if (laminarEventContext?.sessionId !== undefined) {
        attributes["lmnr.event.session_id"] = laminarEventContext.sessionId;
      }
      if (laminarEventContext?.userId !== undefined) {
        attributes["lmnr.event.user_id"] = laminarEventContext.userId;
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
      const existingSessionId = LaminarEventContext[traceId]?.sessionId;
      const existingUserId = LaminarEventContext[traceId]?.userId;
      LaminarEventContext[traceId] = {
        sessionId: sessionId ?? existingSessionId,
        userId: userId ?? existingUserId,
      };
    }
  }
};
