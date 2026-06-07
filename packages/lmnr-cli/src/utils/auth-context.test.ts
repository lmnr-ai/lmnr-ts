import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAuth } from "./auth-context";

let prevKey: string | undefined;
let prevBase: string | undefined;

beforeEach(() => {
  prevKey = process.env.LMNR_PROJECT_API_KEY;
  prevBase = process.env.LMNR_BASE_URL;
  delete process.env.LMNR_PROJECT_API_KEY;
  delete process.env.LMNR_BASE_URL;
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("LMNR_PROJECT_API_KEY", prevKey);
  restore("LMNR_BASE_URL", prevBase);
});

describe("resolveAuth precedence", () => {
  it("flag key wins over env key", async () => {
    process.env.LMNR_PROJECT_API_KEY = "env-key";
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.projectApiKey).toBe("flag-key");
  });

  it("env key when no flag is set", async () => {
    process.env.LMNR_PROJECT_API_KEY = "env-key";
    const auth = await resolveAuth({});
    expect(auth.projectApiKey).toBe("env-key");
  });

  it("throws NOT_LOGGED_IN when neither flag nor env is set", async () => {
    await expect(resolveAuth({})).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
  });

  it("--base-url flag wins over LMNR_BASE_URL env", async () => {
    process.env.LMNR_BASE_URL = "https://api.lmnr.ai";
    const auth = await resolveAuth({ projectApiKey: "flag-key", baseUrl: "http://localhost:8020" });
    expect(auth.baseUrl).toBe("http://localhost:8020");
  });

  it("falls back to LMNR_BASE_URL env when no flag", async () => {
    process.env.LMNR_BASE_URL = "http://localhost:8020";
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.baseUrl).toBe("http://localhost:8020");
  });

  it("baseUrl undefined when no flag/env provide one", async () => {
    const auth = await resolveAuth({ projectApiKey: "flag-key" });
    expect(auth.baseUrl).toBeUndefined();
  });
});
