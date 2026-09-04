import { Archive, Folder, ListFilter, MessageCircle } from "lucide-react"
import { InputPopover, PopoverMenuItem } from "../ChatPreferenceControls"

/** Which view the sidebar shows when the recent-chats Labs mode is enabled. */
export type SidebarView = "recents" | "projects" | "archived"

/**
 * One row's text: the name with its qualifier trailing it inline — rows in a
 * picker this small read better on one line each.
 *
 * Same treatment as `PopoverMenuItem`'s own `description` subtitle. The weight
 * has to be stated: unlike that slot, this sits *inside* the label, so it would
 * otherwise inherit its medium weight and read as part of the name.
 */
function ViewLabel({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{name}</span>
      <span className="text-xs font-normal text-muted-foreground">{detail}</span>
    </span>
  )
}

/**
 * Swaps the sidebar between its Chats, Projects and Archived views.
 *
 * Sits at the right end of the New Chat row — one fixed spot that doesn't move
 * with the view or with which section happens to render first. The odd width
 * optically centers the gear under the header's Projects (house) button: the
 * scroll area insets its content by 7px, so 17px of button puts the glyph on
 * the same 24px-from-the-edge axis the house sits on — plus a 1px nudge left,
 * because the gear's silhouette reads a hair right of that axis at this size.
 */
export function SidebarViewSwitcher({
  view,
  onChange,
}: {
  view: SidebarView
  onChange: (view: SidebarView) => void
}) {
  return (
    <InputPopover
      // Right-edge trigger: hang the 16rem panel leftward, into the sidebar.
      align="end"
      triggerClassName="mr-px h-8 w-[34px] justify-center rounded-lg border border-border/0 p-0 hover:border-border hover:bg-muted"
      trigger={<ListFilter className="size-4 shrink-0" />}
    >
      {(close) => (
        <>
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("recents")
            }}
            selected={view === "recents"}
            icon={<MessageCircle className="h-4 w-4" />}
            label={<ViewLabel name="Chats" detail="grouped by relevance" />}
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("projects")
            }}
            selected={view === "projects"}
            icon={<Folder className="h-4 w-4" />}
            label={<ViewLabel name="Projects" detail="grouped by recency" />}
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("archived")
            }}
            selected={view === "archived"}
            icon={<Archive className="h-4 w-4" />}
            label={<ViewLabel name="Archived" detail="recently archived" />}
          />
        </>
      )}
    </InputPopover>
  )
}
