import type { SqlSchema } from "@lmnr-ai/types";
import { describe, expect, it } from "vitest";

import { renderSqlSchema } from "./schema";

const schema: SqlSchema = {
  tables: [
    {
      name: "spans",
      description: "Individual spans within traces.",
      columns: [
        { name: "span_id", type: "UUID", description: "Unique id of the span" },
        {
          name: "duration",
          type: "Decimal(18,9)",
          description: "Duration in seconds",
        },
        {
          name: "events",
          type: "Array(Tuple(timestamp Int64, name String, attributes String))",
          description: "Span events",
        },
      ],
    },
  ],
  enums: [
    {
      name: "span_type",
      values: [
        "DEFAULT",
        "LLM",
        "EXECUTOR",
        "EVALUATOR",
        "EVALUATION",
        "TOOL",
        "HUMAN_EVALUATOR",
        "CACHED",
        "UNKNOWN",
      ],
    },
    { name: "status", values: ["success", "error"] },
  ],
};

void describe("renderSqlSchema", () => {
  void it("renders every table with its columns and types", () => {
    const out = renderSqlSchema(schema);

    expect(out).toContain("  spans");
    expect(out).toContain("span_id (UUID)");
    expect(out).toContain("duration (Decimal(18,9))");
    expect(out).toContain(
      "events (Array(Tuple(timestamp Int64, name String, attributes String)))",
    );
  });

  // The user-facing contract is fields and types only; prose lives in the docs.
  void it("omits column descriptions", () => {
    const out = renderSqlSchema(schema);

    expect(out).not.toContain("Unique id of the span");
    expect(out).not.toContain("Individual spans within traces");
  });

  void it("renders enum values quoted", () => {
    const out = renderSqlSchema(schema);

    expect(out).toContain("span_type: 'DEFAULT',");
    expect(out).toContain("status: 'success', 'error'");
  });

  // A 9-value enum used to render as one 100+ char line.
  void it("keeps every line inside the terminal width", () => {
    const tooLong = renderSqlSchema(schema)
      .split("\n")
      .filter((line) => line.length > 80);

    expect(tooLong).toEqual([]);
  });

  void it("warns that project_id cannot be referenced", () => {
    expect(renderSqlSchema(schema)).toContain("project_id");
  });

  void it("does not throw on an empty schema", () => {
    expect(() => renderSqlSchema({ tables: [], enums: [] })).not.toThrow();
  });
});
