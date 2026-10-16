import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";

import { collectTraceIds, parseTraceIdText } from "./trace-ids";

const A = "0198a7f2-0000-7000-8000-000000000001";
const B = "0198a7f2-0000-7000-8000-000000000002";

describe("parseTraceIdText", () => {
  it("splits on newlines, spaces, and commas", () => {
    expect(parseTraceIdText(`${A}\n\n ${B} ,${A}\r\n`, "f")).toEqual([A, B, A]);
  });

  it("returns nothing for blank input", () => {
    expect(parseTraceIdText(" \n\t", "f")).toEqual([]);
  });

  it("skips a single-column `sql query` CSV header", () => {
    expect(parseTraceIdText(`id\n${A}\n${B}\n`, "f")).toEqual([A, B]);
    expect(parseTraceIdText(`"trace_id"\n"${A}"\n`, "f")).toEqual([A]);
  });

  it("rejects multi-column CSV instead of sending the other columns", () => {
    expect(() => parseTraceIdText(`id,total_cost\n${A},0.12\n`, "f")).toThrow(
      /2 columns \(id, total_cost\)/,
    );
  });

  it("leaves junk for the server to name", () => {
    expect(parseTraceIdText(`${A} nope`, "f")).toEqual([A, "nope"]);
  });

  it("reads `sql query --json` rows and plain JSON arrays", () => {
    expect(
      parseTraceIdText(
        JSON.stringify([{ id: A, cost: 1 }, { trace_id: B }, { traceId: A }]),
        "f",
      ),
    ).toEqual([A, B, A]);
    expect(parseTraceIdText(`﻿ [ "${A}" ]`, "f")).toEqual([A]);
    expect(parseTraceIdText("[]", "f")).toEqual([]);
  });

  it("rejects malformed JSON and unusable items", () => {
    expect(() => parseTraceIdText(`["${A}"`, "f")).toThrow(/not valid JSON/);
    expect(() => parseTraceIdText(`[{"name":"x"}]`, "f")).toThrow(/item 0/);
    expect(() => parseTraceIdText(`["${A}", 5]`, "f")).toThrow(/item 1/);
    expect(() => parseTraceIdText(`[{"id": 5}]`, "f")).toThrow(/item 0/);
  });
});

describe("collectTraceIds", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lmnr-trace-ids-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("puts positionals (comma-splittable) before --file ids", async () => {
    const file = path.join(dir, "ids.txt");
    writeFileSync(file, `${B}\n`);
    expect(await collectTraceIds([`${A},${B}`, A], file)).toEqual([A, B, A, B]);
  });

  it("fails clearly on a missing file", async () => {
    await expect(
      collectTraceIds([], path.join(dir, "nope.txt")),
    ).rejects.toThrow(/ENOENT/);
  });
});
