import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  buildLaminarClient: vi.fn(),
  readDebugSessionFile: vi.fn(),
  resolveDebugSessionDir: vi.fn(() => "/repo"),
  addBlock: vi.fn(),
}));

vi.mock("../auth/client", () => ({ buildLaminarClient: h.buildLaminarClient }));
vi.mock("./debug-session-file", () => ({
  readDebugSessionFile: h.readDebugSessionFile,
  resolveDebugSessionDir: h.resolveDebugSessionDir,
}));

import {
  commandPath,
  isTrackedCommand,
  maybeTrackCommand,
  trackingDisabled,
} from "./track-command";

// Minimal Command stand-in: just the surface maybeTrackCommand reads.
const makeCmd = (
  name: string,
  parent: Command | null,
  opts: Record<string, unknown> = {},
  args: string[] = [],
): Command =>
  ({
    name: () => name,
    parent,
    args,
    optsWithGlobals: () => opts,
  }) as unknown as Command;

const root = makeCmd("lmnr-cli", null);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LMNR_NO_COMMAND_TRACKING;
  h.readDebugSessionFile.mockReturnValue({ session_id: "sess-1" });
  h.buildLaminarClient.mockResolvedValue({ rolloutSessions: { addBlock: h.addBlock } });
  h.addBlock.mockResolvedValue("block-1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commandPath / isTrackedCommand", () => {
  it("joins the path up to (not including) the program root", () => {
    const sql = makeCmd("sql", root);
    expect(commandPath(makeCmd("query", sql))).toBe("sql query");
    expect(commandPath(makeCmd("ask", root))).toBe("ask");
  });

  it("allowlists only sql query and ask", () => {
    expect(isTrackedCommand("sql query")).toBe(true);
    expect(isTrackedCommand("ask")).toBe(true);
    expect(isTrackedCommand("login")).toBe(false);
    expect(isTrackedCommand("debug session add-note")).toBe(false);
  });
});

describe("trackingDisabled", () => {
  it("honors the --no-track flag", () => {
    expect(trackingDisabled({ track: false })).toBe(true);
    expect(trackingDisabled({ track: true })).toBe(false);
    expect(trackingDisabled({})).toBe(false);
  });

  it("honors LMNR_NO_COMMAND_TRACKING", () => {
    for (const v of ["1", "true", "YES"]) {
      process.env.LMNR_NO_COMMAND_TRACKING = v;
      expect(trackingDisabled({})).toBe(true);
    }
    process.env.LMNR_NO_COMMAND_TRACKING = "0";
    expect(trackingDisabled({})).toBe(false);
  });
});

describe("maybeTrackCommand", () => {
  it("posts a command block for an allowlisted command with an active session", async () => {
    const sql = makeCmd("sql", root);
    const query = makeCmd("query", sql, { projectId: "p1" }, ["SELECT * FROM spans LIMIT 1"]);

    await maybeTrackCommand(query, 0);

    expect(h.buildLaminarClient).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
    );
    expect(h.addBlock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      type: "command",
      content: {
        command: "sql query",
        args: ["SELECT * FROM spans LIMIT 1"],
        exitCode: 0,
        // No emit/log happened in this unit context, so capture is empty.
        output: null,
        stderr: null,
      },
      failOnNotFound: false,
    });
  });

  it("records the real exit code on a failed command", async () => {
    const query = makeCmd("query", makeCmd("sql", root), {}, ["BAD SQL"]);

    await maybeTrackCommand(query, 9);

    expect(h.addBlock).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ exitCode: 9 }) }),
    );
  });

  it("folds the explicit fatal error text into stderr on the failure path", async () => {
    const query = makeCmd("query", makeCmd("sql", root), {}, ["BAD SQL"]);

    await maybeTrackCommand(query, 1, "relation \"nonexistent_table\" does not exist");

    expect(h.addBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          exitCode: 1,
          stderr: 'relation "nonexistent_table" does not exist',
        }),
      }),
    );
  });

  it("posts nothing for a non-allowlisted command", async () => {
    await maybeTrackCommand(makeCmd("login", root), 0);

    expect(h.buildLaminarClient).not.toHaveBeenCalled();
    expect(h.addBlock).not.toHaveBeenCalled();
  });

  it("posts nothing (and builds no client) when no session is active", async () => {
    h.readDebugSessionFile.mockReturnValue(null);

    await maybeTrackCommand(makeCmd("ask", root, {}, ["why?"]), 0);

    expect(h.buildLaminarClient).not.toHaveBeenCalled();
    expect(h.addBlock).not.toHaveBeenCalled();
  });

  it("swallows a write failure — never throws", async () => {
    h.addBlock.mockRejectedValue(new Error("network down"));
    const query = makeCmd("query", makeCmd("sql", root), {}, ["SELECT 1"]);

    await expect(maybeTrackCommand(query, 0)).resolves.toBeUndefined();
  });

  it("posts nothing when opted out via --no-track", async () => {
    const query = makeCmd("query", makeCmd("sql", root), { track: false }, ["SELECT 1"]);

    await maybeTrackCommand(query, 0);

    expect(h.addBlock).not.toHaveBeenCalled();
  });

  it("posts nothing when opted out via LMNR_NO_COMMAND_TRACKING", async () => {
    process.env.LMNR_NO_COMMAND_TRACKING = "1";
    const query = makeCmd("query", makeCmd("sql", root), {}, ["SELECT 1"]);

    await maybeTrackCommand(query, 0);

    expect(h.addBlock).not.toHaveBeenCalled();
  });
});
