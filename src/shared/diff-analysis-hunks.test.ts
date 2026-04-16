import { describe, expect, test } from "bun:test"
import { parseUnifiedDiffHunks } from "./diff-analysis-hunks"

describe("parseUnifiedDiffHunks", () => {
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
+return true`)

    expect(hunks).toHaveLength(3)
    expect(hunks.map((hunk) => hunk.id)).toEqual(["H001", "H002", "H003"])
    expect(hunks[0]?.file).toBe("src/model.js")
    expect(hunks[1]?.title).toBe("H002 src/model.js hunk 2")
    expect(hunks[2]?.diff.includes("src/service.js")).toBe(true)
  })

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
     }`)

    expect(blocks).toHaveLength(3)
    expect(blocks.map((block) => block.id)).toEqual(["H001", "H002", "H003"])
    expect(blocks[0]?.title).toBe("H001 producer.py block 1")
    expect(blocks[1]?.diff.includes("if localhost or loopback")).toBe(true)
    expect(blocks[1]?.diff.includes('"retries": config.RETRIES')).toBe(false)
    expect(blocks[2]?.diff.includes('"retries": config.RETRIES')).toBe(true)
  })

  test("keeps expandable context outside the compact hunk body", () => {
    const before = Array.from({ length: 12 }, (_, index) => ` line ${index + 1}`)
    const after = Array.from({ length: 12 }, (_, index) => ` line ${index + 13}`)
    const blocks = parseUnifiedDiffHunks(`diff --git a/example.js b/example.js
--- a/example.js
+++ b/example.js
@@ -1,25 +1,25 @@
${before.join("\n")}
- old value
+ new value
${after.join("\n")}`)

    expect(blocks).toHaveLength(1)
    const compactLines = blocks[0]?.diff.split("\n") ?? []
    expect(blocks[0]?.contextBefore).toEqual(before.slice(0, 10))
    expect(blocks[0]?.contextAfter).toEqual(after.slice(2, 12))
    expect(compactLines.includes(" line 1")).toBe(false)
    expect(compactLines.includes(" line 11")).toBe(true)
    expect(compactLines.includes(" line 15")).toBe(false)
  })
})
