import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { runTest } from "./effect/testing"
import { TerminalDetection } from "./terminal-detection"

describe("TerminalDetection", () => {
  test("never reports a macOS-only terminal elsewhere", async () => {
    const terminals = await runTest(Effect.gen(function* () {
      const detection = yield* TerminalDetection
      return yield* detection.detect({ force: true })
    }).pipe(Effect.provide(TerminalDetection.layer({ platform: "linux" }))))

    expect(terminals).not.toContain("terminal")
    expect(terminals).not.toContain("iterm")
  })

  test("caches, and refresh publishes the cached result", async () => {
    let published: unknown = null
    const first = await runTest(Effect.gen(function* () {
      const detection = yield* TerminalDetection
      const first = yield* detection.detect({ force: true })
      yield* detection.refresh({ setInstalledTerminals: (terminals) => { published = terminals } })
      return first
    }).pipe(Effect.provide(TerminalDetection.layer())))

    expect(published).toBe(first)
  })
})
