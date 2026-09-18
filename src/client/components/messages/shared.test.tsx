import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { MemoryRouter } from "react-router-dom"
import { TranscriptRenderOptionsProvider } from "./render-context"
import { TranscriptMarkdown } from "./shared"
import { createMarkdownComponents, markdownComponents, OpenLocalLinkProvider } from "./shared"

describe("markdownComponents", () => {
  test("exports recognize absolute chat links against the source origin, not the viewer", () => {
    const html = renderToStaticMarkup(
      <TranscriptRenderOptionsProvider value={{ localLinkMode: "text", sourceOrigin: "http://kanna.example:5174" }}>
        <TranscriptMarkdown text={[
          "[Source chat](http://kanna.example:5174/chat/abc-123)",
          "[External chat](https://other.example/chat/abc-123)",
          "[Docs](https://docs.example/guide)",
        ].join("\n\n")} />
      </TranscriptRenderOptionsProvider>
    )
    expect(html).toContain("Source chat</span>")
    expect(html).not.toContain('href="http://kanna.example:5174/chat/abc-123"')
    expect(html).toContain('href="https://other.example/chat/abc-123"')
    expect(html).toContain('href="https://docs.example/guide"')
  })

  test("renders chat references as same-page router links", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TranscriptMarkdown text="[Dual Stripe Account Support](/chat/abc-123)" />
      </MemoryRouter>
    )
    expect(html).toContain('href="/chat/abc-123"')
    expect(html).toContain('data-discover="true"')
    expect(html).not.toContain('target="_blank"')
  })

  test("keeps chat links inert in standalone exports", () => {
    const html = renderToStaticMarkup(
      <TranscriptRenderOptionsProvider value={{ localLinkMode: "text" }}>
        <TranscriptMarkdown text="[Other chat](/chat/abc-123)" />
      </TranscriptRenderOptionsProvider>
    )
    expect(html).toContain("Other chat")
    expect(html).not.toContain("href=")
  })

  test("renders markdown headings with transcript-specific sizes and no bold weight", () => {
    const html = renderToStaticMarkup(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {"# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six"}
      </Markdown>
    )

    expect(html).toContain('<h1 class="text-[20px] font-normal')
    expect(html).toContain('<h2 class="text-[18px] font-normal')
    expect(html).toContain('<h3 class="text-[16px] font-normal')
    expect(html).toContain('<h4 class="text-[16px] font-normal')
    expect(html).toContain('<h5 class="text-[16px] font-normal')
    expect(html).toContain('<h6 class="text-[16px] font-normal')
  })

  test("renders markdown blockquotes with quote styling", () => {
    const html = renderToStaticMarkup(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {"> quoted line"}
      </Markdown>
    )

    expect(html).toContain("<blockquote")
    expect(html).toContain("border-l-2")
    expect(html).toContain("<p")
    expect(html).toContain("quoted line")
  })

  test("preserves nested markdown inside blockquotes", () => {
    const html = renderToStaticMarkup(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {"> [docs](https://example.com)\n> \n> - item"}
      </Markdown>
    )

    expect(html).toContain("<blockquote")
    expect(html).toContain("<a")
    expect(html).toContain("https://example.com")
    expect(html).toContain("<ul")
    expect(html).toContain("<li")
  })

  test("renders local file links without browser target handling", () => {
    const html = renderToStaticMarkup(
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={createMarkdownComponents({ onOpenLocalLink: () => {} })}
      >
        {"[app.ts](/Users/jake/Projects/kanna/src/client/app/App.tsx#L1)"}
      </Markdown>
    )

    expect(html).toContain("/Users/jake/Projects/kanna/src/client/app/App.tsx#L1")
    expect(html).not.toContain('target="_blank"')
  })

  test("renders local file links without browser target handling when provided by context", () => {
    const html = renderToStaticMarkup(
      <OpenLocalLinkProvider onOpenLocalLink={() => {}}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={createMarkdownComponents()}
        >
          {"[app.ts](/Users/jake/Projects/kanna/src/client/app/App.tsx#L1)"}
        </Markdown>
      </OpenLocalLinkProvider>
    )

    expect(html).toContain("/Users/jake/Projects/kanna/src/client/app/App.tsx#L1")
    expect(html).not.toContain('target="_blank"')
  })
})
