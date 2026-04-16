import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentResponse } from "../shared/parseAgentResponse.js";

test("parses completed hunk blocks and summary", () => {
  const parsed = parseAgentResponse(`--- HUNK ---
diff --git a/model.js b/model.js
@@ -1 +1 @@
-old
+new

Description: Updates the model value so dependent services read the new shape.

--- END HUNK ---

--- SUMMARY ---
The change updates the model shape and keeps downstream callers aligned.
--- END SUMMARY ---`);

  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].diff.includes("@@ -1 +1 @@"), true);
  assert.equal(parsed.hunks[0].description, "Updates the model value so dependent services read the new shape.");
  assert.equal(parsed.summary, "The change updates the model shape and keeps downstream callers aligned.");
  assert.equal(parsed.partial, "");
  assert.equal(parsed.isComplete, true);
});

test("exposes incomplete hunk as partial streaming text", () => {
  const parsed = parseAgentResponse(`--- HUNK ---
diff --git a/service.js b/service.js
@@ -4 +4 @@
-return false
+return true`);

  assert.equal(parsed.hunks.length, 0);
  assert.equal(parsed.partial.startsWith("--- HUNK ---"), true);
  assert.equal(parsed.isComplete, false);
});

test("parses multiple hunks in order", () => {
  const parsed = parseAgentResponse(`--- HUNK ---
@@ -1 +1 @@
-a
+b

Description: First.
--- END HUNK ---
--- HUNK ---
@@ -2 +2 @@
-c
+d

Description: Second.
--- END HUNK ---`);

  assert.deepEqual(parsed.hunks.map((hunk) => hunk.description), ["First.", "Second."]);
});

test("parses compact change note blocks without diff content", () => {
  const parsed = parseAgentResponse(`--- CHANGE NOTE ---
ID: H002

Description: Updates the service after the model contract changed.
--- END CHANGE NOTE ---

--- SUMMARY ---
The service now follows the new model contract.
--- END SUMMARY ---`);

  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].id, "H002");
  assert.equal(parsed.hunks[0].diff, "");
  assert.equal(parsed.hunks[0].description, "Updates the service after the model contract changed.");
  assert.equal(parsed.summary, "The service now follows the new model contract.");
});
