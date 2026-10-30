import type { LaminarClient } from "@lmnr-ai/client";
import type { Alert } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { resolveSignalId } from "../signal";
import {
  type AlertCreateFlagOpts,
  type AlertShapeOpts,
  buildCreateAlert,
  buildUpdateAlert,
} from "./flags";

const logger = initializeLogger();

type AlertListOpts = GlobalOpts & { signal?: string };

const describeTargets = (alert: Alert): string => {
  const targets = [
    ...(alert.notifyMe ? ["me"] : []),
    ...alert.slackChannels.map((c) => `#${c.channelName ?? c.channelId}`),
  ];
  return targets.length === 0 ? "-" : targets.join(", ");
};

const printAlert = (alert: Alert): void => {
  logger.info(`${alert.name} (${alert.id})`);
  logger.info(`  type:         ${alert.type}`);
  logger.info(
    `  signal:       ${alert.signalName ?? "(deleted)"} (${alert.signalId})`,
  );
  logger.info(`  status:       ${alert.disabled ? "disabled" : "active"}`);
  if (alert.type === "SIGNAL_EVENT") {
    logger.info(`  severities:   ${alert.severities.join(", ")}`);
    logger.info(`  skip similar: ${alert.skipSimilar ? "yes" : "no"}`);
  }
  logger.info(`  notify me:    ${alert.notifyMe ? "yes" : "no"}`);
  logger.info(
    `  slack:        ${
      alert.slackChannels
        .map((c) => `#${c.channelName ?? c.channelId} (${c.channelId})`)
        .join(", ") || "-"
    }`,
  );
  if (alert.filters.length === 0) {
    logger.info("  filters:      - (fires on every matching event)");
  } else {
    alert.filters.forEach((group, i) => {
      const conditions = group
        .map((f) => `${f.column} ${f.operator} ${JSON.stringify(f.value)}`)
        .join(" AND ");
      logger.info(
        `  ${i === 0 ? "filters:     " : "  or         "} ${conditions}`,
      );
    });
  }
  logger.info(`  created:      ${alert.createdAt}`);
};

/** `lmnr-cli alert list [--signal <signal>]` */
export const handleAlertList = async (
  client: LaminarClient,
  opts: AlertListOpts,
): Promise<void> => {
  const signalId =
    opts.signal !== undefined
      ? await resolveSignalId(client, opts.signal)
      : undefined;
  const alerts = await client.alerts.list(signalId);
  if (opts.json) {
    outputJson(alerts);
    return;
  }
  if (alerts.length === 0) {
    logger.info("No alerts. Create one with `lmnr-cli alert create <signal>`.");
    return;
  }
  const rows = alerts.map((a) => [
    a.id,
    a.name,
    a.type,
    a.signalName ?? "(deleted)",
    a.type === "SIGNAL_EVENT" ? a.severities.join(", ") : "-",
    describeTargets(a),
    a.disabled ? "disabled" : "active",
  ]);
  logger.info(
    renderTable(
      ["ID", "Name", "Type", "Signal", "Severities", "Targets", "Status"],
      rows,
    ),
  );
};

/** `lmnr-cli alert get <alert-id>` */
export const handleAlertGet = async (
  client: LaminarClient,
  alertId: string,
  opts: GlobalOpts,
): Promise<void> => {
  const alert = await client.alerts.get(alertId);
  if (opts.json) {
    outputJson(alert);
    return;
  }
  printAlert(alert);
};

/** `lmnr-cli alert create <signal>` */
export const handleAlertCreate = async (
  client: LaminarClient,
  signal: string,
  opts: GlobalOpts & AlertCreateFlagOpts,
): Promise<void> => {
  // Parse flags before the network call so a typo fails fast.
  const body = buildCreateAlert(opts);
  const signalId = await resolveSignalId(client, signal);
  const alert = await client.alerts.create({ ...body, signalId });
  if (opts.json) {
    outputJson(alert);
    return;
  }
  logger.info(`Created alert "${alert.name}".`);
  printAlert(alert);
};

/** `lmnr-cli alert update <alert-id>` — partial patch. */
export const handleAlertUpdate = async (
  client: LaminarClient,
  alertId: string,
  opts: GlobalOpts & AlertShapeOpts,
): Promise<void> => {
  const alert = await client.alerts.update(alertId, buildUpdateAlert(opts));
  if (opts.json) {
    outputJson(alert);
    return;
  }
  logger.info(`Updated alert "${alert.name}".`);
  printAlert(alert);
};

/** `lmnr-cli alert delete <alert-id>` */
export const handleAlertDelete = async (
  client: LaminarClient,
  alertId: string,
  opts: GlobalOpts,
): Promise<void> => {
  const result = await client.alerts.delete(alertId);
  if (opts.json) {
    outputJson(result);
    return;
  }
  logger.info(`Deleted alert ${alertId}.`);
};
