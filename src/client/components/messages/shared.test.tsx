import { describe, expect, test, mock } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

mock.module("../../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: () => {} }),
}))

const { createMarkdownComponents, defaultMarkdownComponents, defaultRemarkPlugins, markdownComponents, MermaidFallbackCodeBlock, OpenLocalLinkProvider } = await import("./shared")

test("MermaidFallbackCodeBlock renders source inside a pre/code block", () => {
  const html = renderToStaticMarkup(
    <MermaidFallbackCodeBlock source={"graph TD\nA-->B"} />
  )
  expect(html).toContain("<pre")
  expect(html).toContain("graph TD")
  expect(html).toContain("A--&gt;B")
})

describe("markdownComponents", () => {
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

  test("renders local file image links as a download card, not a raw anchor", () => {
    const html = renderToStaticMarkup(
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={createMarkdownComponents({ onOpenLocalLink: () => {} })}
      >
        {"[chibi-cute.png](/Users/cuongtran/.kanna/outputs/chibi-cute.png)"}
      </Markdown>
    )

    expect(html).toContain('data-testid="local-file-link"')
    expect(html).toContain("chibi-cute.png")
    expect(html).not.toContain('href="/Users/cuongtran/.kanna/outputs/chibi-cute.png"')
  })

  test("keeps editor-openable file links on the legacy anchor handler", () => {
    const html = renderToStaticMarkup(
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={createMarkdownComponents({ onOpenLocalLink: () => {} })}
      >
        {"[App.tsx](/Users/jake/Projects/kanna/src/client/app/App.tsx)"}
      </Markdown>
    )

    expect(html).not.toContain('data-testid="local-file-link"')
    expect(html).toContain('href="/Users/jake/Projects/kanna/src/client/app/App.tsx"')
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

test("mermaid fenced block routes to MermaidDiagram (not a raw code block)", () => {
  const md = "```mermaid\ngraph TD\nA-->B\n```"
  const html = renderToStaticMarkup(
    <Markdown remarkPlugins={defaultRemarkPlugins} components={defaultMarkdownComponents}>
      {md}
    </Markdown>
  )
  expect(html).toContain("group/mermaid")
})

test("non-mermaid fenced block still renders as a normal code block", () => {
  const md = "```ts\nconst x = 1\n```"
  const html = renderToStaticMarkup(
    <Markdown remarkPlugins={defaultRemarkPlugins} components={defaultMarkdownComponents}>
      {md}
    </Markdown>
  )
  expect(html).not.toContain("group/mermaid")
  expect(html).toContain("const x = 1")
})
