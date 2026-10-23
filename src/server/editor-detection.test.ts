import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { runTest } from "./effect/testing"
import { EditorDetection } from "./editor-detection"

describe("EditorDetection", () => {
  test("always reports custom, and never Xcode off macOS", async () => {
    const editors = await runTest(Effect.gen(function* () {
      const detection = yield* EditorDetection
      return yield* detection.detect({ force: true })
    }).pipe(Effect.provide(EditorDetection.layer({ platform: "linux" }))))

    expect(editors).toContain("custom")
    expect(editors).not.toContain("xcode")
  })

  test("caches, so a menu opening repeatedly doesn't re-probe the machine", async () => {
    const [first, second] = await runTest(Effect.gen(function* () {
      const detection = yield* EditorDetection
      const first = yield* detection.detect({ force: true })
      return [first, yield* detection.detect()] as const
    }).pipe(Effect.provide(EditorDetection.layer())))

    // Same array instance: the second call never reached the probes.
    expect(second).toBe(first)
  })

  test("callers that ask while a probe runs share it", async () => {
    const [first, second] = await runTest(Effect.gen(function* () {
      const detection = yield* EditorDetection
      return yield* Effect.all([detection.detect({ force: true }), detection.detect({ force: true })], { concurrency: 2 })
    }).pipe(Effect.provide(EditorDetection.layer())))

    expect(second).toBe(first)
  })

  test("refresh publishes what it detected", async () => {
    let published: string[] = []
    await runTest(Effect.gen(function* () {
      const detection = yield* EditorDetection
      yield* detection.refresh({ setInstalledEditors: (editors) => { published = editors } })
    }).pipe(Effect.provide(EditorDetection.layer({ platform: "linux" }))))

    expect(published).toContain("custom")
  })
})
