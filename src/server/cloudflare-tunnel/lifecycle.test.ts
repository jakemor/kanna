import { describe, expect, test } from "bun:test"
import { TunnelLifecycle } from "./lifecycle"

describe("TunnelLifecycle", () => {
  test("polls source PID; calls onSourceExit when process gone", async () => {
    const exited: string[] = []
    let alive = true
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => alive,
      onSourceExit: (id: string) => exited.push(id),
    })
    lc.watch("t1", 1234)
    alive = false
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toContain("t1")
    lc.shutdown()
  })

  test("unwatch stops polling for a tunnel", async () => {
    const exited: string[] = []
    let alive = true
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => alive,
      onSourceExit: (id: string) => exited.push(id),
    })
    lc.watch("t1", 1234)
    lc.unwatch("t1")
    alive = false
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toEqual([])
    lc.shutdown()
  })

  test("does not fire onSourceExit when sourcePid is null", async () => {
    const exited: string[] = []
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => false,
      onSourceExit: (id: string) => exited.push(id),
    })
    lc.watch("t1", null)
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toEqual([])
    lc.shutdown()
  })
})
