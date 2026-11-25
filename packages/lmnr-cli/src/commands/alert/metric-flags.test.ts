import type { MetricAlertRule } from "@lmnr-ai/types";
import { describe, expect, it } from "vitest";

import {
  buildCreateMetricAlert,
  buildUpdateMetricAlert,
  describeRule,
  parseRule,
  ruleStatus,
} from "./metric-flags";

const RULE: MetricAlertRule = {
  metric: "total_cost",
  filters: [],
  groupBy: null,
  window: { minutes: 60 },
  condition: { type: "change", compareTo: "1w" },
  direction: "above",
  warning: 130,
  critical: 150,
  resolve: 120,
  minChange: 1,
  checksInARow: 3,
  minTraces: null,
  onNoData: null,
  snoozedUntil: null,
  disabled: false,
};

void describe("parseRule", () => {
  void it("accepts a JSON object", () => {
    expect(parseRule('{"warning":50}')).toEqual({ warning: 50 });
  });

  void it("rejects broken JSON and non-objects", () => {
    expect(() => parseRule("{warning")).toThrow(/--rule is not valid JSON/);
    expect(() => parseRule("[1]")).toThrow(/--rule must be a JSON object/);
    expect(() => parseRule("null")).toThrow(/--rule must be a JSON object/);
  });
});

void describe("buildCreateMetricAlert", () => {
  void it("sends the template id and leaves the rule to the server", () => {
    expect(buildCreateMetricAlert({ template: "cost-spike" })).toEqual({
      type: "METRIC",
      template: "cost-spike",
    });
  });

  void it("merges rule keys, name and targets", () => {
    expect(
      buildCreateMetricAlert({
        template: "monthly-budget",
        rule: '{"condition":{"type":"budget","amount":2000}}',
        name: "Budget",
        notifyMe: false,
        slackChannel: ["#oncall"],
        disabled: true,
      }),
    ).toEqual({
      type: "METRIC",
      template: "monthly-budget",
      rule: { condition: { type: "budget", amount: 2000 } },
      name: "Budget",
      notifyMe: false,
      slackChannels: ["#oncall"],
      disabled: true,
    });
  });

  void it("needs a template or a rule", () => {
    expect(() => buildCreateMetricAlert({ name: "x" })).toThrow(
      /--template, --rule, or both/,
    );
  });
});

void describe("buildUpdateMetricAlert", () => {
  void it("sends only the flags that were passed", () => {
    expect(buildUpdateMetricAlert({ disabled: false })).toEqual({
      disabled: false,
    });
    expect(
      buildUpdateMetricAlert({ rule: '{"snoozedUntil":null,"warning":140}' }),
    ).toEqual({ rule: { snoozedUntil: null, warning: 140 } });
  });

  void it("clears Slack targets with --no-slack-channels", () => {
    expect(buildUpdateMetricAlert({ slackChannels: false })).toEqual({
      slackChannels: [],
    });
    expect(() =>
      buildUpdateMetricAlert({ slackChannels: false, slackChannel: ["#a"] }),
    ).toThrow(/cannot be combined/);
  });

  void it("rejects an empty patch", () => {
    expect(() => buildUpdateMetricAlert({})).toThrow(/Nothing to update/);
  });
});

void describe("describeRule", () => {
  void it("describes a change rule", () => {
    expect(describeRule(RULE)).toBe(
      "total_cost over 1h, above warning 130% of 1w earlier, " +
        "critical 150% of 1w earlier",
    );
  });

  void it("describes a split value rule and a budget", () => {
    expect(
      describeRule({
        ...RULE,
        metric: "error_rate",
        groupBy: "model",
        window: { minutes: 15 },
        condition: { type: "value" },
        critical: null,
        warning: 5,
      }),
    ).toBe("error_rate by model over 15m, above warning 5");
    expect(
      describeRule({
        ...RULE,
        window: { monthToDate: true },
        condition: { type: "budget", amount: 2000 },
        warning: null,
        critical: null,
      }),
    ).toBe("total_cost over month to date, budget 2000");
  });
});

void describe("ruleStatus", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  void it("reports muted, snoozed and active", () => {
    expect(ruleStatus({ ...RULE, disabled: true }, now)).toBe("muted");
    expect(
      ruleStatus({ ...RULE, snoozedUntil: "2026-01-01T01:00:00Z" }, now),
    ).toBe("snoozed until 2026-01-01T01:00:00Z");
    expect(
      ruleStatus({ ...RULE, snoozedUntil: "2025-12-31T23:00:00Z" }, now),
    ).toBe("active");
  });
});
