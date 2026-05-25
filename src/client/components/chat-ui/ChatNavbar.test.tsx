import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatNavbar } from "./ChatNavbar"

function renderNavbar(sidebarCollapsed: boolean) {
  return renderToStaticMarkup(
    <ChatNavbar
      sidebarCollapsed={sidebarCollapsed}
      onOpenSidebar={() => undefined}
      onExpandSidebar={() => undefined}
      onNewChat={() => undefined}
    />
  )
}

function getComposeButtonClass(html: string) {
  const match = html.match(/<button class="([^"]*)"[^>]*title="Compose"/)
  expect(match).not.toBeNull()
  return match?.[1] ?? ""
}

describe("ChatNavbar", () => {
  test("hides the compose button on desktop when the sidebar is expanded", () => {
    expect(getComposeButtonClass(renderNavbar(false))).toContain("md:hidden")
  })

  test("keeps the compose button visible on desktop when the sidebar is collapsed", () => {
    expect(getComposeButtonClass(renderNavbar(true))).not.toContain("md:hidden")
  })
})
