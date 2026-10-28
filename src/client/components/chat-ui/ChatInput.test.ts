import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { useChatInputStore } from "../../stores/chatInputStore"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { ChatInput, getClipboardImageFiles, trimTrailingPastedNewlines, willExceedAttachmentLimit } from "./ChatInput"

function createClipboardItem(args: {
  kind?: string
  type: string
  file?: File | null
}) {
  return {
    kind: args.kind ?? "file",
    type: args.type,
    getAsFile: () => args.file ?? null,
  }
}

describe("willExceedAttachmentLimit", () => {
  test("rejects a batch that would push the composer above the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 3,
    })).toBe(true)
  })

  test("allows a batch that exactly reaches the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 2,
    })).toBe(false)
  })

  test("counts pasted files against the same total attachment limit", () => {
    const pastedFiles = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/png", file: new File(["b"], "", { type: "image/png" }) }),
    ], 123)

    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 48,
      queuedAttachmentCount: 0,
      incomingAttachmentCount: pastedFiles.length,
    })).toBe(false)
  })
})

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "pasted.png", { type: "image/png" }) }),
    ], 123)

    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe("pasted.png")
  })

  test("ignores non-image clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ kind: "string", type: "text/plain" }),
      createClipboardItem({ type: "application/pdf", file: new File(["pdf"], "doc.pdf", { type: "application/pdf" }) }),
    ], 123)

    expect(files).toEqual([])
  })

  test("renames unnamed pasted images using the clipboard timestamp", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("preserves existing filenames from the browser", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/jpeg", file: new File(["img"], "Screenshot 1.jpg", { type: "image/jpeg" }) }),
    ], 456)

    expect(files[0]?.name).toBe("Screenshot 1.jpg")
  })

  test("rewrites generic browser clipboard filenames", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "image.png", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("generates distinct names for multiple unnamed images in one paste event", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/webp", file: new File(["b"], "", { type: "image/webp" }) }),
    ], 789)

    expect(files.map((file) => file.name)).toEqual([
      "clipboard-789.png",
      "clipboard-789-1.webp",
    ])
  })
})

describe("trimTrailingPastedNewlines", () => {
  test("removes trailing unix newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\n\n")).toBe("hello")
  })

  test("removes trailing windows newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\r\n\r\n")).toBe("hello")
  })

  test("preserves internal newlines", () => {
    expect(trimTrailingPastedNewlines("hello\nworld\n")).toBe("hello\nworld")
  })

  test("leaves text without trailing newlines unchanged", () => {
    expect(trimTrailingPastedNewlines("hello")).toBe("hello")
  })
})

describe("ChatInput", () => {
  test("renders + as a native file input target after the field, on every width", () => {
    const html = renderToStaticMarkup(createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      canCancel: false,
      activeProvider: null,
      availableProviders: PROVIDERS,
    }))

    expect(html).toContain('aria-label="Add attachment"')
    expect(html).toContain('type="file"')
    expect(html).toContain("absolute inset-0 h-full w-full cursor-pointer opacity-0")
    expect(html.indexOf('aria-label="Add attachment"')).toBeGreaterThan(html.indexOf("Build something...\""))
    // No longer a phone-only control.
    expect(html).not.toContain("md:hidden")
    // + only attaches: it opens no menu of its own.
    expect(html).not.toMatch(/aria-label="Add attachment"[^>]*aria-haspopup/)
    expect(html).not.toContain('type="file" multiple="" class="hidden"')
  })

  test("draftKey keeps the draft apart from the chat's own", () => {
    useChatInputStore.getState().setDraft("chat-1", "the chat's draft")
    useChatInputStore.getState().setDraft("second:chat-1", "the second draft")
    const props = { onSubmit: async () => undefined, disabled: false, activeProvider: null, availableProviders: PROVIDERS, chatId: "chat-1" }

    const second = renderToStaticMarkup(createElement(ChatInput, { ...props, draftKey: "second:chat-1" }))
    expect(second).toContain("the second draft")
    expect(second).not.toContain("the chat&#x27;s draft")
    expect(renderToStaticMarkup(createElement(ChatInput, props))).toContain("the chat&#x27;s draft")

    useChatInputStore.getState().clearDraft("chat-1")
    useChatInputStore.getState().clearDraft("second:chat-1")
  })

  test("a second composer and the chat's share the chat's settings, and only the draft is its own", () => {
    const claude = PROVIDERS.find((provider) => provider.id === "claude")!
    const chosen = claude.models.find((model) => model.id !== claude.defaultModel)!
    const props = { onSubmit: async () => undefined, disabled: false, activeProvider: "claude" as const, availableProviders: PROVIDERS, chatId: "deleg-1" }

    // Set from the second composer: it writes by the chat's id.
    useChatPreferencesStore.getState().setChatComposerModel("deleg-1", chosen.id)
    const second = renderToStaticMarkup(createElement(ChatInput, { ...props, draftKey: "second:deleg-1" }))
    const chat = renderToStaticMarkup(createElement(ChatInput, props))
    // On one line the model is named in the placeholder.
    expect(second).toContain(`placeholder="${chosen.label} · `)
    expect(chat).toContain(`placeholder="${chosen.label} · `)
    // A chat with no setting of its own shows its default, not this one.
    expect(renderToStaticMarkup(createElement(ChatInput, { ...props, chatId: "another-chat" }))).not.toContain(`placeholder="${chosen.label} · `)

    // And the other way round: what the chat's composer sets, the second shows.
    const back = claude.models.find((model) => model.id !== chosen.id)!
    useChatPreferencesStore.getState().setChatComposerModel("deleg-1", back.id)
    expect(renderToStaticMarkup(createElement(ChatInput, { ...props, draftKey: "second:deleg-1" }))).toContain(`placeholder="${back.label} · `)
    expect(useChatPreferencesStore.getState().getComposerState("deleg-1").model).toBe(back.id)
  })

  test("the composer is the harness button, the field, + and mic: the row of pills under it is gone", () => {
    const html = renderToStaticMarkup(createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      activeProvider: "claude",
      availableProviders: PROVIDERS,
      chatId: "pills-1",
    }))

    expect(html).toContain("Harness and model")
    expect(html).toContain('title="Record voice message"')
    // Effort and speed live in the harness menu now.
    expect(html).not.toContain("Standard")
    expect(html).not.toContain('aria-label="Effort"')
    // And Full Access, the default mode, says nothing.
    expect(html).not.toContain("Full Access")
    expect(html).not.toContain("Plan Mode")
  })

  test("the plan tag shows only while plan mode is on", () => {
    const store = useChatPreferencesStore.getState()
    const props = { onSubmit: async () => undefined, disabled: false, activeProvider: "claude" as const, availableProviders: PROVIDERS, chatId: "plan-1" }
    store.setComposerState("plan-1", { ...store.getComposerState("plan-1"), planMode: true, autoPlan: false })

    expect(renderToStaticMarkup(createElement(ChatInput, props))).toContain("Plan Mode")

    store.setComposerState("plan-1", { ...store.getComposerState("plan-1"), planMode: false, autoPlan: false })
    expect(renderToStaticMarkup(createElement(ChatInput, props))).not.toContain("Plan Mode")
  })

  test("from 90% of the context window the harness button carries the warning", () => {
    const render = (usedPercentage: number) => renderToStaticMarkup(createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      activeProvider: "codex",
      availableProviders: PROVIDERS,
      chatId: "context-1",
      contextWindowSnapshot: {
        usedTokens: usedPercentage * 1000,
        maxTokens: 100_000,
        usedPercentage,
        remainingTokens: (100 - usedPercentage) * 1000,
        remainingPercentage: 100 - usedPercentage,
        updatedAt: new Date(0).toISOString(),
      },
    }))

    expect(render(90)).toContain("context nearly full")
    expect(render(89)).not.toContain("context nearly full")
  })
})
