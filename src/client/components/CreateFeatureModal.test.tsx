import { describe, expect, test } from "bun:test"
import { canSubmitFeatureDraft } from "./CreateFeatureModal"

describe("canSubmitFeatureDraft", () => {
  test("requires a non-empty title", () => {
    expect(canSubmitFeatureDraft("")).toBe(false)
    expect(canSubmitFeatureDraft("   ")).toBe(false)
    expect(canSubmitFeatureDraft("Feature A")).toBe(true)
  })
 
  test("trims titles before allowing submit", () => {
    expect(canSubmitFeatureDraft("  Feature A  ")).toBe(true)
  })
})
