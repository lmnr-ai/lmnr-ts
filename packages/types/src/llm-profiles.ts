/**
 * Workspace LLM profile wire shapes (`/v1/cli/llm-profiles`, mirrored from
 * app-server's `LlmProfileResponse`). Self-hosted only; on Laminar Cloud every
 * route 404s with `{error: "LLM profiles are not available on this deployment"}`.
 */

export type LlmProfileProvider =
  | "openai_completions"
  | "openai_responses"
  | "gemini"
  | "bedrock"
  | "azure_chat_completions"
  | "azure_responses"
  | "azure_anthropic"
  | "custom";

/**
 * How the profile authenticates. `api_key` for every provider except Bedrock,
 * which takes AWS keys (secret arrives separately in `secrets`) or a bearer
 * token.
 */
export type LlmProfileAuth =
  | { type: "api_key" }
  | { type: "aws_keys"; accessKeyId: string }
  | { type: "bearer_token" };

/**
 * Non-secret provider options. The server normalizes per provider: absent
 * fields are omitted on the wire, never `null`.
 */
export interface LlmProfileConfig {
  auth: LlmProfileAuth;
  /** Bedrock. */
  region?: string;
  /** Azure: exactly one of `resourceId` / `baseUrl`. */
  resourceId?: string;
  /** Azure (alternative to `resourceId`) or `custom` (required). */
  baseUrl?: string;
  /** Azure. */
  apiVersion?: string;
  /** `custom`: header names whose values live in `secrets.headers`. */
  headerNames?: string[];
}

/**
 * What reads return instead of secrets: a `first3***last3` mask per stored
 * value (fully starred when short) and custom header names only.
 */
export interface LlmProfileSecretMasks {
  apiKey?: string;
  secretAccessKey?: string;
  token?: string;
  headers: string[];
}

export interface LlmProfile {
  id: string;
  workspaceId: string;
  name: string;
  provider: LlmProfileProvider;
  config: LlmProfileConfig;
  models: string[];
  secrets: LlmProfileSecretMasks;
  createdAt: string;
  updatedAt: string;
}
