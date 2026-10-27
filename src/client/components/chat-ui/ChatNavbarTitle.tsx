import { memo, useEffect, useMemo, useRef, useState } from "react"
import { GitBranch } from "lucide-react"
import { getRepoUrlLabel } from "../../../shared/git-url"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../app/chatFocusPolicy"
import { getProjectSidebarLabel } from "../../lib/project-label"
import { flattenSidebarThreads } from "../../lib/thread-sections"
import { useSidebarStore } from "../../stores/sidebarStore"
import { openContextMenuFromButton } from "../open-external-menu"
import { ProjectIcon } from "../ui/project-icon"
import { ThreadRowMenu, type ThreadRowMenuActions } from "./sidebar/ThreadRow"

/** A clickable part of the title: only its text colour answers the pointer. */
const TITLE_LINK = "min-w-0 truncate transition-colors hover:text-foreground"

/**
 * The chat's title, renamed where it stands: click it and it is a text field
 * in the same type at the same place, so nothing around it moves. Enter or
 * clicking away keeps the new name, Escape drops it.
 *
 * No pencil. The text cursor over a title is the affordance, the one a
 * Finder or Notion title gives, and a pencil would either sit there always,
 * as noise beside the title, or appear on hover and need
 * room held open for it.
 *
 * The name you typed shows at once and until the server's title catches up,
 * so the old one never flashes back in between.
 */
export function EditableTitle({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editing = draft !== null

  // The server's title has moved: whatever was submitted is settled.
  useEffect(() => setSubmitted(null), [title])
  useEffect(() => {
    if (editing) inputRef.current?.select()
    // Only on entering the field, not on each keystroke.
  }, [editing])

  const shown = submitted ?? title
  // Leaving the field ends the edit once. Removing a focused field can still
  // deliver its blur, which would otherwise save a title Escape had dropped,
  // or save one twice.
  const endedRef = useRef(false)
  const beginEditing = () => {
    endedRef.current = false
    setDraft(shown)
  }
  const commit = () => {
    if (endedRef.current) return
    endedRef.current = true
    const next = draft?.trim()
    setDraft(null)
    if (!next || next === shown) return
    setSubmitted(next)
    onRename(next)
  }

  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        title="Rename"
        onClick={beginEditing}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          beginEditing()
        }}
        className="min-w-0 cursor-text truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown}
      </span>
    )
  }

  return (
    // The hidden copy of the text is what sizes the field, so it is exactly
    // as wide as what's typed and the project beside it follows along.
    <span className="relative inline-grid min-w-[2ch] max-w-full">
      <span aria-hidden className="invisible truncate whitespace-pre text-sm font-medium">{draft || " "}</span>
      <input
        ref={inputRef}
        // The chat's focus keeper sends a stray Escape back to the composer,
        // which would blur this and save what Escape was pressed to drop.
        {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
        value={draft}
        aria-label="Chat title"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        // Selecting text in the field is not dragging what holds it (a tab).
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // The page's shortcuts are not for a title being typed.
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            endedRef.current = true
            setDraft(null)
          }
        }}
        // The underline is the one sign it is a field: no box, so the title
        // doesn't jump or change size going in and out.
        className="absolute inset-0 w-full min-w-0 bg-transparent text-sm font-medium underline decoration-muted-foreground/50 decoration-1 underline-offset-4 outline-none"
      />
    </span>
  )
}

/**
 * The open chat's title, at the left end of the chat navbar: its project's
 * icon, its title, then its project and branch. What the navbar shows unless
 * chat tabs are turned on (`ChatTabs`), in every sidebar view.
 *
 * It stands in for the chat's sidebar row, and so carries that row's
 * right-click menu (`ThreadRowMenu`), which the icon also opens on a click,
 * and names the project as that row's trailing label does
 * (`getProjectSidebarLabel`): the rename, the repo, or the folder. The
 * project opens its folder. The branch opens the repo's page on its forge,
 * and is plain text where the project has no such page.
 *
 * Its own component, reading the sidebar store itself: the chat page must not
 * re-render every time the open chat's sidebar row moves, which through a
 * turn is constantly.
 *
 * The block never takes the pointer beyond its own contents, so the rest of
 * the bar still drags the window in the Mac app.
 */
export const ChatNavbarTitle = memo(function ChatNavbarTitle({
  chatId,
  title,
  branchName,
  editorLabel,
  actions,
  onOpenFolder,
  onRename,
}: {
  chatId: string
  title: string
  branchName?: string
  editorLabel: string
  actions: ThreadRowMenuActions
  onOpenFolder: () => void
  /** Saves a title typed in place. */
  onRename: (title: string) => void
}) {
  // The group, not the row: it carries the project's name, icon and repo too.
  // Groups keep their identity across pushes that didn't touch them.
  const group = useSidebarStore((state) => state.data.projectGroups.find((item) => (
    item.chats.some((chat) => chat.chatId === chatId)
    || (item.archivedChats ?? []).some((chat) => chat.chatId === chatId)
  )))
  const thread = useMemo(
    () => (group ? flattenSidebarThreads({ projectGroups: [group] }).find((item) => item.chatId === chatId) : undefined),
    [chatId, group]
  )
  const repoUrl = group?.repoUrl
  const projectName = group ? getProjectSidebarLabel(group).name : undefined

  // Everything from the icon to the branch, as one right-click target. It
  // takes the pointer as a whole, the gaps between its parts included, so
  // the menu opens wherever on it you click.
  const content = (
    <div className="pointer-events-auto flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 shrink items-center gap-2">
        {group ? (
          // The icon is the menu's button: a click opens what a right-click
          // anywhere on the title does. Hovering raises a soft halo behind
          // it (a pseudo-element fading in, so nothing is laid out or
          // repainted but that), and a press sinks it a touch.
          <button
            type="button"
            title="Chat actions"
            aria-label="Chat actions"
            onClick={openContextMenuFromButton}
            className="relative flex shrink-0 rounded-[4px] outline-none transition-transform duration-150 ease-snappy before:absolute before:-inset-1 before:rounded-md before:bg-foreground/10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 focus-visible:before:opacity-100 active:scale-[0.94] motion-reduce:transition-none"
          >
            <ProjectIcon name={group.title} iconUrl={group.iconUrl} className="relative" />
          </button>
        ) : null}
        <EditableTitle title={title} onRename={onRename} />
      </span>
      {projectName || branchName ? (
        <span className="flex min-w-0 shrink-[4] items-center gap-1.5 text-xs text-muted-foreground">
          {projectName ? (
            <button type="button" className={TITLE_LINK} title="Show in Finder" onClick={onOpenFolder}>
              {projectName}
            </button>
          ) : null}
          {branchName ? (
            repoUrl ? (
              <button
                type="button"
                className={`${TITLE_LINK} flex items-center gap-0.5`}
                title={`Open on ${getRepoUrlLabel(repoUrl)}`}
                // In this browser, not through the machine the project lives
                // on: that is the wrong screen whenever it isn't this one.
                onClick={() => window.open(repoUrl, "_blank", "noopener,noreferrer")}
              >
                <GitBranch className="size-3 shrink-0" strokeWidth={2.25} />
                <span className="min-w-0 truncate">{branchName}</span>
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-0.5">
                <GitBranch className="size-3 shrink-0" strokeWidth={2.25} />
                <span className="min-w-0 truncate">{branchName}</span>
              </span>
            )
          ) : null}
        </span>
      ) : null}
    </div>
  )

  return (
    // On the row's own center, which the sidebar's bar shares: 27px down on
    // the web (KannaSidebar), the traffic lights' center in the Mac app.
    <div className="pointer-events-none hidden min-w-0 flex-1 items-center md:flex">
      {thread ? (
        <ThreadRowMenu thread={thread} archived={thread.archived} editorLabel={editorLabel} {...actions}>
          {content}
        </ThreadRowMenu>
      ) : content}
    </div>
  )
})
