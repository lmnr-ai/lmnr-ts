/**
 * A workspace LLM profile as surfaced by the CLI discovery endpoint
 * (`GET /v1/cli/llm-profiles`). Self-hosted only; on Laminar Cloud the endpoint
 * 404s with `{error: "LLM profiles are not available on Laminar Cloud"}`.
 */
export interface LlmProfileOption {
  id: string;
  name: string;
  provider: string;
  models: string[];
}
