import { useEffect, useId, useState } from "react"
import { CopyButton } from "../ui/copy-button"

type MermaidTheme = "default" | "dark"

type DiagramState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error" }

let renderSequence = 0
let renderQueue = Promise.resolve()

function currentTheme(): MermaidTheme {
  if (typeof document === "undefined") return "default"
  return document.documentElement.classList.contains("dark") ? "dark" : "default"
}

function queueRender(source: string, id: string, theme: MermaidTheme) {
  const render = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid")
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      flowchart: { useMaxWidth: true },
    })
    return mermaid.render(id, source)
  })

  renderQueue = render.then(() => undefined, () => undefined)
  return render
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const [theme, setTheme] = useState<MermaidTheme>(currentTheme)
  const [state, setState] = useState<DiagramState>({ status: "loading" })

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    renderSequence += 1

    void queueRender(source, `kanna-mermaid-${reactId}-${renderSequence}`, theme)
      .then(({ svg }) => {
        if (!cancelled) setState({ status: "ready", svg })
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" })
      })

    return () => {
      cancelled = true
    }
  }, [reactId, source, theme])

  if (state.status === "ready") {
    return (
      <div
        data-mermaid-diagram
        role="img"
        aria-label="Mermaid diagram"
        className="my-3 max-w-full overflow-x-auto rounded-xl border border-border bg-background p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  if (state.status === "error") {
    return (
      <div data-mermaid-diagram className="group/mermaid relative my-3 max-w-full overflow-x-auto rounded-xl border border-border bg-background">
        <div className="border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
          Unable to render Mermaid diagram. Showing source instead.
        </div>
        <pre className="min-w-0 px-3.5 py-2.5"><code className="block text-xs whitespace-pre">{source}</code></pre>
        <CopyButton
          text={source}
          className="absolute right-1.5 top-1.5 h-8 w-8 text-muted-foreground opacity-0 transition-opacity group-hover/mermaid:opacity-100"
        />
      </div>
    )
  }

  return (
    <div
      data-mermaid-diagram
      aria-label="Rendering Mermaid diagram"
      aria-busy="true"
      className="my-3 h-40 max-w-full animate-pulse rounded-xl border border-border bg-muted/40"
    />
  )
}
