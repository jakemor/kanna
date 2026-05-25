import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatNavbar } from "./ChatNavbar"

function renderNavbar(sidebarCollapsed: boolean) {
  return renderToStaticMarkup(
    <ChatNavbar
      sidebarCollapsed={sidebarCollapsed}
      onOpenSidebar={() => undefined}
      onExpandSidebar={() => undefined}
    />
  )
}

describe("ChatNavbar", () => {
  test("does not render the compose button when the sidebar is expanded", () => {
    expect(renderNavbar(false)).not.toContain("title=\"Compose\"")
  })

  test("does not render the compose button when the sidebar is collapsed", () => {
    expect(renderNavbar(true)).not.toContain("title=\"Compose\"")
  })
})
