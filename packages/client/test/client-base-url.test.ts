import assert from "node:assert";
import { afterEach, describe, it } from "node:test";

import nock from "nock";

import { LaminarClient } from "../src/index";

const projectApiKey = "test-api-key";

void describe("LaminarClient base URL resolution", () => {
  void afterEach(() => {
    delete process.env.LMNR_BASE_URL;
    nock.cleanAll();
  });

  void it("extracts the port from an explicit baseUrl argument", async () => {
    const client = new LaminarClient({
      baseUrl: "http://localhost:8000",
      projectApiKey,
    });

    const scope = nock("http://localhost:8000")
      .post("/v1/evals")
      .reply(200, {
        id: "12345678-1234-1234-1234-123456789abc",
        createdAt: new Date().toISOString(),
        groupId: "group-123",
        name: "test",
        metadata: {},
        projectId: "project-123",
      });

    await client.evals.create({ name: "test" });
    scope.done();
  });

  void it("extracts the port from the LMNR_BASE_URL env variable", async () => {
    process.env.LMNR_BASE_URL = "http://localhost:8000";
    const client = new LaminarClient({ projectApiKey });

    const scope = nock("http://localhost:8000")
      .post("/v1/evals")
      .reply(200, {
        id: "12345678-1234-1234-1234-123456789abc",
        createdAt: new Date().toISOString(),
        groupId: "group-123",
        name: "test",
        metadata: {},
        projectId: "project-123",
      });

    await client.evals.create({ name: "test" });
    scope.done();
  });

  void it("defaults to https://api.lmnr.ai:443 without baseUrl or env", async () => {
    const client = new LaminarClient({ projectApiKey });

    const scope = nock("https://api.lmnr.ai:443")
      .post("/v1/evals")
      .reply(200, {
        id: "12345678-1234-1234-1234-123456789abc",
        createdAt: new Date().toISOString(),
        groupId: "group-123",
        name: "test",
        metadata: {},
        projectId: "project-123",
      });

    await client.evals.create({ name: "test" });
    scope.done();
  });

  void it("exposes the configured base URL and API key", () => {
    const client = new LaminarClient({
      baseUrl: "http://localhost:8000",
      projectApiKey,
    });
    assert.strictEqual(client.configuredBaseUrl, "http://localhost:8000");
    assert.strictEqual(client.apiKey, projectApiKey);

    const defaultClient = new LaminarClient({ projectApiKey });
    assert.strictEqual(defaultClient.configuredBaseUrl, undefined);

    const envClient = (() => {
      process.env.LMNR_BASE_URL = "http://localhost:9000";
      return new LaminarClient({ projectApiKey });
    })();
    assert.strictEqual(envClient.configuredBaseUrl, "http://localhost:9000");

    const userTokenClient = new LaminarClient({
      auth: { type: "userToken", token: "jwt", projectId: "p1" },
    });
    assert.strictEqual(userTokenClient.apiKey, undefined);
  });

  void it("defaults env-derived baseUrl without port to 443", async () => {
    process.env.LMNR_BASE_URL = "https://api.lmnr.ai";
    const client = new LaminarClient({ projectApiKey });

    const scope = nock("https://api.lmnr.ai:443")
      .post("/v1/evals")
      .reply(200, {
        id: "12345678-1234-1234-1234-123456789abc",
        createdAt: new Date().toISOString(),
        groupId: "group-123",
        name: "test",
        metadata: {},
        projectId: "project-123",
      });

    await client.evals.create({ name: "test" });
    scope.done();
  });
});
