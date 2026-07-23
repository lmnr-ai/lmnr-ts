import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { CliResource } from "../src/resources/cli";

void describe("CliResource Tests", () => {
  void it("listProjects sorts by workspace then project name, case-insensitively", async () => {
    // Deliberately unsorted server order (mixed case) to prove the client sorts.
    const serverProjects = [
      { id: "3", name: "zebra", workspaceId: "wb", workspaceName: "Beta" },
      { id: "1", name: "Apple", workspaceId: "wa", workspaceName: "alpha" },
      { id: "2", name: "banana", workspaceId: "wa", workspaceName: "Alpha" },
      { id: "4", name: "aardvark", workspaceId: "wb", workspaceName: "beta" },
    ];
    const mockFetch = mock.fn(() => ({
      ok: true,
      json: () => Promise.resolve({ projects: serverProjects }),
    }));
    global.fetch = mockFetch as any;

    const resource = new CliResource(
      "https://api.test.com:443",
      { type: "userToken", token: "jwt", projectId: "" },
    );
    const projects = await resource.listProjects();

    // Workspace alpha (case-insensitive) before beta; within a workspace,
    // project name ascending, case-insensitive.
    assert.deepStrictEqual(
      projects.map((p) => p.id),
      ["1", "2", "4", "3"],
    );
  });

  void it("listProjects returns [] for a missing projects array", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, json: () => Promise.resolve({}) }));
    global.fetch = mockFetch as any;

    const resource = new CliResource(
      "https://api.test.com:443",
      { type: "userToken", token: "jwt", projectId: "" },
    );
    assert.deepStrictEqual(await resource.listProjects(), []);
  });
});
