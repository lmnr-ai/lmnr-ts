import { describe, expect, it } from "vitest";

import { buildProfileConfigAndSecrets, parseHeaderFlag } from "./flags";

void describe("parseHeaderFlag", () => {
  void it("splits on the first = so the value may contain more", () => {
    expect(parseHeaderFlag("X-Api-Key=abc=def")).toEqual([
      "X-Api-Key",
      "abc=def",
    ]);
    expect(parseHeaderFlag(" X-Team =ops")).toEqual(["X-Team", "ops"]);
  });

  void it("rejects a missing name or missing =", () => {
    expect(() => parseHeaderFlag("no-equals")).toThrow("Name=Value");
    expect(() => parseHeaderFlag("=value-only")).toThrow("Name=Value");
  });
});

void describe("buildProfileConfigAndSecrets", () => {
  void it("returns neither object when no shape flag was passed", () => {
    // Update must send nothing so the server keeps the stored config/secrets.
    expect(buildProfileConfigAndSecrets({})).toEqual({});
  });

  void it("derives aws_keys auth and splits secret from config", () => {
    expect(
      buildProfileConfigAndSecrets({
        accessKeyId: "AKIA123",
        secretAccessKey: "shhh",
        region: "eu-west-1",
      }),
    ).toEqual({
      config: {
        auth: { type: "aws_keys", accessKeyId: "AKIA123" },
        region: "eu-west-1",
      },
      secrets: { secretAccessKey: "shhh" },
    });
  });

  void it("derives bearer_token auth from --token", () => {
    expect(
      buildProfileConfigAndSecrets({ token: "tok", region: "us-east-1" }),
    ).toEqual({
      config: { auth: { type: "bearer_token" }, region: "us-east-1" },
      secrets: { token: "tok" },
    });
  });

  void it("omits auth for plain api-key providers (server default)", () => {
    expect(buildProfileConfigAndSecrets({ apiKey: "sk-1" })).toEqual({
      secrets: { apiKey: "sk-1" },
    });
  });

  void it("puts header names in config and values in secrets", () => {
    expect(
      buildProfileConfigAndSecrets({
        providerBaseUrl: "https://gw.example.com",
        apiKey: "sk-1",
        header: ["X-A=1", "X-B=2"],
      }),
    ).toEqual({
      config: {
        baseUrl: "https://gw.example.com",
        headerNames: ["X-A", "X-B"],
      },
      secrets: { apiKey: "sk-1", headers: { "X-A": "1", "X-B": "2" } },
    });
  });
});
