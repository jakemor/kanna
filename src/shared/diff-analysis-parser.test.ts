import { describe, expect, test } from "bun:test"
import { extractPartialSummaryPreview, parseAgentResponse } from "./diff-analysis-parser"

describe("parseAgentResponse", () => {
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
--- END SUMMARY ---`)

    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]?.diff.includes("@@ -1 +1 @@")).toBe(true)
    expect(parsed.hunks[0]?.description).toBe("Updates the model value so dependent services read the new shape.")
    expect(parsed.summary).toBe("The change updates the model shape and keeps downstream callers aligned.")
    expect(parsed.partial).toBe("")
    expect(parsed.isComplete).toBe(true)
  })

  test("exposes incomplete hunk as partial streaming text", () => {
    const parsed = parseAgentResponse(`--- HUNK ---
diff --git a/service.js b/service.js
@@ -4 +4 @@
-return false
+return true`)

    expect(parsed.hunks).toHaveLength(0)
    expect(parsed.partial.startsWith("--- HUNK ---")).toBe(true)
    expect(parsed.isComplete).toBe(false)
  })

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
--- END HUNK ---`)

    expect(parsed.hunks.map((hunk) => hunk.description)).toEqual(["First.", "Second."])
  })

  test("parses compact change note blocks without diff content", () => {
    const parsed = parseAgentResponse(`--- CHANGE NOTE ---
ID: H002

Description: Updates the service after the model contract changed.
--- END CHANGE NOTE ---

--- SUMMARY ---
The service now follows the new model contract.
--- END SUMMARY ---`)

    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]?.id).toBe("H002")
    expect(parsed.hunks[0]?.diff).toBe("")
    expect(parsed.hunks[0]?.description).toBe("Updates the service after the model contract changed.")
    expect(parsed.summary).toBe("The service now follows the new model contract.")
  })

  test("keeps only the first duplicate note for a source id", () => {
    const parsed = parseAgentResponse(`--- CHANGE NOTE ---
ID: H001

Description: First.
--- END CHANGE NOTE ---
--- CHANGE NOTE ---
ID: H001

Description: Duplicate.
--- END CHANGE NOTE ---`)

    expect(parsed.hunks.map((hunk) => hunk.description)).toEqual(["First."])
  })

  test("extracts a usable preview from an unterminated summary block", () => {
    expect(extractPartialSummaryPreview(`--- SUMMARY ---
This is the final summary without a closing marker.`)).toBe(
      "This is the final summary without a closing marker."
    )
  })
})
