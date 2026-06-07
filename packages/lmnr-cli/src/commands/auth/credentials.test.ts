import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Credentials,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials";

let tmpHome: string;
let prevHome: string | undefined;
let prevXdg: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "lmnr-cli-cred-test-"));
  prevHome = process.env.HOME;
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows shim
  delete process.env.XDG_CONFIG_HOME; // default to ~/.config/lmnr
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

const sample: Credentials = {
  version: 1,
  baseUrl: "https://api.example.com",
  dashboardUrl: "https://example.com",
  projectId: "00000000-0000-0000-0000-000000000000",
  projectName: "test-project",
  workspaceId: "00000000-0000-0000-0000-000000000001",
  workspaceName: "Test Workspace",
  userEmail: "alice@example.com",
  projectApiKey: "lmnr_pk_abcdef0123456789",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("credentials round-trip", () => {
  it("writes then reads identical Credentials", async () => {
    await writeCredentials(sample);
    const round = await readCredentials();
    expect(round).toEqual(sample);
    expect(credentialsPath().startsWith(tmpHome)).toBe(true);
  });

  it("defaults to ~/.config/lmnr/credentials.json", () => {
    expect(credentialsPath()).toBe(
      path.join(tmpHome, ".config", "lmnr", "credentials.json"),
    );
  });

  it("honours XDG_CONFIG_HOME", async () => {
    const xdg = path.join(tmpHome, "custom-xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    expect(credentialsPath()).toBe(path.join(xdg, "lmnr", "credentials.json"));
    await writeCredentials(sample);
    expect(await readCredentials()).toEqual(sample);
  });

  it("reads credentials without optional workspace fields", async () => {
    const minimal: Credentials = {
      version: 1,
      baseUrl: "https://api.example.com",
      dashboardUrl: "https://example.com",
      projectId: "00000000-0000-0000-0000-000000000000",
      projectName: "test-project",
      projectApiKey: "abcdef0123456789",
    };
    await writeCredentials(minimal);
    expect(await readCredentials()).toEqual(minimal);
  });

  it("chmod 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    await writeCredentials(sample);
    const stat = await fs.stat(credentialsPath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("readCredentials returns null when file is missing", async () => {
    expect(await readCredentials()).toBeNull();
  });

  it("deleteCredentials returns true on existing file, false on missing", async () => {
    await writeCredentials(sample);
    expect(await deleteCredentials()).toBe(true);
    expect(await deleteCredentials()).toBe(false);
  });

  it("rejects schema version mismatch on read", async () => {
    const dir = path.dirname(credentialsPath());
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      credentialsPath(),
      JSON.stringify({ version: 999, projectApiKey: "x" }),
      { mode: 0o600 },
    );
    await expect(readCredentials()).rejects.toThrow(/Unrecognized credentials schema/);
  });
});
