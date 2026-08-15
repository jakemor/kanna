import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProviderUsageSnapshot, UsageLimitWindow } from "../../../shared/types"
import { ProviderCard } from "./UsageSection"

function makeWindow(id: string, label: string, windowMinutes: number | null): UsageLimitWindow {
  return {
    id,
    label,
    usedPercent: 10,
    resetsAt: null,
    windowMinutes,
    modelLabel: null,
    recordedAt: "2026-08-15T00:00:00.000Z",
    source: "cache",
  }
}

function makeSnapshot(windows: UsageLimitWindow[]): ProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "ok",
    plan: null,
    windows,
    credits: null,
    detail: null,
    updatedAt: null,
  }
}

describe("ProviderCard", () => {
  test("renders a window of unknown period after the windows with a known period", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        snapshot={makeSnapshot([
          makeWindow("nimbus_quill", "Nimbus Quill", null),
          makeWindow("five_hour", "Current session", 300),
        ])}
      />,
    )

    expect(html).toContain("Current session")
    expect(html).toContain("Nimbus Quill")
    expect(html.indexOf("Current session")).toBeLessThan(html.indexOf("Nimbus Quill"))
  })

  test("keeps wire order when no window reports a period", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        snapshot={makeSnapshot([
          makeWindow("five_hour", "Current session", null),
          makeWindow("seven_day", "Weekly", null),
        ])}
      />,
    )

    expect(html.indexOf("Current session")).toBeLessThan(html.indexOf("Weekly"))
  })
})
