import { ExternalLink } from "lucide-react"
import { CopyButton } from "../ui/copy-button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogTitle,
} from "../ui/dialog"

interface Props {
  open: boolean
  shareUrl: string
  onOpenChange: (open: boolean) => void
  onOpenLink: () => void
  onCopyLink: () => Promise<boolean>
}

export function StandaloneShareDialog({
  open,
  shareUrl,
  onOpenChange,
  onOpenLink,
  onCopyLink,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Shared Link</DialogTitle>
          <DialogDescription>Shared links are snapshots in time and contain all attachments, tool calls and history. Be mindful of sensitive info.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex w-full items-center gap-2 rounded-2xl border border-border bg-muted/40 pl-4 px-3 py-2.5">
            {/* <Globe className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> */}
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{shareUrl}</span>
            <CopyButton
              plain
              onCopy={onCopyLink}
              title="Copy link"
              copiedTitle="Copied"
              checkClassName="h-4 w-4 text-emerald-400"
              className="flex flex-shrink-0 items-center justify-center rounded-lg text-logo hover:text-logo/60 transition-colors hover:bg-background hover:text-foreground"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogPrimaryButton type="button" onClick={onOpenLink}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open
          </DialogPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
