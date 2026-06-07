import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../commands/auth/credentials";
import { resolveAuth } from "./auth-context";

let tmpHome: string;
let prevHome: string | undefined;
let prevXdg: string | undefined;
let prevKey: string | undefined;
let prevBase: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "lmnr-cli-auth-ctx-"));
  prevHome = process.env.HOME;
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevKey = process.env.LMNR_PROJECT_API_KEY;
  prevBase = process.env.LMNR_BASE_URL;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.LMNR_PROJECT_API_KEY;
  delete process.env.LMNR_BASE_URL;
});

afterEach(async () => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("HOME", prevHome);
  restore("XDG_CONFIG_HOME", prevXdg);
  restore("LMNR_PROJECT_API_KEY", prevKey);
  restore("LMNR_BASE_URL", prevBase);
  await fs.rm(tmpHome, { recursive: true, force: true });
});

const seedLocalCreds = () =>
  writeCredentials({
    version: 1,
    baseUrl: "http://localhost:8020",
    dashboardUrl: "http://localhost:3020",
    projectId: "p-1",
    projectName: "local",
    projectApiKey: "creds-key",
  });

describe("resolveAuth baseUrl precedence", () => {
  it("flag-key wins the key race but still falls back to credentials.baseUrl", async () => {
    await seedLocalCreds();
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.projectApiKey).toBe("flag-key");
    expect(auth.baseUrl).toBe("http://localhost:8020");
  });

  it("env-key wins the key race but still falls back to credentials.baseUrl", async () => {
    await seedLocalCreds();
    process.env.LMNR_PROJECT_API_KEY = "env-key";
    const auth = await resolveAuth({});
    expect(auth.projectApiKey).toBe("env-key");
    expect(auth.baseUrl).toBe("http://localhost:8020");
  });

  it("--base-url flag overrides credentials.baseUrl", async () => {
    await seedLocalCreds();
    const auth = await resolveAuth({ projectApiKey: "flag-key", baseUrl: "https://api.lmnr.ai" });
    expect(auth.baseUrl).toBe("https://api.lmnr.ai");
  });

  it("LMNR_BASE_URL env overrides credentials.baseUrl", async () => {
    await seedLocalCreds();
    process.env.LMNR_BASE_URL = "https://api.lmnr.ai";
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.baseUrl).toBe("https://api.lmnr.ai");
  });

  it("credentials key + baseUrl when nothing else is set", async () => {
    await seedLocalCreds();
    const auth = await resolveAuth({});
    expect(auth.projectApiKey).toBe("creds-key");
    expect(auth.baseUrl).toBe("http://localhost:8020");
  });

  it("baseUrl undefined when no flag/env/creds provide one", async () => {
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.baseUrl).toBeUndefined();
  });
});
