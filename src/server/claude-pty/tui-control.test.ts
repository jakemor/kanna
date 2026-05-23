import { describe, expect, test } from "bun:test"
import {
  sendUserPrompt,
  sendExitCommand,
  dismissTrustDialogIfPresent,
  waitForTuiReady,
  waitForTuiReadyWithTrustDismiss,
  TRUST_DIALOG_MARKER,
  TUI_READY_MARKER,
} from "./tui-control"
import { OutputRing } from "./output-ring"
import type { PtyProcess } from "./pty-process.adapter"

function fakePty(): PtyProcess & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    pid: 99997,
    async sendInput(data: string) { sent.push(data) },
    resize() { /* noop */ },
    exited: new Promise<number>(() => { /* never */ }),
    close() { /* noop */ },
    kill() { /* noop */ },
  } as PtyProcess & { sent: string[] }
}

describe("sendUserPrompt", () => {
  test("writes bracketed-paste wrapped text then separate carriage return once ring grows", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    // Simulate the TUI rendering the paste preview shortly after the paste write.
    setTimeout(() => ring.append("[Pasted text #1 +56 lines]"), 5)
    await sendUserPrompt(pty, ring, "say hi", { commitTimeoutMs: 500, pollMs: 1 })
    expect(pty.sent).toEqual(["\x1b[200~say hi\x1b[201~", "\r"])
  })

  test("empty string still emits paste markers + carriage return after commit", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    setTimeout(() => ring.append("x"), 5)
    await sendUserPrompt(pty, ring, "", { commitTimeoutMs: 500, pollMs: 1 })
    expect(pty.sent).toEqual(["\x1b[200~\x1b[201~", "\r"])
  })

  test("sends Enter after commitTimeoutMs even if the ring never grows (degraded fallback)", async () => {
    const pty = fakePty()
    const ring = new OutputRing() // never grows
    const start = Date.now()
    await sendUserPrompt(pty, ring, "no echo", { commitTimeoutMs: 50, pollMs: 5 })
    const elapsed = Date.now() - start
    expect(pty.sent).toEqual(["\x1b[200~no echo\x1b[201~", "\r"])
    expect(elapsed).toBeGreaterThanOrEqual(45)
  })
})

describe("sendExitCommand", () => {
  test("writes /exit + carriage return", async () => {
    const pty = fakePty()
    await sendExitCommand(pty)
    expect(pty.sent).toEqual(["/exit\r"])
  })
})

describe("dismissTrustDialogIfPresent", () => {
  test("sends carriage return when ringbuf contains trust marker", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("Quick safety check: Do you trust this folder? trust this folder")
    const dismissed = await dismissTrustDialogIfPresent(pty, ring)
    expect(dismissed).toBe(true)
    expect(pty.sent).toEqual(["\r"])
  })

  test("does nothing when ringbuf lacks trust marker", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("Welcome back c!")
    const dismissed = await dismissTrustDialogIfPresent(pty, ring)
    expect(dismissed).toBe(false)
    expect(pty.sent).toEqual([])
  })

  test("exported TRUST_DIALOG_MARKER is the substring matched", () => {
    expect(TRUST_DIALOG_MARKER).toBe("trust this folder")
  })
})

describe("waitForTuiReady", () => {
  test("returns 'marker' when ringbuf already contains the input-box marker", async () => {
    const ring = new OutputRing()
    ring.append("❯ ")
    const result = await waitForTuiReady(ring, { hardCapMs: 1000, pollMs: 10 })
    expect(result).toBe("marker")
  })

  test("returns 'timeout' when no marker appears within hardCapMs", async () => {
    const ring = new OutputRing()
    const result = await waitForTuiReady(ring, { hardCapMs: 200, pollMs: 10 })
    expect(result).toBe("timeout")
  })

  test("polls until marker appears", async () => {
    const ring = new OutputRing()
    setTimeout(() => ring.append("❯ "), 50)
    const start = Date.now()
    const result = await waitForTuiReady(ring, { hardCapMs: 1000, pollMs: 10 })
    const elapsed = Date.now() - start
    expect(result).toBe("marker")
    expect(elapsed).toBeLessThan(300)
  })

  test("exported TUI_READY_MARKER is the input-box prompt", () => {
    expect(TUI_READY_MARKER).toBe("❯ ")
  })

  test("returns 'marker' when TUI renders ❯ with \\x1b[1C instead of space", async () => {
    const ring = new OutputRing()
    // Real TUI output: space after ❯ is cursor-forward-1, not a literal space
    ring.append("❯\x1b[1C")
    const result = await waitForTuiReady(ring, { hardCapMs: 1000, pollMs: 10 })
    expect(result).toBe("marker")
  })

  test("returns 'marker' when TUI renders ❯ followed by U+00A0 (non-breaking space)", async () => {
    const ring = new OutputRing()
    // Real TUI output: ❯ is followed by NBSP (U+00A0), not a regular space
    ring.append("❯ ")
    const result = await waitForTuiReady(ring, { hardCapMs: 1000, pollMs: 10 })
    expect(result).toBe("marker")
  })
})

describe("dismissTrustDialogIfPresent (ANSI-encoded ring)", () => {
  test("detects trust dialog when words separated by \\x1b[1C (TUI rendering)", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    // Real TUI output: spaces rendered as cursor-forward-1 escape sequences
    ring.append("\x1b[1C❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\r\n")
    const dismissed = await dismissTrustDialogIfPresent(pty, ring)
    expect(dismissed).toBe(true)
    expect(pty.sent).toEqual(["\r"])
  })

  test("does not false-trigger on plain text without trust marker", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("\x1b[1CWelcome\x1b[1Cback!\x1b[0m❯ ")
    const dismissed = await dismissTrustDialogIfPresent(pty, ring)
    expect(dismissed).toBe(false)
    expect(pty.sent).toEqual([])
  })
})

describe("waitForTuiReadyWithTrustDismiss", () => {
  test("returns 'ready' immediately when input box already present", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("❯ ")
    const result = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 500, pollMs: 10 })
    expect(result).toBe("ready")
    expect(pty.sent).toEqual([])
  })

  test("dismisses ANSI trust dialog then resolves when input box appears", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    // Trust dialog with ANSI-encoded text appears first
    ring.append("\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder")
    // After 50ms simulate TUI loading: input box appears after dismiss sends \r
    setTimeout(() => ring.append("❯ "), 80)
    const result = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 1000, pollMs: 10 })
    expect(result).toBe("ready")
    expect(pty.sent).toContain("\r")
  })

  test("returns 'timeout' when neither marker appears", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    const result = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 150, pollMs: 10 })
    expect(result).toBe("timeout")
    expect(pty.sent).toEqual([])
  })

  test("returns 'ready' when TUI renders ❯ with \\x1b[1C (ANSI cursor-forward)", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("❯\x1b[1C")
    const result = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 500, pollMs: 10 })
    expect(result).toBe("ready")
    expect(pty.sent).toEqual([])
  })

  test("does not false-trigger on trust dialog's own ❯ selection cursor", async () => {
    // Trust dialog renders "❯ 1. Yes, I trust this folder" as ANSI:
    // "❯\x1b[1C1.\x1b[1CYes,...trust\x1b[1Cthis\x1b[1Cfolder"
    // stripAnsi gives "❯ 1. Yes, I trust this folder" which contains "❯ "
    // → must NOT trigger "ready" while trust dialog is present
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("\x1b[1C❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\r\n")
    setTimeout(() => ring.append("❯\x1b[1C"), 80)
    const result = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 1000, pollMs: 10 })
    expect(result).toBe("ready")
    expect(pty.sent).toContain("\r")
  })

  test("dismisses trust dialog only once even if marker persists in ring", async () => {
    const pty = fakePty()
    const ring = new OutputRing()
    ring.append("\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder")
    setTimeout(() => ring.append("❯ "), 80)
    await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: 1000, pollMs: 10 })
    // \r should appear exactly once (dismiss sent once, not repeated each poll)
    expect(pty.sent.filter((s) => s === "\r")).toHaveLength(1)
  })
})
