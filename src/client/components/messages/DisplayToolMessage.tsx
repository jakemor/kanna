import { readVisualizationArtifact, VISUALIZATION_TOOL_NAME } from "../../../shared/visualization"
import { Visualization } from "./Visualization"
import { useEffect, useRef, useState } from "react"
import { FileText, ArrowUpRight, Download } from "lucide-react"
import { ChartTool } from "./ChartTool"
import { viewerAttachmentFromDisplay } from "../../stores/viewerStore"
import { activateAttachment, attachmentOpenAction } from "../viewer/attachmentActions"
import { displayAttachments, type ChartToolPayload, type DisplayAttachment } from "../../../shared/display-tools"
import type { ProcessedToolCall } from "./types"
import { useToolPayload } from "./tool-payload-context"

export function DisplayToolMessage({ message }: { message: ProcessedToolCall }) {
  // Older cached updates can lack the result body even though the server has it.
  const fetchedResult = useToolPayload(message.resultTrimmed ? message.resultEntryId : undefined)
  const rawResult = fetchedResult?.kind === "tool_result" ? fetchedResult.content : message.rawResult
  if (!message.resultEntryId || (message.resultTrimmed && !fetchedResult)) return <p className="text-sm text-muted-foreground">{message.toolName === VISUALIZATION_TOOL_NAME ? "Preparing visualization" : message.toolName === "show_chart" ? "Preparing chart" : message.toolName === "generate_images" ? "Generating images" : "Preparing attachments"}...</p>
  if (message.isError) return <p role="alert" className="text-sm text-destructive">{errorText(rawResult)}</p>
  if (message.toolKind !== "display") return null
  if (message.toolName === "show_chart") return <ChartTool payload={message.input.payload as unknown as ChartToolPayload} />
  if (message.toolName === VISUALIZATION_TOOL_NAME) {
    const artifact = readVisualizationArtifact(rawResult)
    return artifact ? <Visualization key={artifact.url} artifact={artifact} /> : <p role="alert" className="text-sm text-muted-foreground">Visualization unavailable.</p>
  }
  return <AttachmentsCard attachments={displayAttachments(rawResult)} />
}

function errorText(result: unknown): string {
  if (Array.isArray(result)) return result.map(block => block?.text ?? "").join("\n") || "Could not display this result."
  return "Could not display this result."
}

/**
 * A plain click does what the file allows (`activateAttachment`): the viewer,
 * a new tab, or a download. A modified or middle click keeps the link's own
 * behavior, which is why these stay links rather than buttons.
 */
function openAttachment(event: React.MouseEvent<HTMLAnchorElement>, attachment: DisplayAttachment) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  activateAttachment(viewerAttachmentFromDisplay(attachment))
}

export function AttachmentsCard({ attachments }: { attachments: DisplayAttachment[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const multiple = attachments.length > 1
  const filesOnly = attachments.every(attachment => attachment.kind === "file")
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [moreLeft, setMoreLeft] = useState(false)
  const [moreRight, setMoreRight] = useState(false)
  const [scrollbarHeight, setScrollbarHeight] = useState(0)
  const measure = () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    setMoreLeft(scroller.scrollLeft > 1)
    setMoreRight(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1)
    setScrollbarHeight(scroller.offsetHeight - scroller.clientHeight)
  }
  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === "undefined") return
    // Images set the content width when they load, so watch both elements.
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  return (
      <div className="group relative -m-2 w-[calc(100%+1rem)] min-w-0 overflow-hidden" aria-label="Attachments">
        {/* The scrollbar keeps its space and only its thumb goes transparent. Removing it would change the row height on hover. */}
        <div ref={scrollerRef} onScroll={measure} className="attachments-scroller w-full snap-x scroll-px-2 overflow-x-auto">
          {/* Images and videos scroll sideways. A row of only files wraps instead, since there is nothing to preview. */}
          <div ref={contentRef} className={`flex gap-2 p-2 ${filesOnly ? "w-full flex-wrap" : "w-max min-w-full"}`}>
            {attachments.map((attachment, index) => {
              const failed = broken.has(attachment.url)
              const mediaClass = "block h-56 w-full rounded-[10px] border border-border bg-muted dark:bg-card object-contain"
              const imagePreview = attachment.kind === "image" && !failed
              const onError = () => setBroken(current => new Set(current).add(attachment.url))
              const downloads = attachmentOpenAction(viewerAttachmentFromDisplay(attachment)) === "download"
              const imageLink = (
                <a href={attachment.url} target="_blank" rel="noreferrer noopener" className="block" aria-label={`Open ${attachment.name}`} onClick={(event) => openAttachment(event, attachment)}>
                  {/* Load on mount because the image's dimensions determine the preview width. Every image has the same height. Only a panorama wider than the cap is cropped. */}
                  <img src={attachment.url} alt={attachment.name} referrerPolicy="no-referrer" className="block h-56 w-auto max-w-[32rem] rounded-[10px] object-cover shadow-md" onError={onError} />
                </a>
              )
              return (
                <figure key={`${attachment.url}-${index}`} className={imagePreview ? "m-0 flex w-fit shrink-0 snap-start flex-col items-start gap-1" : multiple ? "m-0 flex max-w-full shrink-0 snap-start flex-col gap-1" : "m-0 flex max-w-full flex-col gap-1"}>
                  {imagePreview ? (
                    imageLink
                  ) : attachment.kind === "video" && !failed ? (
                    <video src={attachment.url} controls preload="metadata" className={mediaClass} onError={onError} aria-label={attachment.name} />
                  ) : (
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      download={downloads ? attachment.name : undefined}
                      onClick={(event) => openAttachment(event, attachment)}
                      className="flex max-w-80 items-center gap-3 rounded-[10px] border border-border bg-muted dark:bg-card p-3 text-sm hover:border-muted-foreground/50"
                    >
                      <FileText className="size-5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{attachment.name}</span>
                      {downloads ? <Download aria-label="Download" className="size-4 shrink-0" /> : <ArrowUpRight className="size-4 shrink-0" />}
                    </a>
                  )}
                  {failed && <span className="text-xs text-muted-foreground">Preview unavailable. Open the file to view it.</span>}
                </figure>
              )
            })}
          </div>
        </div>
        {/* A line marks each side that has more content past it. The lines are overlays, so they do not shift the row, and they stop above the scrollbar. */}
        {([["left-0", moreLeft], ["right-0", moreRight]] as const).map(([side, visible]) => (
          <span key={side} aria-hidden="true" className={`pointer-events-none absolute top-0 w-px bg-border transition-opacity ${side} ${visible ? "opacity-100" : "opacity-0"}`} style={{ bottom: scrollbarHeight }} />
        ))}
      </div>
  )
}
