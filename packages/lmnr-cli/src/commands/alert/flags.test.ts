import { describe, expect, it } from "vitest";

import {
  buildCreateAlert,
  buildFilterGroups,
  buildUpdateAlert,
  parseAlertType,
  parseFilterGroup,
  parseSeverities,
} from "./flags";

const COND = '{"column":"category","operator":"eq","value":"refund"}';
const COND2 = '{"column":"score","operator":"gt","value":"3"}';

void describe("parseAlertType", () => {
  void it("accepts kebab and wire forms", () => {
    expect(parseAlertType("signal-event")).toBe("SIGNAL_EVENT");
    expect(parseAlertType("new-cluster")).toBe("NEW_CLUSTER");
    expect(parseAlertType("NEW_CLUSTER")).toBe("NEW_CLUSTER");
  });

  void it("rejects anything else", () => {
    expect(() => parseAlertType("cluster")).toThrow(
      /signal-event or new-cluster/,
    );
  });
});

void describe("parseSeverities", () => {
  void it("rejects unknown levels", () => {
    expect(parseSeverities(["info", "critical"])).toEqual(["info", "critical"]);
    expect(() => parseSeverities(["high"])).toThrow(
      /--severity must be one of/,
    );
  });
});

void describe("buildFilterGroups", () => {
  void it("is undefined when no filter flag was passed", () => {
    expect(buildFilterGroups({})).toBeUndefined();
    // commander's default for a lone `--no-filters` option is `true`.
    expect(buildFilterGroups({ filters: true })).toBeUndefined();
  });

  void it("ANDs --filter into one group and ORs each --filter-group", () => {
    expect(
      buildFilterGroups({
        filter: [COND, COND2],
        filterGroup: [`[${COND2}]`],
      }),
    ).toEqual([
      [
        { column: "category", operator: "eq", value: "refund" },
        { column: "score", operator: "gt", value: "3" },
      ],
      [{ column: "score", operator: "gt", value: "3" }],
    ]);
  });

  void it("--no-filters clears and refuses to mix with filter flags", () => {
    expect(buildFilterGroups({ filters: false })).toEqual([]);
    expect(() => buildFilterGroups({ filters: false, filter: [COND] })).toThrow(
      /cannot be combined/,
    );
  });
});

void describe("parseFilterGroup", () => {
  void it("needs a non-empty array of conditions", () => {
    expect(() => parseFilterGroup("[]")).toThrow(/non-empty JSON array/);
    expect(() => parseFilterGroup(COND)).toThrow(/non-empty JSON array/);
    expect(() => parseFilterGroup('[{"column":"x"}]')).toThrow(/operator/);
  });
});

void describe("buildCreateAlert", () => {
  void it("omits unset flags so server defaults apply", () => {
    expect(buildCreateAlert({})).toEqual({});
    expect(
      buildCreateAlert({
        type: "signal-event",
        severity: ["warning"],
        notifyMe: false,
        slackChannel: ["#support"],
      }),
    ).toEqual({
      type: "SIGNAL_EVENT",
      severities: ["warning"],
      notifyMe: false,
      slackChannels: ["#support"],
    });
  });
});

void describe("buildUpdateAlert", () => {
  void it("rejects an empty patch", () => {
    expect(() =>
      buildUpdateAlert({ slackChannels: true, filters: true }),
    ).toThrow(/Nothing to update/);
  });

  void it("--no-slack-channels clears Slack targets", () => {
    expect(buildUpdateAlert({ slackChannels: false })).toEqual({
      slackChannels: [],
    });
    expect(() =>
      buildUpdateAlert({ slackChannels: false, slackChannel: ["#a"] }),
    ).toThrow(/cannot be combined/);
  });

  void it("passes false flags through", () => {
    expect(buildUpdateAlert({ disabled: false, skipSimilar: false })).toEqual({
      disabled: false,
      skipSimilar: false,
    });
  });
});
