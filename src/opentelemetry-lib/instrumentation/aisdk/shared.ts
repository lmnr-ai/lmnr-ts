import { LanguageModelV3Content } from "@ai-sdk/provider";
import { LanguageModelV2Content } from "@ai-sdk/provider-v2";

export interface CachedSpanData {
  span: {
    name: string;
    input: string;
    output: string;
    attributes: Record<string, any>;
  };
  pathToCount: Record<string, number>;
  overrides?: Record<string, { system?: string; tools?: any[] }>;
}

/**
 * Converts output from span to content blocks compatible with both V2 and V3
 */
export const convertToContentBlocks = (
  output: string | Record<string, any>[],
): Array<LanguageModelV3Content | LanguageModelV2Content> => {
  if (typeof output === 'string') {
    return [{
      type: 'text',
      text: output,
    }];
  }

  const handleItem = (item: Record<string, any>): LanguageModelV3Content[] => {
    if (item.type === 'text') {
      return [{
        type: 'text',
        text: item.text ?? '',
      }];
    }
    if (['tool-call', 'tool_call'].includes(item.type)) {
      return [{
        type: 'tool-call',
        toolCallId: item.toolCallId ?? item.id,
        toolName: item.toolName ?? item.name,
        input: JSON.stringify(item.input ?? item.arguments),
      }];
    }
    if (item.type === 'reasoning') {
      return [{
        type: 'reasoning',
        text: item.text ?? '',
      }];
    }
    return [{
      type: 'text',
      text: JSON.stringify(item),
    }];
  };

  return output.flatMap(item => {
    if (item.role && item.content) {
      let parsedContent: Record<string, any>[] = item.content;
      try {
        parsedContent = JSON.parse(item.content);
      } catch {
        if (typeof item === 'string') {
          return [{
            type: 'text',
            text: item,
          }];
        }
      }
      return parsedContent.flatMap(handleItem);
    }
    return handleItem(item);
  });
};

/**
 * Fetches cached span data from the local rollout cache server
 */
export async function fetchCachedSpan(
  path: string,
  index: number,
): Promise<CachedSpanData | undefined> {
  const serverUrl = process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS;
  if (!serverUrl) {
    return;
  }

  try {
    const response = await fetch(`${serverUrl}/cached`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, index }),
    });

    if (!response.ok) {
      // 404 means cache miss
      return;
    }

    return await response.json() as CachedSpanData;
  } catch {
    // Network error or other issues - return undefined to fall back to original model
    return;
  }
}
