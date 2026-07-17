import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedSkillToolCall } from "../../../shared/types"
import { ReadResultImages, ToolCallMessage } from "./ToolCallMessage"

describe("ToolCallMessage", () => {
  test("renders read result image blocks as inline images", () => {
    const html = renderToStaticMarkup(
      <ReadResultImages
        images={[
          {
            type: "image",
            data: "ZmFrZS1pbWFnZS1kYXRh",
            mimeType: "image/png",
          },
        ]}
      />
    )

    expect(html).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh")
    expect(html).toContain("alt=\"Read result 1\"")
  })

  test("renders the user-facing skill label", () => {
    const message: HydratedSkillToolCall = {
      id: "skill-1",
      kind: "tool",
      toolKind: "skill",
      toolName: "Skill",
      toolId: "tool-1",
      input: { skill: "shadcn" },
      timestamp: new Date().toISOString(),
    }

    const html = renderToStaticMarkup(<ToolCallMessage message={message} />)

    expect(html).toContain("Read Skill – shadcn")
  })
})
