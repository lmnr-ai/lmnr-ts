const DEFAULT_VENDOR = "langchain";

/**
 * Lower-cased class-name substrings → `gen_ai.system` vendor, in priority
 * order (`AzureChatOpenAI` must match azure before openai).
 */
const VENDOR_RULES: [patterns: string[], vendor: string][] = [
  [["azure"], "azure.ai.openai"],
  [["openai"], "openai"],
  [["bedrock", "aws"], "aws.bedrock"],
  [["anthropic"], "anthropic"],
  [["vertex"], "gcp.vertex_ai"],
  [["google", "gemini"], "gcp.gen_ai"],
  [["cohere"], "cohere"],
  [["huggingface"], "hugging_face"],
  [["ollama"], "ollama"],
  [["together"], "together_ai"],
  [["replicate"], "replicate"],
  [["fireworks"], "fireworks"],
  [["groq"], "groq"],
  [["mistral"], "mistral_ai"],
];

/**
 * Map a LangChain model class name (e.g. `ChatOpenAI`) onto the
 * `gen_ai.system` vendor string, or `"langchain"` when unknown.
 */
export const detectVendorFromClass = (className?: string): string => {
  if (!className) {
    return DEFAULT_VENDOR;
  }
  const lower = className.toLowerCase();
  for (const [patterns, vendor] of VENDOR_RULES) {
    if (patterns.some((pattern) => lower.includes(pattern))) {
      return vendor;
    }
  }
  return DEFAULT_VENDOR;
};
