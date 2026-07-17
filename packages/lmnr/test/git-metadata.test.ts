import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  collectGitMetadata,
  GIT_BRANCH_METADATA_KEY,
  GIT_COMMIT_METADATA_KEY,
  GIT_DIRTY_METADATA_KEY,
  resetGitMetadataCache,
} from "../src/git-metadata";

const git = (cwd: string, args: string): string =>
  execSync(`git ${args}`, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
    .toString("utf-8")
    .trim();

const makeGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lmnr-git-meta-"));
  git(dir, "init --initial-branch=main");
  writeFileSync(join(dir, "tracked.txt"), "v1");
  git(dir, "add tracked.txt");
  git(dir, 'commit -m "initial"');
  return dir;
};

const makeEmptyDir = (): string =>
  mkdtempSync(join(tmpdir(), "lmnr-no-git-"));

void describe("collectGitMetadata", () => {
  const originalEnv = process.env;
  const tempDirs: string[] = [];

  void beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LMNR_DISABLE_GIT_METADATA;
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    // Stop git discovery from walking up from the temp dir into a real repo.
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    resetGitMetadataCache();
  });
  void afterEach(() => {
    process.env = originalEnv;
    resetGitMetadataCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("collects commit, branch, and clean state from a git repo", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const head = git(repo, "rev-parse HEAD");

    const metadata = collectGitMetadata(repo);
    assert.strictEqual(metadata[GIT_COMMIT_METADATA_KEY], head);
    assert.strictEqual(metadata[GIT_BRANCH_METADATA_KEY], "main");
    assert.strictEqual(metadata[GIT_DIRTY_METADATA_KEY], false);
  });

  void it("flips dirty on tracked-file modification", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    writeFileSync(join(repo, "tracked.txt"), "v2");

    const metadata = collectGitMetadata(repo);
    assert.strictEqual(metadata[GIT_DIRTY_METADATA_KEY], true);
  });

  void it("does not flip dirty on untracked files", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    writeFileSync(join(repo, "untracked.txt"), "scratch");

    const metadata = collectGitMetadata(repo);
    assert.strictEqual(metadata[GIT_DIRTY_METADATA_KEY], false);
  });

  void it("omits branch on a detached HEAD", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const head = git(repo, "rev-parse HEAD");
    git(repo, `checkout --detach ${head}`);

    const metadata = collectGitMetadata(repo);
    assert.strictEqual(metadata[GIT_COMMIT_METADATA_KEY], head);
    assert.strictEqual(GIT_BRANCH_METADATA_KEY in metadata, false);
  });

  void it("collects nothing outside a repo with no CI env", () => {
    const dir = makeEmptyDir();
    tempDirs.push(dir);

    const metadata = collectGitMetadata(dir);
    assert.deepStrictEqual(metadata, {});
  });

  void it("falls back to CI env vars outside a repo", () => {
    const dir = makeEmptyDir();
    tempDirs.push(dir);
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "feature-x";

    const metadata = collectGitMetadata(dir);
    assert.strictEqual(metadata[GIT_COMMIT_METADATA_KEY], "abc123");
    assert.strictEqual(metadata[GIT_BRANCH_METADATA_KEY], "feature-x");
    assert.strictEqual(GIT_DIRTY_METADATA_KEY in metadata, false);
  });

  void it("prefers real git state over CI env vars", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    process.env.GITHUB_SHA = "not-the-real-sha";

    const metadata = collectGitMetadata(repo);
    assert.notStrictEqual(metadata[GIT_COMMIT_METADATA_KEY], "not-the-real-sha");
  });

  void it("is disabled by LMNR_DISABLE_GIT_METADATA", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    process.env.LMNR_DISABLE_GIT_METADATA = "true";

    assert.deepStrictEqual(collectGitMetadata(repo), {});
  });

  void it("caches the first collection for the process lifetime", () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const first = collectGitMetadata(repo);

    const otherDir = makeEmptyDir();
    tempDirs.push(otherDir);
    const second = collectGitMetadata(otherDir);
    assert.deepStrictEqual(second, first);
  });
});
