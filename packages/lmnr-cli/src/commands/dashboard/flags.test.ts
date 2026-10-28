import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildChartFromFlags,
  buildCharts,
  parseChartsFile,
  parseLayout,
} from "./flags";

const QUERY =
  "SELECT count() AS n FROM spans WHERE start_time >= {start_time:DateTime64}";

const writeTemp = (name: string, content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "lmnr-dash-")), name);
  writeFileSync(path, content);
  return path;
};

void describe("parseLayout", () => {
  void it("parses x,y,w,h", () => {
    expect(parseLayout("0, 6,12,4")).toEqual({ x: 0, y: 6, w: 12, h: 4 });
  });

  void it("rejects anything but four integers", () => {
    expect(() => parseLayout("0,0,6")).toThrow(/four integers/);
    expect(() => parseLayout("0,0,6,a")).toThrow(/four integers/);
    expect(() => parseLayout("0,0,6.5,4")).toThrow(/four integers/);
  });
});

void describe("buildChartFromFlags", () => {
  void it("builds a new chart and omits unset fields", () => {
    expect(
      buildChartFromFlags({
        name: "Spans",
        query: QUERY,
        type: "line",
        x: "time",
        y: "n",
      }),
    ).toEqual({
      name: "Spans",
      query: QUERY,
      config: { type: "line", x: "time", y: "n" },
    });
  });

  void it("reads the query from --query-file", () => {
    const path = writeTemp("q.sql", QUERY);
    expect(
      buildChartFromFlags({ name: "T", queryFile: path, type: "table" }).query,
    ).toBe(QUERY);
  });

  void it("requires name, query and type for a new chart", () => {
    expect(() => buildChartFromFlags({ name: "x" })).toThrow(/new chart needs/);
    expect(() => buildChartFromFlags({ query: QUERY, type: "table" })).toThrow(
      /new chart needs/,
    );
  });

  void it("sends query and config together", () => {
    expect(() => buildChartFromFlags({ chartId: "c", query: QUERY })).toThrow(
      /passed together/,
    );
    expect(() => buildChartFromFlags({ chartId: "c", type: "bar" })).toThrow(
      /passed together/,
    );
  });

  void it("rejects mappings without --type", () => {
    expect(() => buildChartFromFlags({ chartId: "c", x: "time" })).toThrow(
      /--x needs --type/,
    );
  });

  void it("allows name/layout-only updates", () => {
    expect(buildChartFromFlags({ chartId: "c", layout: "0,0,6,6" })).toEqual({
      id: "c",
      layout: { x: 0, y: 0, w: 6, h: 6 },
    });
  });

  void it("rejects an empty update", () => {
    expect(() => buildChartFromFlags({ chartId: "c" })).toThrow(
      /Nothing to update/,
    );
  });

  void it("rejects unknown type and display mode", () => {
    expect(() =>
      buildChartFromFlags({ name: "x", query: QUERY, type: "pie" }),
    ).toThrow(/--type must be one of/);
    expect(() =>
      buildChartFromFlags({
        name: "x",
        query: QUERY,
        type: "line",
        displayMode: "sum",
      }),
    ).toThrow(/--display-mode must be one of/);
  });

  void it("rejects --query with --query-file", () => {
    expect(() =>
      buildChartFromFlags({ query: QUERY, queryFile: "q.sql" }),
    ).toThrow(/not both/);
  });
});

void describe("parseChartsFile", () => {
  void it("accepts an array or {charts}", () => {
    const charts = [{ name: "a", query: QUERY, config: { type: "table" } }];
    expect(parseChartsFile(JSON.stringify(charts))).toEqual(charts);
    expect(parseChartsFile(JSON.stringify({ charts }))).toEqual(charts);
  });

  void it("rejects empty, non-array, and non-object entries", () => {
    expect(() => parseChartsFile("[]")).toThrow(/non-empty/);
    expect(() => parseChartsFile('{"name":"a"}')).toThrow(/non-empty/);
    expect(() => parseChartsFile("[1]")).toThrow(/non-empty/);
    expect(() => parseChartsFile("nope")).toThrow(/not valid JSON/);
  });
});

void describe("buildCharts", () => {
  void it("reads a batch from --file", () => {
    const path = writeTemp("charts.json", '[{"id":"c","name":"n"}]');
    expect(buildCharts({ file: path })).toEqual([{ id: "c", name: "n" }]);
  });

  void it("refuses --file mixed with single-chart flags", () => {
    expect(() => buildCharts({ file: "x.json", name: "n" })).toThrow(
      /cannot be combined with --name/,
    );
  });
});
