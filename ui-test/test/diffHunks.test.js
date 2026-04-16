import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiffHunks } from "../shared/diffHunks.js";

test("splits a unified diff into stable source hunk ids", () => {
  const hunks = parseUnifiedDiffHunks(`diff --git a/src/model.js b/src/model.js
--- a/src/model.js
+++ b/src/model.js
@@ -1 +1 @@
-old
+new
@@ -8 +8 @@
-disabled
+enabled
diff --git a/src/service.js b/src/service.js
--- a/src/service.js
+++ b/src/service.js
@@ -2 +2 @@
-return false
+return true`);

  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks.map((hunk) => hunk.id), ["H001", "H002", "H003"]);
  assert.equal(hunks[0].file, "src/model.js");
  assert.equal(hunks[1].title, "H002 src/model.js hunk 2");
  assert.equal(hunks[2].diff.includes("src/service.js"), true);
});

test("splits multiple change runs inside one git hunk into separate blocks", () => {
  const blocks = parseUnifiedDiffHunks(`diff --git a/producer.py b/producer.py
--- a/producer.py
+++ b/producer.py
@@ -1,12 +1,15 @@
 def build():
     payload = load()
-
+
     protocol = "SSL"
-    if localhost:
+    if localhost or loopback:
+        protocol = "PLAINTEXT"
 
     options = {
-        "retries": 1,
-        "timeout": 10,
+        "retries": config.RETRIES,
+        "timeout": config.TIMEOUT,
     }`);

  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((block) => block.id), ["H001", "H002", "H003"]);
  assert.equal(blocks[0].title, "H001 producer.py block 1");
  assert.equal(blocks[1].diff.includes("if localhost or loopback"), true);
  assert.equal(blocks[1].diff.includes('"retries": config.RETRIES'), false);
  assert.equal(blocks[2].diff.includes('"retries": config.RETRIES'), true);
});

test("keeps expandable context outside the compact hunk body", () => {
  const before = Array.from({ length: 12 }, (_, index) => ` line ${index + 1}`);
  const after = Array.from({ length: 12 }, (_, index) => ` line ${index + 13}`);
  const blocks = parseUnifiedDiffHunks(`diff --git a/example.js b/example.js
--- a/example.js
+++ b/example.js
@@ -1,25 +1,25 @@
${before.join("\n")}
- old value
+ new value
${after.join("\n")}`);

  assert.equal(blocks.length, 1);
  const compactLines = blocks[0].diff.split("\n");
  assert.deepEqual(blocks[0].contextBefore, before.slice(0, 10));
  assert.deepEqual(blocks[0].contextAfter, after.slice(2, 12));
  assert.equal(compactLines.includes(" line 1"), false);
  assert.equal(compactLines.includes(" line 11"), true);
  assert.equal(compactLines.includes(" line 15"), false);
});
