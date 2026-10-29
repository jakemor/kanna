import { ATTACHMENT_TOOL_NAMES, displayAttachments } from "../../../shared/display-tools"
import type { TranscriptEntry } from "../../../shared/types"
import { viewerAttachmentFromChat, viewerAttachmentFromDisplay, type ViewerAttachment } from "../../stores/viewerStore"
import { attachmentOpenAction } from "./attachmentOpenAction"
import type { ViewerNavigation } from "./ViewerSurface"

/**
 * Every attachment the viewer can step through in a chat, in transcript
 * order: the files a prompt carried, and the ones an agent sent
 * (send_attachments, generate_images), each where it appears.
 *
 * Only what opens in the viewer. A file a click sends to a tab or a download
 * (a Word file, a CSV an agent sent as a download) would be a step that
 * leaves the panel, so it is not one. The same file twice is one step, at its
 * first place: stepping finds where you are by address.
 *
 * It reads the transcript the page holds, which is a window on the chat's
 * recent end (`chat.loadOlder` widens it). Files above the window are not
 * steps until they load; the list grows when they do.
 */
export function chatAttachmentSequence(entries: readonly TranscriptEntry[]): ViewerAttachment[] {
  const attachmentToolIds = new Set<string>()
  const seen = new Set<string>()
  const sequence: ViewerAttachment[] = []
  const add = (attachment: ViewerAttachment) => {
    if (seen.has(attachment.url) || attachmentOpenAction(attachment) !== "preview") return
    seen.add(attachment.url)
    sequence.push(attachment)
  }
  for (const entry of entries) {
    if (entry.kind === "user_prompt") {
      for (const attachment of entry.attachments ?? []) {
        if (attachment.contentUrl) add(viewerAttachmentFromChat(attachment))
      }
    } else if (entry.kind === "tool_call" && entry.tool.toolKind === "display" && ATTACHMENT_TOOL_NAMES.includes(entry.tool.toolName)) {
      attachmentToolIds.add(entry.tool.toolId)
    } else if (entry.kind === "tool_result" && !entry.isError && attachmentToolIds.has(entry.toolId)) {
      for (const attachment of displayAttachments(entry.content)) add(viewerAttachmentFromDisplay(attachment))
    }
  }
  return sequence
}

/** The index a step lands on: round from the last back to the first, and the other way. */
export function stepAttachmentIndex(index: number, count: number, step: "next" | "previous") {
  return (index + (step === "next" ? 1 : -1) + count) % count
}

/**
 * The viewer's steps from `current` through `sequence`, or nothing when it
 * has nowhere to go: a chat with one attachment, or one not in the list (the
 * composer's, not sent yet; a previewed sub-chat's; one the window has moved
 * past). The list loops, so neither end is a wall.
 */
export function attachmentNavigation(
  sequence: readonly ViewerAttachment[],
  current: ViewerAttachment,
  show: (attachment: ViewerAttachment) => void,
): ViewerNavigation | undefined {
  const index = sequence.findIndex((attachment) => attachment.url === current.url)
  if (index < 0 || sequence.length < 2) return undefined
  const step = (direction: "next" | "previous") => show(sequence[stepAttachmentIndex(index, sequence.length, direction)]!)
  return {
    index,
    count: sequence.length,
    onPrevious: () => step("previous"),
    onNext: () => step("next"),
    previousLabel: "Previous attachment (k)",
    nextLabel: "Next attachment (j)",
    horizontal: true,
  }
}
