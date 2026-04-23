import { describe, expect, test } from "bun:test"
import { formatBashCommandTitle, formatDuration, formatSidebarAgeLabel } from "./formatters"

describe("formatBashCommandTitle", () => {
  test("unwraps codex zsh -lc commands", () => {
    expect(formatBashCommandTitle("/bin/zsh -lc 'bun test --help'")).toBe("bun test --help")
  })

  test("unwraps unquoted shell wrapper commands", () => {
    expect(formatBashCommandTitle("/bin/zsh -lc pwd")).toBe("pwd")
  })

  test("unwraps env-prefixed bash commands", () => {
    expect(formatBashCommandTitle("/usr/bin/env bash -lc \"npm run check\"")).toBe("npm run check")
  })

  test("unwraps sh -c commands", () => {
    expect(formatBashCommandTitle("sh -c 'ls -la src'")).toBe("ls -la src")
  })

  test("unwraps cmd /c commands", () => {
    expect(formatBashCommandTitle("cmd /c \"dir\"")).toBe("dir")
  })

  test("unwraps powershell command invocations", () => {
    expect(formatBashCommandTitle("powershell -NoProfile -Command \"Get-ChildItem\"")).toBe("Get-ChildItem")
  })

  test("leaves plain commands alone", () => {
    expect(formatBashCommandTitle("bun test --help")).toBe("bun test --help")
  })
})

describe("formatDuration", () => {
  test("formats sub-second values", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1s")
    expect(formatDuration(1500)).toBe("1s")
    expect(formatDuration(59_000)).toBe("59s")
  })

  test("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m")
    expect(formatDuration(62_000)).toBe("1m 2s")
    expect(formatDuration(3_599_000)).toBe("59m 59s")
  })

  test("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h")
    expect(formatDuration(3_660_000)).toBe("1h 1m")
    expect(formatDuration(7_200_000)).toBe("2h")
  })
})

describe("formatSidebarAgeLabel", () => {
  const now = Date.UTC(2026, 2, 17, 12, 0, 0)

  test("returns null when there is no sent message timestamp", () => {
    expect(formatSidebarAgeLabel(undefined, now)).toBeNull()
  })

  test("clamps future timestamps to now", () => {
    expect(formatSidebarAgeLabel(now + 1_000, now)).toBe("now")
  })

  test("shows now for sub-minute deltas", () => {
    expect(formatSidebarAgeLabel(now, now)).toBe("now")
    expect(formatSidebarAgeLabel(now - 59_000, now)).toBe("now")
  })

  test("shows whole minutes for under an hour", () => {
    expect(formatSidebarAgeLabel(now - 60_000, now)).toBe("1m")
    expect(formatSidebarAgeLabel(now - 61_000, now)).toBe("1m")
    expect(formatSidebarAgeLabel(now - 30 * 60_000, now)).toBe("30m")
  })

  test("shows whole hours for under a day", () => {
    expect(formatSidebarAgeLabel(now - 60 * 60_000, now)).toBe("1h")
    expect(formatSidebarAgeLabel(now - 16 * 60 * 60_000, now)).toBe("16h")
  })

  test("shows whole days for under a week", () => {
    expect(formatSidebarAgeLabel(now - 24 * 60 * 60_000, now)).toBe("1d")
    expect(formatSidebarAgeLabel(now - 6 * 24 * 60 * 60_000, now)).toBe("6d")
  })

  test("shows whole weeks for seven days and up", () => {
    expect(formatSidebarAgeLabel(now - 7 * 24 * 60 * 60_000, now)).toBe("1w")
    expect(formatSidebarAgeLabel(now - 14 * 24 * 60 * 60_000, now)).toBe("2w")
  })
})
