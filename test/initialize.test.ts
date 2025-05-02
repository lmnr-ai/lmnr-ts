import assert from "node:assert";
import { describe, it } from "node:test";

import { Laminar } from "../src/index";

void describe("initialize", () => {
  void it("initializes", () => {
    Laminar.initialize({
      projectApiKey: "test",
    });

    assert.strictEqual(Laminar.initialized(), true);
  });

  void it("throws an error if projectApiKey is not provided", () => {
    assert.throws(() => Laminar.initialize({}), Error);
  });
});
