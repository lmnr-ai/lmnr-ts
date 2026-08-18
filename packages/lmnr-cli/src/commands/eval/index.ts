import type { LaminarClient } from "@lmnr-ai/client";
import type { Evaluation } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

export interface EvalListOpts extends GlobalOpts {
  group?: string;
  name?: string;
  tag?: string[];
  limit?: number;
  offset?: number;
}

const printEvaluation = (evaluation: Evaluation): void => {
  logger.info(`${evaluation.name} (${evaluation.id})`);
  logger.info(`  group:     ${evaluation.groupId}`);
  logger.info(`  created:   ${evaluation.createdAt}`);
  logger.info(`  tags:      ${evaluation.tags.length > 0 ? evaluation.tags.join(", ") : "-"}`);
  if (evaluation.metadata) {
    logger.info(`  metadata:  ${JSON.stringify(evaluation.metadata)}`);
  }
};

const printTags = (evalId: string, tags: string[], opts: GlobalOpts): void => {
  if (opts.json) {
    outputJson({ evalId, tags });
    return;
  }
  logger.info(`${evalId} tags: ${tags.length > 0 ? tags.join(", ") : "-"}`);
};

/** `lmnr-cli eval list` */
export const handleEvalList = async (client: LaminarClient, opts: EvalListOpts): Promise<void> => {
  const evaluations = await client.evals.list({
    groupId: opts.group,
    name: opts.name,
    tags: opts.tag,
    limit: opts.limit,
    offset: opts.offset,
  });

  if (opts.json) {
    outputJson(evaluations);
    return;
  }
  if (evaluations.length === 0) {
    logger.info("No evaluations found.");
    return;
  }

  const rows = evaluations.map((evaluation) => [
    evaluation.id,
    evaluation.name,
    evaluation.groupId,
    evaluation.tags.join(", ") || "-",
    evaluation.createdAt,
  ]);
  logger.info(renderTable(["ID", "Name", "Group", "Tags", "Created"], rows));
};

/** `lmnr-cli eval get <evalId>` */
export const handleEvalGet = async (
  client: LaminarClient, evalId: string, opts: GlobalOpts,
): Promise<void> => {
  const evaluation = await client.evals.get(evalId);
  if (opts.json) {
    outputJson(evaluation);
    return;
  }
  printEvaluation(evaluation);
};

/** `lmnr-cli eval tag <evalId> <tags...>` */
export const handleEvalTag = async (
  client: LaminarClient, evalId: string, tags: string[], opts: GlobalOpts,
): Promise<void> => {
  const updated = await client.evals.addTags(evalId, tags);
  printTags(evalId, updated, opts);
};

/**
 * `lmnr-cli eval untag <evalId> <tags...>`
 *
 * Detaches sequentially: the API removes one tag per call, and stopping at the
 * first failure keeps the reported list consistent with what the server holds.
 */
export const handleEvalUntag = async (
  client: LaminarClient, evalId: string, tags: string[], opts: GlobalOpts,
): Promise<void> => {
  let remaining: string[] = [];
  for (const tag of tags) {
    remaining = await client.evals.removeTag(evalId, tag);
  }
  printTags(evalId, remaining, opts);
};
