import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ExitPlanModeMessage } from "./ExitPlanModeMessage"

describe("ExitPlanModeMessage", () => {
  const message = {
    id: "msg-1",
    kind: "tool" as const,
    toolKind: "exit_plan_mode" as const,
    toolName: "ExitPlanMode",
    toolId: "exit-1",
    input: {
      plan: "## Plan",
    },
    timestamp: new Date(0).toISOString(),
  }

  test("hides actions when the plan is not actionable", () => {
    const html = renderToStaticMarkup(
      <ExitPlanModeMessage
        message={message}
        onConfirm={() => {}}
        isLatest={true}
        isActionable={false}
      />
    )

    expect(html).toContain("Plan pending")
    expect(html).not.toContain("Approve &amp; Clear")
    expect(html).not.toContain("Suggest Edits")
    expect(html).not.toContain(">Approve<")
  })

  test("preserves existing action buttons when the plan is actionable", () => {
    const html = renderToStaticMarkup(
      <ExitPlanModeMessage
        message={message}
        onConfirm={() => {}}
        isLatest={true}
        isActionable={true}
      />
    )

    expect(html).toContain("Approve &amp; Clear")
    expect(html).toContain("Suggest Edits")
    expect(html).toContain(">Approve<")
  })
})
