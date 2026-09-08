import type {
  CreateLlmProfileOptions,
  LaminarClient,
  UpdateLlmProfileOptions,
} from "@lmnr-ai/client";
import type { LlmProfile, LlmProfileProvider } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import {
  buildProfileConfigAndSecrets,
  type LlmProfileShapeOpts,
} from "./flags";

const logger = initializeLogger();

type LlmProfileCreateOpts = GlobalOpts & LlmProfileShapeOpts;
type LlmProfileUpdateOpts = GlobalOpts &
  LlmProfileShapeOpts & {
    name?: string;
  };

const printProfile = (profile: LlmProfile): void => {
  logger.info(`${profile.name} (${profile.id})`);
  logger.info(`  provider:     ${profile.provider}`);
  logger.info(`  auth:         ${profile.config.auth.type}`);
  const { config, secrets } = profile;
  // `!= null` throughout: config omits absent fields on the wire, but the
  // secret masks arrive as explicit `null` — both must stay unprinted.
  if (config.auth.type === "aws_keys") {
    logger.info(`  access key:   ${config.auth.accessKeyId}`);
  }
  if (config.region != null) {
    logger.info(`  region:       ${config.region}`);
  }
  if (config.resourceId != null) {
    logger.info(`  resource id:  ${config.resourceId}`);
  }
  if (config.baseUrl != null) {
    logger.info(`  base url:     ${config.baseUrl}`);
  }
  if (config.apiVersion != null) {
    logger.info(`  api version:  ${config.apiVersion}`);
  }
  logger.info(`  models:       ${profile.models.join(", ") || "-"}`);
  // Secrets are write-only; the server returns first3***last3 masks.
  if (secrets.apiKey != null) {
    logger.info(`  api key:      ${secrets.apiKey}`);
  }
  if (secrets.secretAccessKey != null) {
    logger.info(`  secret key:   ${secrets.secretAccessKey}`);
  }
  if (secrets.token != null) {
    logger.info(`  token:        ${secrets.token}`);
  }
  if (secrets.headers.length > 0) {
    logger.info(`  headers:      ${secrets.headers.join(", ")}`);
  }
  logger.info(`  created:      ${profile.createdAt}`);
  logger.info(`  updated:      ${profile.updatedAt}`);
};

/**
 * `lmnr-cli llm-profile list` — the caller's project's workspace LLM profiles,
 * ordered case-insensitively by name. The printed IDs feed
 * `signal create --llm-profile-id <id> --model <name>` and the other
 * llm-profile subcommands.
 *
 * Self-hosted only: on Laminar Cloud the server 404s with
 * `LLM profiles are not available on this deployment`, surfaced verbatim via
 * the client's error-envelope unwrapping (same for every subcommand here).
 */
export const handleLlmProfileList = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  const profiles = await client.llmProfiles.list();

  if (opts.json) {
    outputJson(profiles);
    return;
  }
  if (profiles.length === 0) {
    logger.info(
      "No LLM profiles in this workspace. Create one with " +
        "`lmnr-cli llm-profile create` or in Settings → LLM profiles.",
    );
    return;
  }

  const rows = profiles.map((p) => [
    p.id,
    p.name,
    p.provider,
    p.models.length === 0 ? "-" : p.models.join(", "),
  ]);
  logger.info(renderTable(["ID", "Name", "Provider", "Models"], rows));
};

/** `lmnr-cli llm-profile get <profile-id>` */
export const handleLlmProfileGet = async (
  client: LaminarClient,
  profileId: string,
  opts: GlobalOpts,
): Promise<void> => {
  const profile = await client.llmProfiles.get(profileId);
  if (opts.json) {
    outputJson(profile);
    return;
  }
  printProfile(profile);
};

/** `lmnr-cli llm-profile create <name>` */
export const handleLlmProfileCreate = async (
  client: LaminarClient,
  name: string,
  opts: LlmProfileCreateOpts,
): Promise<void> => {
  if (opts.provider === undefined) {
    throw new Error("--provider is required.");
  }
  const { config, secrets } = buildProfileConfigAndSecrets(opts);
  const body: CreateLlmProfileOptions = {
    name,
    provider: opts.provider as LlmProfileProvider,
    ...(config !== undefined ? { config } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    models: opts.model ?? [],
  };

  const profile = await client.llmProfiles.create(body);
  if (opts.json) {
    outputJson(profile);
    return;
  }
  logger.info(`Created LLM profile "${profile.name}".`);
  printProfile(profile);
};

/**
 * `lmnr-cli llm-profile update <profile-id>` — partial patch. Omitted flags
 * keep stored values; secrets are an overlay (an omitted secret keeps the
 * stored one). Any config flag sends a WHOLE new config, so re-pass every
 * config field the provider needs. --model replaces the whole model list.
 */
export const handleLlmProfileUpdate = async (
  client: LaminarClient,
  profileId: string,
  opts: LlmProfileUpdateOpts,
): Promise<void> => {
  const { config, secrets } = buildProfileConfigAndSecrets(opts);
  const patch: UpdateLlmProfileOptions = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.provider !== undefined
      ? { provider: opts.provider as LlmProfileProvider }
      : {}),
    ...(config !== undefined ? { config } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(opts.model !== undefined ? { models: opts.model } : {}),
  };

  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to update. Pass at least one of --name, --provider, --model, " +
        "--api-key, --access-key-id, --secret-access-key, --token, --region, " +
        "--resource-id, --provider-base-url, --api-version, --header.",
    );
  }

  const profile = await client.llmProfiles.update(profileId, patch);
  if (opts.json) {
    outputJson(profile);
    return;
  }
  logger.info(`Updated LLM profile "${profile.name}".`);
  printProfile(profile);
};

/** `lmnr-cli llm-profile delete <profile-id>` */
export const handleLlmProfileDelete = async (
  client: LaminarClient,
  profileId: string,
  opts: GlobalOpts,
): Promise<void> => {
  // The server refuses (409) while any signal routes through the profile.
  const profile = await client.llmProfiles.delete(profileId);
  if (opts.json) {
    outputJson(profile);
    return;
  }
  logger.info(`Deleted LLM profile "${profile.name}" (${profile.id}).`);
};
