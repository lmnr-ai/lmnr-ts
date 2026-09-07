import type { LlmProfileSecretsInput } from "@lmnr-ai/client";
import type { LlmProfileAuth, LlmProfileConfig } from "@lmnr-ai/types";

/**
 * Provider-shape flags shared by `llm-profile create` and `update`. Validation
 * (which flags a provider needs, url shapes, secret completeness) is entirely
 * server-side; the CLI only assembles the wire body and surfaces errors
 * verbatim.
 */
export type LlmProfileShapeOpts = {
  provider?: string;
  /** Repeatable; the profile's model list (replaced wholesale on update). */
  model?: string[];
  apiKey?: string;
  /** Bedrock AWS-keys auth (with --secret-access-key). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Bedrock bearer-token auth. */
  token?: string;
  /** Bedrock region. */
  region?: string;
  /** Azure resource id (alternative to --provider-base-url). */
  resourceId?: string;
  /**
   * Provider endpoint for azure/custom. Named apart from the group-level
   * --base-url, which is the Laminar API URL.
   */
  providerBaseUrl?: string;
  apiVersion?: string;
  /** Repeatable `Name=Value` custom headers (custom provider). */
  header?: string[];
};

/** `Name=Value` (first `=` splits; the value may contain more of them). */
export const parseHeaderFlag = (raw: string): [string, string] => {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`--header must be Name=Value, got "${raw}"`);
  }
  return [raw.slice(0, eq).trim(), raw.slice(eq + 1)];
};

/**
 * Map the shape flags onto the wire `config` / `secrets` objects. Either is
 * `undefined` when none of its flags were passed, so update sends nothing and
 * keeps the stored value (config is a whole-object replace server-side, secrets
 * an overlay). Auth is derived: `--access-key-id` → aws_keys, `--token` →
 * bearer_token, else omitted (server defaults to api_key).
 */
export const buildProfileConfigAndSecrets = (
  opts: LlmProfileShapeOpts,
): {
  config?: Partial<LlmProfileConfig>;
  secrets?: LlmProfileSecretsInput;
} => {
  const headers: Record<string, string> = {};
  for (const raw of opts.header ?? []) {
    const [name, value] = parseHeaderFlag(raw);
    headers[name] = value;
  }
  const headerNames = Object.keys(headers);

  const auth: LlmProfileAuth | undefined =
    opts.accessKeyId !== undefined
      ? { type: "aws_keys", accessKeyId: opts.accessKeyId }
      : opts.token !== undefined
        ? { type: "bearer_token" }
        : undefined;

  const config: Partial<LlmProfileConfig> = {
    ...(auth !== undefined ? { auth } : {}),
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
    ...(opts.providerBaseUrl !== undefined
      ? { baseUrl: opts.providerBaseUrl }
      : {}),
    ...(opts.apiVersion !== undefined ? { apiVersion: opts.apiVersion } : {}),
    ...(headerNames.length > 0 ? { headerNames } : {}),
  };

  const secrets: LlmProfileSecretsInput = {
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.secretAccessKey !== undefined
      ? { secretAccessKey: opts.secretAccessKey }
      : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(headerNames.length > 0 ? { headers } : {}),
  };

  return {
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
};
