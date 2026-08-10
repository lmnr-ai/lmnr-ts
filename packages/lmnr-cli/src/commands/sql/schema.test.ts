import { LaminarClient } from "@lmnr-ai/client";
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
// Driven through a REAL LaminarClient so the message is pinned to the origin
// the client actually fetches. An earlier version rebuilt the URL from
// `baseUrl` + `port` and drifted from the client's normalization.
void describe("handleSqlSchema failure message", () => {
  const failing = (baseUrl?: string, port?: number) => {
    const client = new LaminarClient({
      baseUrl,
      port,
      auth: { type: "apiKey", key: "test-key" },
    });
    client.sql.schema = () => Promise.reject(new Error("fetch failed"));
    return client;
  };

  void it("names the host and port that were fetched", async () => {
    await expect(
      handleSqlSchema(failing("http://localhost", 8000), {}),
    ).rejects.toThrow("http://localhost:8000");
  });

  // The client strips a port already present in baseUrl before appending the
  // effective one. Rebuilding the URL instead printed `localhost:8000:9000`.
  void it("does not double the port when baseUrl already carries one", async () => {
    await expect(
      handleSqlSchema(failing("http://localhost:8000", 9000), {}),
    ).rejects.toThrow("http://localhost:9000");
  });

  // Likewise a trailing slash, which otherwise rendered as `http://host/:8000`.
  void it("does not leave a slash before the port", async () => {
    await expect(
      handleSqlSchema(failing("http://localhost/", 8000), {}),
    ).rejects.toThrow("http://localhost:8000");
  });

  void it("shows the default port when none is given", async () => {
    await expect(
      handleSqlSchema(failing("https://api.lmnr.ai"), {}),
    ).rejects.toThrow("https://api.lmnr.ai:443");
  });
});
