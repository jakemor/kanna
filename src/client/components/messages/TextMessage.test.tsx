import { describe, expect, test, mock } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

mock.module("../../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: () => {} }),
}))

const { TextMessage } = await import("./TextMessage")
import type { ProcessedTextMessage } from "./types"

function buildMessage(text: string): ProcessedTextMessage {
  return {
    kind: "assistant_text",
    text,
    id: "id-1",
    timestamp: "2024-01-01T00:00:00Z",
  }
}

describe("TextMessage", () => {
  test("renders visible text outside thinking tags as markdown", () => {
    const html = renderToStaticMarkup(
      <TextMessage message={buildMessage("hello **world**")} />
    )
    expect(html).toContain("hello")
    expect(html).toContain("<strong>world</strong>")
  })

  test("hides thinking content behind collapsed disclosure", () => {
    const html = renderToStaticMarkup(
      <TextMessage message={buildMessage("<thinking>secret monologue</thinking>visible answer")} />
    )
    expect(html).toContain("Thinking")
    expect(html).toContain("visible answer")
    expect(html).not.toContain("secret monologue")
  })

  test("renders multiple thinking blocks each as collapsed section", () => {
    const html = renderToStaticMarkup(
      <TextMessage
        message={buildMessage(
          "intro<thinking>plan A</thinking>middle<thinking>plan B</thinking>end"
        )}
      />
    )
    const thinkingMatches = html.match(/Thinking/g) ?? []
    expect(thinkingMatches.length).toBe(2)
    expect(html).toContain("intro")
    expect(html).toContain("middle")
    expect(html).toContain("end")
    expect(html).not.toContain("plan A")
    expect(html).not.toContain("plan B")
  })

  test("does not render Thinking label for unrelated text", () => {
    const html = renderToStaticMarkup(
      <TextMessage message={buildMessage("just a plain reply")} />
    )
    expect(html).not.toContain("Thinking")
  })

  test("treats unclosed thinking tag as open block (streaming)", () => {
    const html = renderToStaticMarkup(
      <TextMessage message={buildMessage("answer first <thinking>partial...")} />
    )
    expect(html).toContain("Thinking")
    expect(html).toContain("answer first")
    expect(html).not.toContain("partial...")
  })
})
