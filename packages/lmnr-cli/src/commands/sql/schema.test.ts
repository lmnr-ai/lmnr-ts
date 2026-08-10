import type { SqlSchema } from "@lmnr-ai/types";
import { describe, expect, it } from "vitest";

import { handleSqlSchema, renderSqlSchema } from "./schema";

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

// The CLI keeps host and port separate (`--base-url http://localhost --port
// 8000` is the documented self-host form). The failure message used to print
// the host alone, which named a URL that looked right when the port was the
// actual miss.
void describe("handleSqlSchema failure message", () => {
  const failingClient = {
    sql: { schema: () => Promise.reject(new Error("fetch failed")) },
  } as unknown as Parameters<typeof handleSqlSchema>[0];

  void it("includes the --port flag in the URL", async () => {
    await expect(
      handleSqlSchema(failingClient, { baseUrl: "http://localhost", port: 8000 }),
    ).rejects.toThrow("http://localhost:8000");
  });

  void it("falls back to LMNR_HTTP_PORT when no flag is given", async () => {
    process.env.LMNR_HTTP_PORT = "8123";
    try {
      await expect(
        handleSqlSchema(failingClient, { baseUrl: "http://localhost" }),
      ).rejects.toThrow("http://localhost:8123");
    } finally {
      delete process.env.LMNR_HTTP_PORT;
    }
  });

  // No port resolvable → no `:port` on the host. The `:` that follows the URL
  // in the message is this handler's own `${url}: ${error}` separator, so match
  // on `:<digits>` rather than a bare colon.
  void it("appends no port when none is resolvable", async () => {
    await expect(
      handleSqlSchema(failingClient, { baseUrl: "https://api.lmnr.ai" }),
    ).rejects.toThrow(/from https:\/\/api\.lmnr\.ai: /);
  });
});
