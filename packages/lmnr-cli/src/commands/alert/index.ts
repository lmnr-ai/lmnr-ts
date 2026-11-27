import type { LaminarClient } from "@lmnr-ai/client";
import type { Alert, MetricAlertRule } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson, printData } from "../../utils/output";
import { resolveSignalId } from "../signal";
import {
  type AlertCreateFlagOpts,
  type AlertShapeOpts,
  buildCreateAlert,
  buildUpdateAlert,
} from "./flags";
import {
  buildCreateMetricAlert,
  buildUpdateMetricAlert,
  describeRule,
  type MetricAlertFlagOpts,
  ruleStatus,
} from "./metric-flags";

const logger = initializeLogger();

const printTargets = (alert: Alert): void => {
  logger.info(`  notify me:    ${alert.notifyMe ? "yes" : "no"}`);
  logger.info(
    `  slack:        ${
      alert.slackChannels
        .map((c) => `#${c.channelName ?? c.channelId} (${c.channelId})`)
        .join(", ") || "-"
    }`,
  );
};

const printMetricAlert = (alert: Alert, rule: MetricAlertRule): void => {
  logger.info(`${alert.name} (${alert.id})`);
  logger.info(`  type:         ${alert.type}`);
  logger.info(`  rule:         ${describeRule(rule)}`);
  if (rule.resolve != null) {
    logger.info(`  resolves at:  ${rule.resolve}`);
  }
  logger.info(`  status:       ${ruleStatus(rule)}`);
  printTargets(alert);
  logger.info(`  created:      ${alert.createdAt}`);
};

const printAlert = (alert: Alert): void => {
  // A server without metric alerts leaves `rule` out.
  if (alert.rule != null) {
    printMetricAlert(alert, alert.rule);
    return;
  }
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
  printTargets(alert);
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

/** `lmnr-cli alert metric create` */
export const handleMetricAlertCreate = async (
  client: LaminarClient,
  opts: GlobalOpts & MetricAlertFlagOpts,
): Promise<void> => {
  const alert = await client.alerts.create(buildCreateMetricAlert(opts));
  if (opts.json) {
    outputJson(alert);
    return;
  }
  logger.info(`Created alert "${alert.name}".`);
  printAlert(alert);
};

/** `lmnr-cli alert metric update <alert-id>`: partial patch. */
export const handleMetricAlertUpdate = async (
  client: LaminarClient,
  alertId: string,
  opts: GlobalOpts & MetricAlertFlagOpts,
): Promise<void> => {
  const alert = await client.alerts.update(
    alertId,
    buildUpdateMetricAlert(opts),
  );
  if (opts.json) {
    outputJson(alert);
    return;
  }
  logger.info(`Updated alert "${alert.name}".`);
  printAlert(alert);
};

/** `lmnr-cli alert metric list`: the rules, read through SQL. */
export const handleMetricAlertList = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  const rows = await client.sql.query(
    "SELECT id, name, metadata, created_at FROM alerts " +
      "WHERE type = 'METRIC' ORDER BY created_at DESC",
  );
  const alerts = rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    rule: (typeof row.metadata === "string"
      ? JSON.parse(row.metadata)
      : row.metadata) as MetricAlertRule,
    createdAt: String(row.created_at),
  }));
  if (opts.json) {
    outputJson(alerts);
    return;
  }
  if (alerts.length === 0) {
    logger.info("No metric alerts. Create one with `alert metric create`.");
    return;
  }
  // Not a table: a table would cut the ids short to fit the terminal, and
  // `update` and `delete` need them whole.
  for (const a of alerts) {
    printData(`${a.id}  ${a.name}  (${ruleStatus(a.rule)})`);
    printData(`  ${describeRule(a.rule)}`);
  }
};
