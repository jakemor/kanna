import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AutoContinueCard } from "./AutoContinueCard"

describe("AutoContinueCard", () => {
  test("proposed state renders Schedule and Dismiss buttons", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "proposed",
          scheduledAt: null,
          tz: "Asia/Saigon",
          resetAt: Date.UTC(2026, 3, 22, 17, 0),
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Schedule")
    expect(html).toContain("Dismiss")
  })

  test("scheduled state renders Change time and Cancel buttons", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "scheduled",
          scheduledAt: Date.UTC(2026, 3, 22, 17, 0),
          tz: "Asia/Saigon",
          resetAt: Date.UTC(2026, 3, 22, 17, 0),
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Change time")
    expect(html).toContain("Cancel")
  })

  test("fired state renders Auto-continued line without controls", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "fired",
          scheduledAt: 1_000,
          tz: "Asia/Saigon",
          resetAt: 1_000,
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Auto-continued")
    expect(html).not.toContain("Cancel")
  })

  test("cancelled state renders Auto-continue cancelled line", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "cancelled",
          scheduledAt: null,
          tz: "Asia/Saigon",
          resetAt: 1_000,
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Auto-continue cancelled")
  })
})
