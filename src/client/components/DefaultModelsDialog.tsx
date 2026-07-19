import { useState } from "react"
import type { FaveModel } from "../../shared/types"
import { Button } from "./ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "./ui/dialog"

/**
 * Edits the Default Models list (pi's model picker) — opened from Settings and
 * from the "Add models…" row in the chat input's model picker.
 *
 * The dialog edits a local draft only — nothing commits until Done or
 * dismissal. Mid-edit commits would echo a snapshot back that resets the draft
 * (normalization drops id-less rows), wiping a row while it's being filled in.
 *
 * A blank row is always rendered at the bottom; typing into it appends a real
 * entry (and a fresh blank row appears below).
 */
export function DefaultModelsDialog({
  open,
  onOpenChange,
  faveModels,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  faveModels: FaveModel[]
  onSave: (faveModels: FaveModel[]) => void
}) {
  const [draft, setDraft] = useState<FaveModel[]>([])

  // Re-seed the draft from the saved list whenever the dialog opens (parents
  // open it by flipping `open`, so this is a render-time state adjustment).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft(faveModels.map((fave) => ({ ...fave })))
    }
  }

  function closeDialog() {
    onOpenChange(false)
    // Drop rows that never got a model id and save the rest.
    onSave(draft.filter((fave) => fave.id.trim().length > 0))
  }

  // Functional updates: row edits arrive per keystroke, and computing the next
  // array from a render-scope draft corrupts neighbors when events outpace
  // re-renders (stale closures). Mutations always apply to the current state.
  function setFaveModelField(index: number, field: "label" | "id", value: string) {
    setDraft((faves) => {
      // An index past the end targets the always-present blank bottom row —
      // typing there appends a real entry.
      if (index >= faves.length) {
        return [...faves, { label: "", id: "", [field]: value }]
      }
      return faves.map((entry, entryIndex) => (entryIndex === index ? { ...entry, [field]: value } : entry))
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog()
        }
      }}
    >
      <DialogContent size="lg">
        <DialogBody className="space-y-4">
          <DialogTitle>Default Models</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Shown in Pi's model picker. Each entry has a display label and the model id sent to the Model Registry endpoint.
          </p>
          <div className="max-h-[55vh] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-background">
            {[...draft, { label: "", id: "" }].map((fave, index) => {
              const isNewRow = index === draft.length
              return (
                <div key={index} className="flex items-center">
                  <input
                    value={fave.label}
                    onChange={(event) => setFaveModelField(index, "label", event.target.value)}
                    placeholder="Name"
                    spellCheck={false}
                    className="w-[160px] shrink-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
                  />
                  <input
                    value={fave.id}
                    onChange={(event) => setFaveModelField(index, "id", event.target.value)}
                    placeholder="Model id"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground/60"
                  />
                  {isNewRow ? (
                    <div className="w-9 shrink-0" />
                  ) : (
                    <button
                      type="button"
                      aria-label="Remove default model"
                      onClick={() => {
                        setDraft((faves) => faves.filter((_, entryIndex) => entryIndex !== index))
                      }}
                      className="flex w-9 shrink-0 items-center justify-center self-stretch text-muted-foreground transition-colors hover:text-foreground"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={closeDialog}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
