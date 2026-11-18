import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { normalizeToolCall } from "../../../shared/tools"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { getLatestToolIds } from "../../app/derived"
import { buildResolvedTranscriptRows, KannaTranscriptRow } from "../../app/KannaTranscript"
import type { TranscriptEntry } from "../../../shared/types"
import { AttachmentsCard, DisplayToolMessage } from "./DisplayToolMessage"
import { ToolPayloadProvider } from "./tool-payload-context"
import { csvCell } from "./ChartTool"
import { Visualization, VisualizationExpandButton, VisualizationFullView } from "./Visualization"
import { TooltipProvider } from "../ui/tooltip"
import { VISUALIZATION_EXPAND_BUTTON } from "../../../shared/visualization"
import { displayAttachments, resolveChartKeys, type ChartToolPayload } from "../../../shared/display-tools"

test("display tools render outside collapsed groups with chart and attachment cards", () => {
  const entries: TranscriptEntry[] = [
    { _id: "chart", createdAt: 0, kind: "tool_call", tool: normalizeToolCall({ toolName: "show_chart", toolId: "chart", input: { title: "Sales", description: "Monthly sales", type: "bar", data: [{ month: "Jan", revenue: 10 }] } }) },
    { _id: "chart-result", createdAt: 1, kind: "tool_result", toolId: "chart", content: { displayed: true } },
    { _id: "files", createdAt: 2, kind: "tool_call", tool: normalizeToolCall({ toolName: "send_attachments", toolId: "files", input: { description: "Report", attachments: [{ url: "https://example.com/chart.png" }] } }) },
    { _id: "files-result", createdAt: 3, kind: "tool_result", toolId: "files", content: [{ type: "attachment", url: "https://example.com/chart.png", name: "chart.png", kind: "image", caption: "Sales chart", mimeType: "image/png", size: null }] },
  ]
  const messages = processTranscriptMessages(entries)
  const rows = buildResolvedTranscriptRows(messages, { isLoading: false, latestToolIds: getLatestToolIds(messages) })
  expect(rows.every(row => row.kind !== "tool-group")).toBe(true)
  const html = renderToStaticMarkup(<>{rows.map(row => <KannaTranscriptRow key={row.id} row={row} onToolGroupExpandedChange={() => {}} onAskUserQuestionSubmit={() => {}} onExitPlanModeConfirm={() => {}} />)}</>)
  expect(html).toContain("Sales")
  expect(html).toContain("Download CSV")
  expect(html).toContain("Expand chart")
  expect(html).toContain('src="https://example.com/chart.png"')
  expect(html).not.toContain("Sales chart")
  expect(html).toContain('alt="chart.png"')
})

test("attachments render videos and ordinary files without embedding documents", () => {
  const html = renderToStaticMarkup(<AttachmentsCard attachments={[
    { type: "attachment", url: "https://example.com/movie.mp4", name: "Movie", kind: "video", mimeType: "video/mp4", size: null },
    { type: "attachment", url: "https://example.com/report.html", name: "Report", kind: "file", mimeType: "text/html", size: null },
  ]} />)
  expect(html).toContain("<video")
  expect(html).toContain('href="https://example.com/report.html"')
  expect(html).not.toContain("<iframe")
})

test("old attachment descriptions stay hidden while all files still render", () => {
  const attachments = displayAttachments([
    { type: "attachment", url: "https://example.com/photo.png", name: "photo.png", kind: "image", caption: "Old image caption" },
    { type: "attachment", url: "https://example.com/movie.mp4", name: "movie.mp4", kind: "video", caption: "Old video caption" },
    { type: "attachment", url: "https://example.com/report.pdf", name: "report.pdf", kind: "file", caption: "Old file caption", description: "Old description" },
  ])
  const html = renderToStaticMarkup(<AttachmentsCard attachments={attachments} />)
  expect(html).not.toContain("Old")
  expect(html).not.toContain("figcaption")
  for (const attachment of attachments) expect(html).toContain(attachment.url)
  expect(html).toContain('alt="photo.png"')
  expect(html).toContain('aria-label="movie.mp4"')
})

test("cached trimmed attachment results render from fetched payloads", () => {
  const result: TranscriptEntry = { _id: "result", createdAt: 1, kind: "tool_result", toolId: "files",
    content: [{ type: "attachment", url: "https://example.com/cat.png", name: "cat.png", kind: "image" }],
  }
  const [message] = processTranscriptMessages([
    { _id: "call", createdAt: 0, kind: "tool_call", tool: normalizeToolCall({ toolName: "send_attachments", toolId: "files", input: {} }) },
    { ...result, content: undefined, trimmed: true },
  ])
  if (message?.kind !== "tool") throw new Error("Expected attachment tool")
  expect(renderToStaticMarkup(<DisplayToolMessage message={message} />)).toContain("Preparing attachments")
  const store = { get: (id: string | undefined) => id === "result" ? result : undefined, prefetch: () => {}, subscribe: () => () => {} }
  const html = renderToStaticMarkup(<ToolPayloadProvider store={store}><DisplayToolMessage message={message} /></ToolPayloadProvider>)
  expect(html).toContain('src="https://example.com/cat.png"')
})

test("chart aliases filter category columns and CSV escapes quotes", () => {
  const chart: ChartToolPayload = { title: "Sales", type: "line", data: [{ month: "Jan", value: 10 }], xAxisKey: "month", dataKeys: ["month", "value"] }
  expect(resolveChartKeys(chart)).toEqual({ xKey: "month", keys: ["value"] })
  expect(csvCell('A "quoted", value')).toBe('"A ""quoted"", value"')
})

test("the expand button is a circle in the corner, named for assistive tech, with no label of its own", () => {
  const html = renderToStaticMarkup(<TooltipProvider><VisualizationExpandButton onClick={() => {}} /></TooltipProvider>)
  const { size, inset } = VISUALIZATION_EXPAND_BUTTON
  expect(html).toContain('aria-label="Expand"')
  // Flush in the corner: React writes a zero without a unit.
  expect(inset).toBe(0)
  expect(html).toContain(`top:0;right:0;width:${size}px;height:${size}px`)
  expect(html).toContain("visualization-expand absolute")
  expect(html).toContain("rounded-full")
  expect(html).not.toContain(">Expand<")
})

test("a visualization fits its content inline and fills the pane at full size", () => {
  const artifact = { url: "/api/chats/c/media/visualization-a.html", title: "Mockup", height: 360 }
  // Inline: the box holds a height, so nothing under it moves while the page loads.
  const inline = renderToStaticMarkup(<TooltipProvider><Visualization artifact={artifact} /></TooltipProvider>)
  expect(inline).toContain('class="min-w-0" style="height:360px"')
  // Full: the box takes the card body's height, and the body does not scroll around it.
  const full = renderToStaticMarkup(<TooltipProvider><VisualizationFullView artifact={artifact} onClose={() => {}} /></TooltipProvider>)
  expect(full).toContain('<div class="h-full p-4"><div class="h-full min-w-0">')
  expect(full).not.toContain("height:360px")
  expect(full).toContain(`data-viewer-body="true" class="min-h-0 flex-1 overflow-hidden"`)
})

test("visualizations stay inline between Markdown messages without a tool card", () => {
  const entries: TranscriptEntry[] = [
    { _id: "before", createdAt: 0, kind: "assistant_text", text: "Here is the relationship." },
    { _id: "visualization", createdAt: 1, kind: "tool_call", tool: normalizeToolCall({ toolName: "show_visualization", toolId: "viz", input: { title: "Relationship", html: "<svg></svg>" } }) },
    { _id: "visualization-result", createdAt: 2, kind: "tool_result", toolId: "viz", content: [{ type: "visualization", version: 1, title: "Relationship", height: 360, url: "/api/chats/chat-1/media/visualization-abc.html" }] },
    { _id: "after", createdAt: 3, kind: "assistant_text", text: "Move the slider to compare." },
  ]
  const messages = processTranscriptMessages(entries)
  const rows = buildResolvedTranscriptRows(messages, { isLoading: false, latestToolIds: getLatestToolIds(messages) })
  expect(rows.every(row => row.kind !== "tool-group")).toBe(true)
  const html = renderToStaticMarkup(<>{rows.map(row => <KannaTranscriptRow key={row.id} row={row} onToolGroupExpandedChange={() => {}} onAskUserQuestionSubmit={() => {}} onExitPlanModeConfirm={() => {}} />)}</>)
  expect(html).toContain("Loading visualization")
  expect(html).not.toContain("chart-card")
  expect(html).not.toContain("show_visualization")
  expect(html.indexOf("Here is the relationship")).toBeLessThan(html.indexOf("Loading visualization"))
  expect(html.indexOf("Loading visualization")).toBeLessThan(html.indexOf("Move the slider"))
})
