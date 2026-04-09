import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatRow } from "./ChatRow"

const baseChat = {
  _id: "chat-row-1",
  _creationTime: 1,
  chatId: "chat-1",
  title: "Test chat",
  status: "idle" as const,
  unread: false,
  localPath: "/tmp/project",
  provider: "codex" as const,
  lastMessageAt: 0,
  hasAutomation: false,
}

describe("ChatRow", () => {
  test("renders the relative age label by default", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        chat={baseChat}
        activeChatId={null}
        nowMs={60_000}
        onSelectChat={() => undefined}
        onRenameChat={() => undefined}
        onDeleteChat={() => undefined}
      />
    )

    expect(html).toContain(">1m<")
  })

  test("renders the shortcut hint when the modifier is held", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        chat={baseChat}
        activeChatId={null}
        nowMs={60_000}
        shortcutHint="1"
        showShortcutHint
        onSelectChat={() => undefined}
        onRenameChat={() => undefined}
        onDeleteChat={() => undefined}
      />
    )

    expect(html).toContain(">1<")
    expect(html).toContain("<kbd")
    expect(html).not.toContain(">1m<")
  })
})
