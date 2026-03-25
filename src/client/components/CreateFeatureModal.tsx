import { useEffect, useRef, useState } from "react"
import { Button } from "./ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"
import { Textarea } from "./ui/textarea"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (feature: { title: string; description: string }) => void | Promise<void>
}

export function canSubmitFeatureDraft(title: string) {
  return title.trim().length > 0
}

export function CreateFeatureModal({ open, onOpenChange, onConfirm }: Props) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setDescription("")
    setTimeout(() => titleRef.current?.focus(), 0)
  }, [open])

  const canSubmit = canSubmitFeatureDraft(title)

  const handleSubmit = () => {
    if (!canSubmit) return
    void onConfirm({
      title: title.trim(),
      description: description.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault()
            handleSubmit()
          }
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            handleSubmit()
          }}
        >
          <DialogBody className="space-y-4">
            <DialogTitle>Create Feature</DialogTitle>
            <DialogDescription>
              Name the feature folder and optionally add a short description for the initial `overview.md`.
            </DialogDescription>
            <div className="space-y-2">
              <label htmlFor="feature-title" className="text-sm font-medium">
                Feature name
              </label>
              <Input
                id="feature-title"
                ref={titleRef}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    handleSubmit()
                  }
                }}
                placeholder="Feature name"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="feature-description" className="text-sm font-medium">
                Description <span className="text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="feature-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={5}
                placeholder="Leave blank to add it later"
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" size="sm" disabled={!canSubmit}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
