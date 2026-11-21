import { Check, CornerDownLeft, Play, Plus, Trash2, Zap } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FocusEvent, type FormEvent } from "react"
import type { ProjectQuickAction } from "../../../../shared/protocol"
import type { KannaSocket } from "../../../app/socket"
import {
  getCachedProjectQuickActions,
  refreshCachedProjectQuickActions,
  writeCachedProjectQuickActions,
} from "../../../lib/localServersCache"
import { cn } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { ContextMenuItem } from "../../ui/context-menu"
import { WIDGET_STRIP_INPUT_CLASS, WidgetError, WidgetList, WidgetRow, WidgetStrip } from "./parts"
import { SwapIn, useWidgetExpanded, WidgetCard } from "./WidgetCard"

/**
 * The project's saved commands (e.g. `bun run dev`), each run in a new
 * terminal. Stored in <project>/.kanna/quick-actions.json.
 *
 * The one widget that shows even when empty: it is how Quick Actions are
 * added, so hiding it with none saved would leave no way to add the first.
 * Empty, opening it (or pressing +) goes straight to the add form.
 */
export function QuickActionsWidget({
  projectId,
  socket,
  onRun,
}: {
  projectId: string
  socket: KannaSocket
  onRun: (command: string) => void
}) {
  const [quickActions, setQuickActions] = useState<ProjectQuickAction[]>(() => getCachedProjectQuickActions(projectId) ?? [])
  const [error, setError] = useState<string | null>(null)
  const [newCommand, setNewCommand] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  // Open by default with a few saved (defaultWidgetExpanded). Adding, or an
  // error to read, holds it open: neither should hide behind a closed header.
  const [expanded, setExpanded] = useWidgetExpanded(projectId, "quickActions", quickActions.length)
  const isOpen = expanded || isAdding || error !== null
  // The action just run shows a check for a moment. Its terminal opens
  // elsewhere, so without this a click reads as "did that run?", and a
  // second click starts a second server.
  const [ranActionId, setRanActionId] = useState<string | null>(null)
  const ranTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (ranTimerRef.current !== null) window.clearTimeout(ranTimerRef.current)
  }, [])
  function runAction(action: ProjectQuickAction) {
    onRun(action.command)
    setRanActionId(action.id)
    if (ranTimerRef.current !== null) window.clearTimeout(ranTimerRef.current)
    ranTimerRef.current = window.setTimeout(() => {
      ranTimerRef.current = null
      setRanActionId(null)
    }, 1_000)
  }

  useEffect(() => {
    setQuickActions(getCachedProjectQuickActions(projectId) ?? [])
    void refreshCachedProjectQuickActions(socket, projectId)
      .then((actions) => {
        setQuickActions(actions)
        setError(null)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [projectId, socket])

  const writeQuickActions = useCallback((actions: ProjectQuickAction[]) => {
    setQuickActions(actions)
    void writeCachedProjectQuickActions(socket, projectId, actions)
      .then(setQuickActions)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [projectId, socket])

  function addQuickAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const command = newCommand.trim()
    if (!command) return
    writeQuickActions([
      ...quickActions,
      { id: globalThis.crypto?.randomUUID?.() ?? `quick-action-${Date.now()}`, label: command, command },
    ])
    setNewCommand("")
    setIsAdding(false)
  }

  // A press inside the widget blurs the form before its click lands. Closing
  // on that blur made a header click loop: the blur collapsed the section,
  // the click then reopened it and refocused the form, and so on. So a press
  // that starts in here leaves the decision to the click it becomes (header
  // toggles, + toggles the form, a row runs); only focus leaving for
  // somewhere else closes the form. relatedTarget alone can't tell, because
  // Safari doesn't focus buttons on click.
  const pressInWidgetRef = useRef(false)
  function notePressInWidget() {
    pressInWidgetRef.current = true
    // Cleared after the click this press turns into has been handled.
    window.addEventListener("pointerup", () => {
      setTimeout(() => { pressInWidgetRef.current = false }, 0)
    }, { once: true })
  }

  function handleComposerBlur(event: FocusEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    if (pressInWidgetRef.current) return
    setIsAdding(false)
    // With nothing saved the form was the whole body; leaving it folds the
    // section back rather than holding an open header over nothing.
    if (quickActions.length === 0) setExpanded(false)
  }

  return (
    <div onPointerDownCapture={notePressInWidget}>
      <WidgetCard
        icon={<Zap />}
        title="Quick Actions"
        count={quickActions.length > 0 ? quickActions.length : undefined}
        // Always a disclosure. With nothing saved, opening it goes straight to
        // the add form, since that is all there is to show.
        expanded={isOpen}
        onToggle={() => {
          if (isOpen) {
            setExpanded(false)
            setIsAdding(false)
          } else {
            setExpanded(true)
            if (quickActions.length === 0) setIsAdding(true)
          }
        }}
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="none"
            aria-label="Add quick action"
            title="Add quick action"
            onClick={() => {
              // Opening the composer opens the section with it.
              if (!isAdding) setExpanded(true)
              setIsAdding((current) => !current)
            }}
            className="size-6 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground"
          >
            <Plus className="size-4" />
          </Button>
        )}
      >
        {/* The add form is a Strip over the saved actions, not a row among
            them: it acts on the list, and a row is something you run. */}
        {isAdding ? (
          <WidgetStrip
            leading={<Zap />}
            form={{ onSubmit: addQuickAction, onBlur: handleComposerBlur }}
            trailing={(
              <Button
                type="submit"
                variant="ghost"
                size="none"
                aria-label="Save quick action"
                disabled={!newCommand.trim()}
                className="h-6 rounded-md px-2 text-muted-foreground hover:!bg-transparent hover:text-foreground"
              >
                <CornerDownLeft className="size-3.5" />
              </Button>
            )}
          >
            <input
              value={newCommand}
              onChange={(event) => setNewCommand(event.target.value)}
              placeholder="bun run dev"
              aria-label="Command"
              autoComplete="off"
              spellCheck={false}
              className={cn(WIDGET_STRIP_INPUT_CLASS, "font-mono text-[13px]")}
              autoFocus
            />
          </WidgetStrip>
        ) : null}
        {quickActions.length > 0 || error ? (
          <WidgetList>
            {error ? <WidgetError>{error}</WidgetError> : null}
            {quickActions.map((action) => (
              <WidgetRow
                key={action.id}
                icon={(
                  <SwapIn swapKey={ranActionId === action.id ? "ran" : "idle"}>
                    {ranActionId === action.id
                      ? <Check className="text-success" aria-label="Started" />
                      : <Play className="group-hover/row:text-foreground" />}
                  </SwapIn>
                )}
                title={(
                  <span className="font-mono text-[13px]">
                    {action.label}
                    {/* The file is the project's, so a clone brings its
                        actions with it. A label that is not the command gets
                        the command beside it: what runs is what is shown. */}
                    {action.command.startsWith(action.label)
                      ? null
                      : <span className="text-muted-foreground"> · {action.command}</span>}
                  </span>
                )}
                tooltip={action.command}
                onActivate={() => runAction(action)}
                menuLabel="Quick action options"
                menu={(
                  <ContextMenuItem
                    onSelect={() => writeQuickActions(quickActions.filter((candidate) => candidate.id !== action.id))}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    <span>Delete</span>
                  </ContextMenuItem>
                )}
              />
            ))}
          </WidgetList>
        ) : null}
      </WidgetCard>
    </div>
  )
}
