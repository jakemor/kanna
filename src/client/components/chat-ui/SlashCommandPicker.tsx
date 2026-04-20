import { useEffect, useRef } from "react"
import type { SlashCommand } from "../../../shared/types"
import { cn } from "../../lib/utils"

interface SlashCommandPickerProps {
  items: SlashCommand[]
  activeIndex: number
  loading: boolean
  onSelect: (command: SlashCommand) => void
  onHoverIndex: (index: number) => void
}

const SKELETON_ROWS = 4
const DESCRIPTION_MAX_CHARS = 80

function clampDescription(text: string) {
  if (text.length <= DESCRIPTION_MAX_CHARS) return text
  return `${text.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
}

export function SlashCommandPicker({ items, activeIndex, loading, onSelect, onHoverIndex }: SlashCommandPickerProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const el = listRef.current?.children.item(activeIndex) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (items.length === 0 && loading) {
    return (
      <ul
        aria-busy="true"
        aria-label="Loading slash commands"
        className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl rounded-md border border-border bg-popover shadow-md overflow-hidden"
      >
        {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <li
            key={i}
            className="flex flex-col gap-1 px-3 py-1.5 sm:flex-row sm:items-center sm:gap-3"
            data-testid="slash-picker-skeleton-row"
          >
            <span className="h-3 w-28 rounded bg-muted animate-pulse" />
            <span className="hidden h-3 w-16 rounded bg-muted/70 animate-pulse sm:inline-block" />
            <span className="h-3 w-40 max-w-full rounded bg-muted/60 animate-pulse sm:ml-auto" />
          </li>
        ))}
      </ul>
    )
  }

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl rounded-md border border-border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        No matching commands
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl max-h-64 overflow-auto rounded-md border border-border bg-popover shadow-md"
    >
      {items.map((cmd, i) => (
        <li
          key={cmd.name}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(event) => {
            event.preventDefault()
            onSelect(cmd)
          }}
          onMouseEnter={() => onHoverIndex(i)}
          className={cn(
            "flex flex-col gap-0.5 px-3 py-1.5 cursor-pointer text-sm sm:flex-row sm:items-center sm:gap-3",
            i === activeIndex && "bg-accent text-accent-foreground",
          )}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono break-all sm:whitespace-nowrap sm:break-normal">/{cmd.name}</span>
            {cmd.argumentHint ? (
              <span className="shrink-0 font-mono text-xs text-muted-foreground whitespace-nowrap">
                {cmd.argumentHint}
              </span>
            ) : null}
          </div>
          {cmd.description ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground sm:text-right">
              {clampDescription(cmd.description)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
