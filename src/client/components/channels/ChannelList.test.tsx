import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarProjectGitState } from "../../../shared/types"
import { ChannelRowTrailing } from "./ChannelList"

const DIRTY: SidebarProjectGitState = { dirty: true, ahead: 0, untrackedOnly: false, additions: 36, deletions: 38 }

function render(gitState: SidebarProjectGitState | undefined, attentionCount = 0) {
  return renderToStaticMarkup(<div>{ChannelRowTrailing({ gitState, attentionCount })}</div>)
}

describe("ChannelRowTrailing", () => {
  test("shows the changes just left of the chat badge", () => {
    const html = render(DIRTY, 2)
    expect(html).toContain("+36")
    expect(html).toContain("-38")
    expect(html.indexOf("-38")).toBeLessThan(html.indexOf("data-channel-badge"))
  })

  test("is the last thing on the row without a badge, so it sits at the right edge", () => {
    const html = render(DIRTY)
    expect(html).not.toContain("data-channel-badge")
    expect(html.endsWith("</span></span></div>")).toBe(true)
    // Neither the stat nor the badge gives way to a long name.
    expect(html).toContain("shrink-0")
  })

  test("drops a half that is zero", () => {
    const html = render({ ...DIRTY, deletions: 0 })
    expect(html).toContain("+36")
    expect(html).not.toContain(">-0<")
    expect(html).not.toContain("text-red")
  })

  test("shows nothing for a clean repo, untracked-only work, zero counts or no git state", () => {
    for (const gitState of [
      { dirty: false, ahead: 0, untrackedOnly: false },
      // Ahead only: unpushed, but nothing uncommitted to count.
      { dirty: false, ahead: 3, untrackedOnly: false, additions: 0, deletions: 0 },
      { dirty: false, ahead: 0, untrackedOnly: true },
      { ...DIRTY, additions: 0, deletions: 0 },
      // A server that predates the counts.
      { dirty: true, ahead: 0, untrackedOnly: false },
      undefined,
    ]) {
      expect(render(gitState)).toBe("<div></div>")
    }
  })
})
