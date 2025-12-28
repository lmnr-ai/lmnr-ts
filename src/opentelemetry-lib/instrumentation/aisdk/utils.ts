import { type LanguageModelV3Message,type LanguageModelV3Prompt } from "@ai-sdk/provider";
import { type LanguageModelV2Message,type LanguageModelV2Prompt } from "@ai-sdk/provider-v2";
import { DataContent } from "ai";

// Mirrors https://github.com/vercel/ai/blob/main/packages/ai/src/telemetry/stringify-for-telemetry.ts
// This function is initially implemented by us, and is not exported from the ai sdk.
// We copy it here for our own use.
export const stringifyPromptForTelemetry =
  (prompt: LanguageModelV2Prompt | LanguageModelV3Prompt): string =>
    JSON.stringify(
      prompt.map((message: LanguageModelV2Message | LanguageModelV3Message) => ({
        ...message,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(part =>
              part.type === 'file'
                ? {
                  ...part,
                  data:
                    part.data instanceof Uint8Array
                      ? convertDataContentToBase64String(part.data)
                      : part.data,
                }
                : part,
            ),
      })),
    );

/**
Converts data content to a base64-encoded string.

@param content - Data content to convert.
@returns Base64-encoded string.
*/
const convertDataContentToBase64String = (content: DataContent): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return convertUint8ArrayToBase64(new Uint8Array(content));
  }

  return convertUint8ArrayToBase64(content);
};

export function convertUint8ArrayToBase64(array: Uint8Array): string {
  let latin1string = '';

  // Note: regular for loop to support older JavaScript versions that
  // do not support for..of on Uint8Array
  for (let i = 0; i < array.length; i++) {
    latin1string += String.fromCodePoint(array[i]);
  }

  return btoa(latin1string);
}
