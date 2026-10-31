import { describe, expect, test } from "bun:test"
import {
  getConnectionHealth,
  msUntilConnectionHealthCheck,
  RECONNECT_FAILURES_BEFORE_LOST,
  RECONNECT_GRACE_MS,
  RECONNECT_LOST_AFTER_MS,
  SOCKET_DISCONNECTED_MESSAGE,
  visibleCommandError,
} from "./connectionHealth"

const down = (failedAttempts: number, downForMs: number, hasConnected = true) =>
  getConnectionHealth({ open: false, hasConnected, failedAttempts, downForMs })

describe("getConnectionHealth", () => {
  test("an open socket is connected whatever came before", () => {
    expect(getConnectionHealth({ open: true, hasConnected: true, failedAttempts: 9, downForMs: 60_000 })).toBe("connected")
  })

  test("a drop reads as reconnecting through the first failed attempts", () => {
    for (let attempts = 0; attempts < RECONNECT_FAILURES_BEFORE_LOST; attempts++) {
      expect(down(attempts, RECONNECT_GRACE_MS)).toBe("reconnecting")
    }
  })

  test("quick failures inside the grace window stay quiet", () => {
    expect(down(RECONNECT_FAILURES_BEFORE_LOST + 2, RECONNECT_GRACE_MS - 1)).toBe("reconnecting")
  })

  test("enough failures past the grace window read as lost", () => {
    expect(down(RECONNECT_FAILURES_BEFORE_LOST, RECONNECT_GRACE_MS)).toBe("lost")
  })

  test("a hung attempt reads as lost once down long enough", () => {
    expect(down(0, RECONNECT_LOST_AFTER_MS - 1)).toBe("reconnecting")
    expect(down(0, RECONNECT_LOST_AFTER_MS)).toBe("lost")
  })

  test("before the first connection it reads as connecting, then lost after the same threshold", () => {
    expect(down(1, 1_000, false)).toBe("connecting")
    expect(down(RECONNECT_FAILURES_BEFORE_LOST, RECONNECT_GRACE_MS, false)).toBe("lost")
  })
})

describe("msUntilConnectionHealthCheck", () => {
  test("wakes at the grace deadline, then at the lost deadline, then never", () => {
    expect(msUntilConnectionHealthCheck(1_000)).toBe(RECONNECT_GRACE_MS - 1_000)
    expect(msUntilConnectionHealthCheck(RECONNECT_GRACE_MS)).toBe(RECONNECT_LOST_AFTER_MS - RECONNECT_GRACE_MS)
    expect(msUntilConnectionHealthCheck(RECONNECT_LOST_AFTER_MS)).toBeNull()
  })
})

describe("visibleCommandError", () => {
  test("hides a command that died with its socket until the connection is lost", () => {
    expect(visibleCommandError(SOCKET_DISCONNECTED_MESSAGE, "reconnecting")).toBeNull()
    expect(visibleCommandError(SOCKET_DISCONNECTED_MESSAGE, "connecting")).toBeNull()
    expect(visibleCommandError(SOCKET_DISCONNECTED_MESSAGE, "lost")).toBe(SOCKET_DISCONNECTED_MESSAGE)
  })

  test("clears it once reconnected", () => {
    expect(visibleCommandError(SOCKET_DISCONNECTED_MESSAGE, "connected")).toBeNull()
  })

  test("shows any other error as it comes", () => {
    expect(visibleCommandError("Chat not found", "reconnecting")).toBe("Chat not found")
    expect(visibleCommandError(null, "lost")).toBeNull()
  })
})
