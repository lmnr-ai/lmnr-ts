import { describe, it } from "node:test";
import { Laminar } from "../src/index";
import assert from "node:assert";

describe("initialize", () => {
  it("initializes", () => {
    Laminar.initialize({
        projectApiKey: "test"
    });

    assert.strictEqual(Laminar.initialized(), true);
  });

  it("throws an error if projectApiKey is not provided", () => {
    assert.throws(() => Laminar.initialize({}), Error);
  });

  it("throws an error if baseUrl has ports", () => {
    assert.throws(() => Laminar.initialize({
      baseUrl: "http://localhost:8080"
    }), Error);
  });
});
