import { describe, expect, it } from "vitest";

import {
  formatEvaluationLine,
  harborLogLine,
  parseEvaluationLine,
} from "./run-log-lines";

const URL_A =
  "https://www.laminar.sh/project/7965c52c-656b-478b-aeba-3bcb9a36d24a/evaluations/ebcaabe3-d1bf-4132-b51b-7b7f264abd9b";
const pluginLine = (url: string) =>
  `2026-11-13 18:39:22,645::lmnr.integrations.harbor.plugin::INFO: Laminar evaluation: ${url} (plugin.py:200)`;

void describe("harborLogLine", () => {
  void it("drops Harbor's sandbox paths and keeps the link once, cleaned up", () => {
    const seen = new Set<string>();
    const rewrite = harborLogLine("fpl-agent", seen);
    const job = "/tmp/lmnr-jobs-LXmCE4/fpl-agent/2026-11-13__18-38-32";

    expect(rewrite(pluginLine(URL_A))).toBe(
      `Laminar evaluation for suite fpl-agent: ${URL_A}`,
    );
    expect(rewrite("Job Info")).toBe("Job Info");
    expect(rewrite("Total runtime: 44s")).toBe("Total runtime: 44s");
    expect(rewrite(`Results written to ${job}/result.json`)).toBeNull();
    expect(
      rewrite(
        "Inspect results by running `harbor view /tmp/lmnr-jobs-LXmCE4/fpl-agent`",
      ),
    ).toBeNull();
    // The plugin logs the link again when the job ends.
    expect(rewrite(pluginLine(URL_A))).toBeNull();
    expect(
      rewrite(`Share results by running \`harbor upload ${job}\``),
    ).toBeNull();
    // A trial error naming a sandbox path is still worth seeing.
    const failed = `Failed to download logs to ${job}/hello/agent: Sandbox not started.`;
    expect(rewrite(failed)).toBe(failed);
  });

  void it("round-trips the evaluation line", () => {
    const link = { suite: "my suite", url: URL_A };
    expect(parseEvaluationLine(formatEvaluationLine(link))).toEqual(link);
    expect(parseEvaluationLine(pluginLine(URL_A))).toBeNull();
  });
});
