import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTodoWriteToolCall } from "../../../shared/types"
import { TodoWriteMessage } from "./TodoWriteMessage"

describe("TodoWriteMessage", () => {
  test("renders Cursor enum statuses from an existing persisted transcript", () => {
    const message = {
      id: "todo-1",
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId: "tool-1",
      input: {
        todos: [
          { content: "Completed item", status: "TODO_STATUS_COMPLETED" },
          { content: "Active item", status: "TODO_STATUS_IN_PROGRESS" },
          { content: "Pending item", status: "TODO_STATUS_PENDING" },
        ],
      },
      timestamp: new Date().toISOString(),
    } as unknown as HydratedTodoWriteToolCall

    const html = renderToStaticMarkup(<TodoWriteMessage message={message} />)

    expect(html).toContain("Completed item")
    expect(html).toContain("Active item")
    expect(html).toContain("Pending item")
    expect(html).toContain("animate-spin")
  })

  test("renders an unknown persisted status as pending instead of throwing", () => {
    const message = {
      id: "todo-2",
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId: "tool-2",
      input: { todos: [{ content: "Blocked item", status: "TODO_STATUS_BLOCKED" }] },
      timestamp: new Date().toISOString(),
    } as unknown as HydratedTodoWriteToolCall

    expect(renderToStaticMarkup(<TodoWriteMessage message={message} />)).toContain("Blocked item")
  })
})
