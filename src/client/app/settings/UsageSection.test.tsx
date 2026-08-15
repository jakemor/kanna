import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProviderUsageSnapshot, UsageLimitWindow } from "../../../shared/types"
import { ProviderCard } from "./UsageSection"

function makeWindow(id: string, label: string): UsageLimitWindow {
  return {
    id,
    label,
    usedPercent: 10,
    resetsAt: null,
    windowMinutes: null,
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
  test("renders Nimbus Quill after the other usage windows", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        snapshot={makeSnapshot([
          makeWindow("nimbus_quill", "Nimbus Quill"),
          makeWindow("five_hour", "Current session"),
        ])}
      />,
    )

    expect(html.indexOf("Current session")).toBeLessThan(html.indexOf("Nimbus Quill"))
  })
})
