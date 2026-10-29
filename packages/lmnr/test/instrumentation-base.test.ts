import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  InstrumentedModule,
  instrumentedObserve,
  LaminarInstrumentation,
  LaminarInstrumentationConfig,
  PatchedMethod,
} from "../src/opentelemetry-lib/instrumentation/shared/base";
import {
  getPackageVersion,
  recordPackageVersion,
} from "../src/opentelemetry-lib/instrumentation/shared/package-version";

const SCOPE_NAME = "lmnr.span.instrumentation_scope.name";
const SCOPE_VERSION = "lmnr.span.instrumentation_scope.version";

const FAKE_PACKAGE = "@lmnr-test/fake-sdk";
const FAKE_VERSION = "1.2.3";
const OTHER_PACKAGE = "@lmnr-test/other-sdk";

const wrapGreet = (patched: PatchedMethod) =>
  function (this: any, name: string) {
    const { instrumentation, original } = patched;
    const span = instrumentation.startSpan({
      name: "fake.greet",
      input: instrumentation.traceContent ? name : undefined,
    });
    try {
      return original.call(this, name);
    } finally {
      span.end();
    }
  };

const makeFakeModule = () => {
  class Client {
    greet(name: string) {
      return `hello ${name}`;
    }
  }
  return { Client };
};

class FakeInstrumentation extends LaminarInstrumentation {
  constructor(config?: LaminarInstrumentationConfig) {
    super("fake", config);
  }

  protected modules(): InstrumentedModule[] {
    return [
      {
        name: FAKE_PACKAGE,
        supportedVersions: [">=1.0.0"],
        patch: (moduleExports) =>
          this.wrapMethod(moduleExports.Client.prototype, "greet", wrapGreet),
        unpatch: (moduleExports) =>
          this.unwrapMethod(moduleExports.Client.prototype, "greet"),
        accepts: (input) => typeof input?.Client === "function",
      },
      {
        name: OTHER_PACKAGE,
        supportedVersions: [">=1.0.0"],
        patch: (moduleExports) =>
          this.wrapMethod(
            moduleExports,
            "run",
            (patched) =>
              function (this: any, ...args: any[]) {
                const span = patched.instrumentation.startSpan(
                  { name: "other.run" },
                  OTHER_PACKAGE,
                );
                try {
                  return patched.original.apply(this, args);
                } finally {
                  span.end();
                }
              },
          ),
        unpatch: (moduleExports) => this.unwrapMethod(moduleExports, "run"),
        accepts: (input) => typeof input?.run === "function",
      },
    ];
  }

  public unpatchAll(moduleExports: any) {
    this.modules()[0].unpatch!(moduleExports);
  }

  public definitions() {
    return this.init();
  }
}

void describe("getPackageVersion", () => {
  void it("reads a package whose exports map hides package.json", () => {
    const expected = JSON.parse(
      readFileSync(
        join(__dirname, "../node_modules/@anthropic-ai/sdk/package.json"),
        "utf8",
      ),
    ).version;
    // biome-ignore lint/style/noCommonJs: pins that require() can't read it
    assert.throws(() => require("@anthropic-ai/sdk/package.json"));
    assert.strictEqual(getPackageVersion("@anthropic-ai/sdk"), expected);
  });

  void it("reads a regular package", () => {
    assert.match(getPackageVersion("openai") ?? "", /^\d+\.\d+\.\d+/);
  });

  void it("returns undefined for a package that is not installed", () => {
    assert.strictEqual(
      getPackageVersion("@lmnr-test/not-installed"),
      undefined,
    );
  });

  void it("prefers a recorded version", () => {
    recordPackageVersion("@lmnr-test/recorded", "4.5.6");
    assert.strictEqual(getPackageVersion("@lmnr-test/recorded"), "4.5.6");
    recordPackageVersion("@lmnr-test/recorded", undefined);
    assert.strictEqual(getPackageVersion("@lmnr-test/recorded"), "4.5.6");
  });
});

void describe("LaminarInstrumentation", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true, instrumentModules: {} });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
    recordPackageVersion(FAKE_PACKAGE, FAKE_VERSION);
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("stamps the wrapped package's name and version on its spans", () => {
    const fake = makeFakeModule();
    new FakeInstrumentation().manuallyInstrument(fake);

    assert.strictEqual(new fake.Client().greet("bob"), "hello bob");

    const [span] = exporter.getFinishedSpans();
    assert.strictEqual(span.name, "fake.greet");
    assert.strictEqual(span.attributes[SCOPE_NAME], FAKE_PACKAGE);
    assert.strictEqual(span.attributes[SCOPE_VERSION], FAKE_VERSION);
    assert.strictEqual(span.attributes["lmnr.span.input"], "bob");
  });

  void it("leaves the version out when it can't be resolved", () => {
    const other = { run: () => "ran" };
    new FakeInstrumentation().manuallyInstrument(other);

    assert.strictEqual(other.run(), "ran");

    const [span] = exporter.getFinishedSpans();
    assert.strictEqual(span.attributes[SCOPE_NAME], OTHER_PACKAGE);
    assert.strictEqual(span.attributes[SCOPE_VERSION], undefined);
  });

  void it("never wraps twice, and re-instrumenting refreshes the config", () => {
    const fake = makeFakeModule();
    new FakeInstrumentation().manuallyInstrument(fake);
    const wrapped = fake.Client.prototype.greet;
    new FakeInstrumentation({ traceContent: false }).manuallyInstrument(fake);

    assert.strictEqual(fake.Client.prototype.greet, wrapped);
    new fake.Client().greet("bob");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["lmnr.span.input"], undefined);
  });

  void it("restores the original method on unpatch", () => {
    const fake = makeFakeModule();
    const original = fake.Client.prototype.greet;
    const instrumentation = new FakeInstrumentation();
    instrumentation.manuallyInstrument(fake);
    assert.notStrictEqual(fake.Client.prototype.greet, original);

    instrumentation.unpatchAll(fake);

    assert.strictEqual(fake.Client.prototype.greet, original);
    assert.deepStrictEqual(
      Object.getOwnPropertySymbols(fake.Client.prototype),
      [],
    );
    new fake.Client().greet("bob");
    assert.strictEqual(exporter.getFinishedSpans().length, 0);
  });

  void it("wraps getter-only exports, like bundled CJS modules", () => {
    const run = () => "ran";
    const moduleExports = {};
    Object.defineProperty(moduleExports, "run", {
      enumerable: true,
      configurable: true,
      get: () => run,
    });

    new FakeInstrumentation().manuallyInstrument(moduleExports);

    assert.strictEqual((moduleExports as any).run(), "ran");
    assert.strictEqual(exporter.getFinishedSpans().length, 1);
  });

  void it("ignores manual input it doesn't recognize", () => {
    assert.doesNotThrow(() =>
      new FakeInstrumentation().manuallyInstrument({ unrelated: true }),
    );
  });

  void it("stamps the spans instrumentedObserve opens, and only those", async () => {
    const observe = instrumentedObserve(FAKE_PACKAGE);

    const result = await observe(
      { name: "outer" },
      async (a: number, b: number) => {
        Laminar.startActiveSpan({ name: "inner" }).end();
        return a + b;
      },
      1,
      2,
    );

    assert.strictEqual(result, 3);
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === "outer")!;
    const inner = spans.find((s) => s.name === "inner")!;
    assert.strictEqual(outer.attributes[SCOPE_NAME], FAKE_PACKAGE);
    assert.strictEqual(outer.attributes[SCOPE_VERSION], FAKE_VERSION);
    assert.strictEqual(outer.attributes["lmnr.span.input"], "[1,2]");
    // User code running inside is not attributed to the library.
    assert.strictEqual(inner.attributes[SCOPE_NAME], undefined);
  });

  void it("records the version the module hook reports", () => {
    const fake = makeFakeModule();
    const [definition] = new FakeInstrumentation().definitions();

    definition.patch!(fake, "7.8.9");
    new fake.Client().greet("bob");

    const [span] = exporter.getFinishedSpans();
    assert.strictEqual(span.attributes[SCOPE_VERSION], "7.8.9");
  });
});
