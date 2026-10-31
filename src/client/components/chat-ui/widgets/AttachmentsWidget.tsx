import { ArrowUpRight, Download, FileText, Film, Paperclip } from "lucide-react"
import { useState } from "react"
import { cn } from "../../../lib/utils"
import { WidgetList, WidgetRow, WidgetTile, WidgetTileGrid } from "./parts"
import { WidgetCard } from "./WidgetCard"
import { viewerAttachmentFromDisplay } from "../../../stores/viewerStore"
import { activateAttachment, attachmentOpenAction } from "../../viewer/attachmentActions"
import type { WidgetAttachment } from "./derive"

// The viewer when it can show the file, else a new tab, else a download.
function openAttachment(attachment: WidgetAttachment) {
  activateAttachment(viewerAttachmentFromDisplay(attachment))
}

/** Fades in once decoded, over the tile's muted placeholder, instead of popping. */
function AttachmentThumbnail({ url, name }: { url: string; name: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      src={url}
      alt={name}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      // A cached image can finish before the load listener is attached.
      ref={(img) => {
        if (img?.complete && img.naturalWidth > 0) setLoaded(true)
      }}
      className={cn("size-full object-cover transition-opacity duration-200 ease-snappy", loaded ? "opacity-100" : "opacity-0")}
    />
  )
}

/**
 * Files the agent sent this chat (send_attachments, generate_images), newest
 * first. Images show as a thumbnail grid; everything else as rows below them.
 */
export function AttachmentsWidget({ attachments }: { attachments: WidgetAttachment[] }) {
  const images = attachments.filter((attachment) => attachment.kind === "image")
  const others = attachments.filter((attachment) => attachment.kind !== "image")
  return (
    <WidgetCard icon={<Paperclip />} title="Attachments" count={attachments.length}>
      {/* Scrolls inside a cap: a chat that generated dozens of images would
          otherwise push every widget below it off screen. No overscroll
          containment, so a wheel that reaches the end carries on into the
          column instead of stalling in the middle of it. */}
      <WidgetList className="max-h-[40vh] overflow-y-auto">
        {images.length > 0 ? (
          // As many columns as fit, then every column grows to share the
          // leftover, so rows always reach both edges and thumbnails stay
          // about 96–128px however wide the sidebar is.
          <WidgetTileGrid>
            {images.map((image) => (
              <WidgetTile key={image.key} tooltip={image.name} onActivate={() => openAttachment(image)}>
                <AttachmentThumbnail url={image.url} name={image.name} />
              </WidgetTile>
            ))}
          </WidgetTileGrid>
        ) : null}
        {others.map((attachment) => (
          <WidgetRow
            key={attachment.key}
            icon={attachment.kind === "video" ? <Film /> : <FileText />}
            title={attachment.name}
            tooltip={attachment.name}
            meta={attachmentOpenAction(viewerAttachmentFromDisplay(attachment)) === "download" ? <Download className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
            onActivate={() => openAttachment(attachment)}
          />
        ))}
      </WidgetList>
    </WidgetCard>
  )
}
