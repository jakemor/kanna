import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { KannaTranscript } from "./KannaTranscript"

describe("KannaTranscript", () => {
  test("renders user attachment cards outside the user bubble", () => {
    const html = renderToStaticMarkup(
      <KannaTranscript
        messages={[
          {
            id: "user-1",
            kind: "user_prompt",
            content: "What are these files about?",
            attachments: [{
              id: "file-1",
              kind: "file",
              displayName: "spec.pdf",
              absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
              relativePath: "./.kanna/uploads/spec.pdf",
              contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
              mimeType: "application/pdf",
              size: 1234,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ]}
        isLoading={false}
        latestToolIds={{ AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }}
        onOpenLocalLink={() => undefined}
        onAskUserQuestionSubmit={() => undefined}
        onExitPlanModeConfirm={() => undefined}
      />
    )

    expect(html).toContain("spec.pdf")
    expect(html).toContain("application/pdf")
    expect(html).toContain("What are these files about?")
  })

  test("renders uploaded image attachments using the server content URL", () => {
    const html = renderToStaticMarkup(
      <KannaTranscript
        messages={[
          {
            id: "user-2",
            kind: "user_prompt",
            content: "",
            attachments: [{
              id: "image-1",
              kind: "image",
              displayName: "mock.png",
              absolutePath: "/tmp/project/.kanna/uploads/mock.png",
              relativePath: "./.kanna/uploads/mock.png",
              contentUrl: "/api/projects/project-1/uploads/mock.png/content",
              mimeType: "image/png",
              size: 512,
            }],
            timestamp: new Date().toISOString(),
          },
        ]}
        isLoading={false}
        latestToolIds={{ AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }}
        onOpenLocalLink={() => undefined}
        onAskUserQuestionSubmit={() => undefined}
        onExitPlanModeConfirm={() => undefined}
      />
    )

    expect(html).toContain("/api/projects/project-1/uploads/mock.png/content")
    expect(html).toContain("mock.png")
    expect(html).toContain("max-h-[300px]")
    expect(html).toContain("min-w-[200px]")
  })

  test("renders images before file attachments and user text", () => {
    const html = renderToStaticMarkup(
      <KannaTranscript
        messages={[
          {
            id: "user-3",
            kind: "user_prompt",
            content: "Please review these.",
            attachments: [
              {
                id: "image-2",
                kind: "image",
                displayName: "mock.png",
                absolutePath: "/tmp/project/.kanna/uploads/mock.png",
                relativePath: "./.kanna/uploads/mock.png",
                contentUrl: "/api/projects/project-1/uploads/mock.png/content",
                mimeType: "image/png",
                size: 512,
              },
              {
                id: "file-2",
                kind: "file",
                displayName: "spec.pdf",
                absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
                relativePath: "./.kanna/uploads/spec.pdf",
                contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
                mimeType: "application/pdf",
                size: 1234,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ]}
        isLoading={false}
        latestToolIds={{ AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }}
        onOpenLocalLink={() => undefined}
        onAskUserQuestionSubmit={() => undefined}
        onExitPlanModeConfirm={() => undefined}
      />
    )

    expect(html.indexOf("mock.png")).toBeLessThan(html.indexOf("spec.pdf"))
    expect(html.indexOf("spec.pdf")).toBeLessThan(html.indexOf("Please review these."))
  })
})
