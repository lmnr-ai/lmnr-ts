import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";

import { SPAN_RELEASE } from "../src/opentelemetry-lib/tracing/attributes";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";
import {
  detectRelease,
  findGitDir,
  MAX_RELEASE_LENGTH,
  RELEASE_ENV_VARS,
} from "../src/opentelemetry-lib/tracing/release";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const RELEASE_VARS = [
  "LMNR_RELEASE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_FUNCTION_NAME",
  ...RELEASE_ENV_VARS,
];

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;
const originalCwd = process.cwd.bind(process);

const makeRepo = (path: string, head: string): string => {
  const gitDir = join(path, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `${head}\n`);
  return gitDir;
};

// No release env vars, and a working directory outside any git repository.
beforeEach(() => {
  savedEnv = Object.fromEntries(
    RELEASE_VARS.map((name) => [name, process.env[name]]),
  );
  for (const name of RELEASE_VARS) {
    delete process.env[name];
  }
  root = mkdtempSync(join(tmpdir(), "lmnr-release-"));
  assert.equal(
    findGitDir(root),
    undefined,
    `${root} is inside a git checkout; the git tests need a clean tmpdir`,
  );
  cwd = join(root, "work");
  mkdirSync(cwd);
  process.cwd = () => cwd;
});

afterEach(() => {
  process.cwd = originalCwd;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

void describe("detectRelease precedence", () => {
  void it("detects nothing", () => {
    assert.equal(detectRelease(), undefined);
  });

  void it("prefers the explicit value over everything", () => {
    process.env.LMNR_RELEASE = "from-lmnr-env";
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    assert.equal(detectRelease("v1.2.3"), "v1.2.3");
  });

  void it("prefers LMNR_RELEASE over platform vars", () => {
    process.env.LMNR_RELEASE = "from-lmnr-env";
    process.env.VERCEL_GIT_COMMIT_SHA = SHA;
    assert.equal(detectRelease(), "from-lmnr-env");
  });

  void it("prefers SENTRY_RELEASE over a platform SHA", () => {
    process.env.SENTRY_RELEASE = "my-app@1.0.0";
    process.env.RENDER_GIT_COMMIT = SHA;
    assert.equal(detectRelease(), "my-app@1.0.0");
  });

  void it("prefers GITHUB_SHA over SENTRY_RELEASE", () => {
    process.env.GITHUB_SHA = SHA;
    process.env.SENTRY_RELEASE = "my-app@1.0.0";
    assert.equal(detectRelease(), SHA);
  });

  for (const name of RELEASE_ENV_VARS) {
    void it(`reads ${name}`, () => {
      process.env[name] = SHA;
      assert.equal(detectRelease(), SHA);
    });
  }

  void it("prefers a platform var over git", () => {
    makeRepo(cwd, OTHER_SHA);
    process.env.RAILWAY_GIT_COMMIT_SHA = SHA;
    assert.equal(detectRelease(), SHA);
  });

  void it("falls through empty values", () => {
    process.env.SENTRY_RELEASE = "   ";
    process.env.CIRCLE_SHA1 = SHA;
    assert.equal(detectRelease(""), SHA);
  });

  void it("trims and caps the value", () => {
    assert.equal(detectRelease(`  ${SHA}\n`), SHA);
    assert.equal(
      detectRelease("x".repeat(500)),
      "x".repeat(MAX_RELEASE_LENGTH),
    );
    // By code point: a cut never leaves half a surrogate pair.
    assert.equal(
      detectRelease("😀".repeat(200)),
      "😀".repeat(MAX_RELEASE_LENGTH),
    );
  });
});

void describe("detectRelease on AWS Lambda", () => {
  void it("reads a numbered version", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent";
    process.env.AWS_LAMBDA_FUNCTION_VERSION = "42";
    assert.equal(detectRelease(), "agent:42");
  });

  void it("ignores $LATEST", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent";
    process.env.AWS_LAMBDA_FUNCTION_VERSION = "$LATEST";
    assert.equal(detectRelease(), undefined);
  });

  void it("prefers the Lambda version over git", () => {
    makeRepo(cwd, SHA);
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent";
    process.env.AWS_LAMBDA_FUNCTION_VERSION = "7";
    assert.equal(detectRelease(), "agent:7");
  });
});

void describe("detectRelease from git", () => {
  void it("reads a detached HEAD", () => {
    makeRepo(cwd, SHA);
    assert.equal(detectRelease(), SHA);
  });

  void it("reads a branch ref file", () => {
    const gitDir = makeRepo(cwd, "ref: refs/heads/main");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "refs", "heads", "main"), `${SHA}\n`);
    assert.equal(detectRelease(), SHA);
  });

  void it("reads packed refs", () => {
    const gitDir = makeRepo(cwd, "ref: refs/heads/main");
    writeFileSync(
      join(gitDir, "packed-refs"),
      [
        "# pack-refs with: peeled fully-peeled sorted",
        `${OTHER_SHA} refs/heads/other`,
        `${SHA} refs/heads/main`,
        `^${OTHER_SHA}`,
      ].join("\n"),
    );
    assert.equal(detectRelease(), SHA);
  });

  void it("finds the repository from a subdirectory", () => {
    makeRepo(cwd, SHA);
    const nested = join(cwd, "src", "agent");
    mkdirSync(nested, { recursive: true });
    cwd = nested;
    assert.equal(detectRelease(), SHA);
  });

  void it("resolves a linked worktree through commondir", () => {
    // Main repository: branch refs live here, packed.
    const mainGit = makeRepo(join(root, "main"), "ref: refs/heads/main");
    writeFileSync(join(mainGit, "packed-refs"), `${SHA} refs/heads/feature\n`);
    // Worktree metadata: its own HEAD, plus `commondir` pointing back at main.
    const worktreeMeta = join(mainGit, "worktrees", "feature");
    mkdirSync(worktreeMeta, { recursive: true });
    writeFileSync(join(worktreeMeta, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(worktreeMeta, "commondir"), "../..\n");
    // Worktree checkout: `.git` is a file.
    const checkout = join(root, "feature");
    mkdirSync(checkout);
    writeFileSync(join(checkout, ".git"), `gitdir: ${worktreeMeta}\n`);
    cwd = checkout;
    assert.equal(detectRelease(), SHA);
  });

  void it("detects nothing for an unresolvable ref", () => {
    makeRepo(cwd, "ref: refs/heads/main");
    assert.equal(detectRelease(), undefined);
  });
});

void describe("span stamping", () => {
  const makeTracer = (
    options: ConstructorParameters<typeof LaminarSpanProcessor>[0],
  ) => {
    const exporter = new InMemorySpanExporter();
    const processor = new LaminarSpanProcessor({
      exporter,
      disableBatch: true,
      ...options,
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    return { exporter, tracer: provider.getTracer("plain-otel") };
  };

  void it("stamps the release on every span", () => {
    // No Laminar context is set: the stamp must not depend on one.
    const { exporter, tracer } = makeTracer({ release: "abc1234" });
    tracer.startActiveSpan("root", (root) => {
      tracer.startSpan("child").end();
      root.end();
    });

    const spans = exporter.getFinishedSpans();
    assert.deepEqual(spans.map((span) => span.name).sort(), ["child", "root"]);
    for (const span of spans) {
      assert.equal(span.attributes[SPAN_RELEASE], "abc1234");
    }
  });

  void it("stamps a detected release", () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    const { exporter, tracer } = makeTracer({});
    tracer.startSpan("root").end();

    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_RELEASE], SHA);
  });

  void it("omits the attribute without a release", () => {
    const { exporter, tracer } = makeTracer({});
    tracer.startSpan("root").end();

    const [span] = exporter.getFinishedSpans();
    assert.equal(SPAN_RELEASE in span.attributes, false);
  });

  void it("keeps the release of a wrapped LaminarSpanProcessor", () => {
    const exporter = new InMemorySpanExporter();
    const inner = new LaminarSpanProcessor({
      exporter,
      disableBatch: true,
      release: "inner-release",
    });
    const outer = new LaminarSpanProcessor({ spanProcessor: inner });
    new BasicTracerProvider({ spanProcessors: [outer] })
      .getTracer("plain-otel")
      .startSpan("root")
      .end();

    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_RELEASE], "inner-release");
  });
});
