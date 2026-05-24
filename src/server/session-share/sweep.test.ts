import { describe, expect, test } from "bun:test"
import { startSnapshotSweep } from "./sweep"
import type { SessionShareService } from "./index"

describe("startSnapshotSweep", () => {
  test("runs once immediately on start", async () => {
    let calls = 0
    const fakeService = { runSweep: async () => { calls++; return 0 } } as unknown as SessionShareService
    const handle = startSnapshotSweep(fakeService, 60_000)
    await new Promise(r => setTimeout(r, 5))
    handle.stop()
    expect(calls).toBe(1)
  })

  test("re-runs on the interval and stop() halts it", async () => {
    let calls = 0
    const fakeService = { runSweep: async () => { calls++; return 0 } } as unknown as SessionShareService
    const handle = startSnapshotSweep(fakeService, 10)
    await new Promise(r => setTimeout(r, 45))
    handle.stop()
    const after = calls
    await new Promise(r => setTimeout(r, 30))
    expect(calls).toBe(after)
    expect(after).toBeGreaterThanOrEqual(2)
  })
})
