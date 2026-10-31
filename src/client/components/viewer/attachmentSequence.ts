import { ATTACHMENT_TOOL_NAMES, displayAttachments } from "../../../shared/display-tools"
import type { TranscriptEntry } from "../../../shared/types"
import { viewerAttachmentFromChat, viewerAttachmentFromDisplay, type ViewerAttachment } from "../../stores/viewerStore"
import { attachmentOpenAction } from "./attachmentOpenAction"
import type { StepDirection } from "./attachmentMotion"
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

/**
 * The viewer's steps from `current` through `sequence`, or nothing when it
 * has nowhere to go: a chat with one attachment, or one not in the list (the
 * composer's, not sent yet; a previewed sub-chat's; one the window has moved
 * past). The list has ends: a press past one is `onEdge`'s, and moves nothing.
 */
export function attachmentNavigation(
  sequence: readonly ViewerAttachment[],
  current: ViewerAttachment,
  show: (attachment: ViewerAttachment, direction: StepDirection) => void,
  onEdge: (direction: StepDirection) => void = () => {},
): ViewerNavigation | undefined {
  const index = sequence.findIndex((attachment) => attachment.url === current.url)
  if (index < 0 || sequence.length < 2) return undefined
  const step = (direction: StepDirection) => {
    const target = sequence[index + (direction === "next" ? 1 : -1)]
    if (target) show(target, direction)
    else onEdge(direction)
  }
  return {
    index,
    count: sequence.length,
    onPrevious: () => step("previous"),
    onNext: () => step("next"),
    onEdge,
    previousLabel: "Previous attachment (k)",
    nextLabel: "Next attachment (j)",
    hasPrevious: index > 0,
    hasNext: index < sequence.length - 1,
    horizontal: true,
  }
}
