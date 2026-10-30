import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarProjectGitState } from "../../../shared/types"
import { ChannelRowTrailing } from "./ChannelList"

const DIRTY: SidebarProjectGitState = { dirty: true, ahead: 0, untrackedOnly: false, additions: 36, deletions: 38 }

function render(gitState: SidebarProjectGitState | undefined, attentionCount = 0, active = false) {
  return renderToStaticMarkup(<div>{ChannelRowTrailing({ gitState, attentionCount, active })}</div>)
}

/** The class list of the element carrying the changes. */
function changesClass(html: string) {
  return /<span data-channel-changes="true" class="([^"]*)"/u.exec(html)?.[1] ?? ""
}

describe("ChannelRowTrailing", () => {
  test("puts the changes just left of the chat badge", () => {
    const html = render(DIRTY, 2)
    expect(html).toContain("+36")
    expect(html).toContain("-38")
    expect(html.indexOf("-38")).toBeLessThan(html.indexOf("data-channel-badge"))
    // Laid over the name's end, left of the badge, with the badge's gap.
    expect(changesClass(html)).toContain("absolute right-full")
    expect(changesClass(html)).toContain("pr-2")
  })

  test("without a badge, ends at the row's right edge", () => {
    const html = render(DIRTY)
    expect(html).not.toContain("data-channel-badge")
    expect(changesClass(html)).toContain("right-full")
    expect(changesClass(html)).not.toContain("pr-2")
  })

  test("shows only on hover (a pointer that hovers), keyboard focus or an open menu", () => {
    const classes = changesClass(render(DIRTY, 1))
    expect(classes).toContain("opacity-0")
    expect(classes).toContain("[@media(hover:hover)]:group-hover/channel:opacity-100")
    expect(classes).toContain("group-focus-visible/channel:opacity-100")
    expect(classes).toContain("group-data-[hover-card-open]/channel:opacity-100")
    // A fade on opacity alone, and none for reduced motion.
    expect(classes).toContain("transition-opacity duration-150 ease-out motion-reduce:transition-none")
  })

  test("stays shown on the open channel", () => {
    const classes = changesClass(render(DIRTY, 0, true))
    expect(classes).toContain("opacity-100")
    expect(classes).not.toContain("opacity-0")
  })

  test("takes no room from the name: overlaid, never in the flow", () => {
    expect(changesClass(render(DIRTY))).toContain("pointer-events-none absolute")
  })

  test("drops a half that is zero", () => {
    const html = render({ ...DIRTY, deletions: 0 })
    expect(html).toContain("+36")
    expect(html).not.toContain(">-0<")
    expect(html).not.toContain("text-red")
  })

  test("the badge alone when there are no changes to show", () => {
    const html = render({ dirty: false, ahead: 0, untrackedOnly: false }, 3)
    expect(html).toContain("data-channel-badge")
    expect(html).not.toContain("data-channel-changes")
  })

  test("nothing for a clean repo, untracked-only work, zero counts or no git state", () => {
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
