/** Streaming response processing for Anthropic instrumentation. */

import type { CompleteStreamingResponse } from "./types";

/**
 * Process a single streaming event item and accumulate into the complete response.
 * Matches Python's _process_response_item.
 */
export const processResponseItem = (
  item: any,
  completeResponse: CompleteStreamingResponse,
): void => {
  try {
    if (item.type === "message_start") {
      completeResponse.model = item.message.model;
      const usage = { ...item.message.usage };
      completeResponse.usage = usage;
      completeResponse.service_tier = usage.service_tier ?? null;
      completeResponse.id = item.message.id;
    } else if (item.type === "content_block_start") {
      const index = item.index;
      if (completeResponse.events.length <= index) {
        const event: any = {
          index,
          text: "",
          type: item.content_block.type,
        };
        if (item.content_block.type === "tool_use") {
          event.id = item.content_block.id;
          event.name = item.content_block.name;
          event.input = "";
        }
        completeResponse.events.push(event);
      }
    } else if (item.type === "content_block_delta") {
      const index = item.index;
      if (index < completeResponse.events.length) {
        const event = completeResponse.events[index];
        if (item.delta.type === "thinking_delta") {
          event.text += item.delta.thinking ?? "";
        } else if (item.delta.type === "text_delta") {
          event.text += item.delta.text ?? "";
        } else if (item.delta.type === "input_json_delta") {
          event.input = (event.input ?? "") + item.delta.partial_json;
        }
      }
    } else if (item.type === "message_delta") {
      for (const event of completeResponse.events) {
        event.finish_reason = item.delta.stop_reason;
      }
      if (item.usage) {
        // message_delta usage values are cumulative, update/replace
        // Filter out null/undefined to avoid overwriting message_start data
        const usageUpdate: Record<string, unknown> = {};
        const rawUsage = typeof item.usage === "object" && item.usage !== null
          ? item.usage
          : {};
        for (const [k, v] of Object.entries(rawUsage)) {
          if (v !== null && v !== undefined) {
            usageUpdate[k] = v;
          }
        }
        completeResponse.usage = {
          ...completeResponse.usage,
          ...usageUpdate,
        };
      }
    }
  } catch {
    // silently ignore processing errors, matching Python's dont_throw pattern
  }
};

/**
 * Create a new empty complete response accumulator.
 */
export const createCompleteResponse = (): CompleteStreamingResponse => ({
  events: [],
  model: "",
  usage: {},
  id: "",
  service_tier: null,
});
