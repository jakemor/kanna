import test from "node:test";
import assert from "node:assert/strict";
import { computeDiffStats } from "../shared/diffStats.js";

test("computes unified diff stats", () => {
  const stats = computeDiffStats(`diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 const b = 3
diff --git a/b.js b/b.js
@@ -1 +1,2 @@
+new line`);

  assert.deepEqual(stats, {
    files: 2,
    hunks: 2,
    additions: 2,
    deletions: 1,
    lines: 10,
  });
});
