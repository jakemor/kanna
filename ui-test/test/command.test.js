import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiffCommand, resolveDiffCommand, splitCommandLine, withUnifiedContext } from "../shared/command.js";

test("parses quoted git diff command", () => {
  assert.deepEqual(splitCommandLine('git diff "main...HEAD" -- "src/app file.js"'), [
    "git",
    "diff",
    "main...HEAD",
    "--",
    "src/app file.js",
  ]);
});

test("allows only git diff commands", () => {
  assert.deepEqual(parseGitDiffCommand("git diff --staged"), ["git", "diff", "--staged"]);
  assert.throws(() => parseGitDiffCommand("git status"), /Only git diff/);
});

test("resolves preset commands", () => {
  assert.deepEqual(resolveDiffCommand({ preset: "working" }), ["git", "diff"]);
});

test("adds unified context without changing pathspecs", () => {
  assert.deepEqual(
    withUnifiedContext(["git", "diff", "-U1", "HEAD~1", "--", "-U1"], 12),
    ["git", "diff", "--unified=12", "HEAD~1", "--", "-U1"],
  );
  assert.deepEqual(
    withUnifiedContext(["git", "diff", "--unified", "3", "--staged"], 12),
    ["git", "diff", "--unified=12", "--staged"],
  );
});
