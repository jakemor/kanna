import { useEffect, useState, type ReactNode } from "react"
import { ChevronDown, Cloud, ExternalLink, LaptopMinimal } from "lucide-react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { InputPopover, PopoverMenuItem } from "../components/chat-ui/ChatPreferenceControls"
import { findCurrentMachine, useConnectionStore } from "../stores/connectionStore"
import { cn } from "../lib/utils"

const MANAGE_MACHINES_URL = "https://kanna.sh/machines"

/** Shared trigger padding: borderless, but keeps the same net inset as before. */
const TRIGGER_CLASS = "w-full justify-between py-1.5 rounded-md hover:bg-transparent"

/** Wrapper for the sidebar footer: sits just above the Settings button. */
function MachineSection({ children }: { children: ReactNode }) {
  return <div className="pl-2.5 pr-[7px] py-1 border-t ">{children}</div>
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`}
      aria-hidden
    />
  )
}

function PairInstructionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use this machine from anywhere</DialogTitle>
          <DialogDescription>
            Get a personal URL that works from any browser, 100% free.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Sign in at{" "}
              <a href={MANAGE_MACHINES_URL} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                kanna.sh/machines
              </a>{" "}
              and add a machine.
            </li>
            <li>
              Run{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">bunx kanna pair &lt;code&gt;</code>{" "}
              in a terminal on this machine.
            </li>
          </ol>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Sidebar machine switcher. Local mode offers pairing instructions; cloud
 * mode lists the account's machines and navigates between their subdomains.
 * Mode comes from connectionStore's /__cloud/machines feature detection.
 */
export function MachineSwitcher() {
  const mode = useConnectionStore((state) => state.mode)
  const machines = useConnectionStore((state) => state.machines)
  const load = useConnectionStore((state) => state.load)
  const [pairDialogOpen, setPairDialogOpen] = useState(false)

  useEffect(() => {
    if (mode === "unknown") {
      void load()
    }
  }, [mode, load])

  if (mode === "unknown") {
    return null
  }

  if (mode === "local") {
    return (
      <MachineSection>
        <button
          type="button"
          onClick={() => setPairDialogOpen(true)}
          className={cn(
            "flex items-center gap-1.5 px-[10px] text-sm text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
            TRIGGER_CLASS
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Cloud className="ml-[1px] size-4 shrink-0" />
            <span className="truncate text-xs font-medium">Setup Kanna Cloud</span>
          </span>
          <ExternalLink className="size-3.5 shrink-0 opacity-60" />
        </button>
        <PairInstructionsDialog open={pairDialogOpen} onOpenChange={setPairDialogOpen} />
      </MachineSection>
    )
  }

  const currentMachine = findCurrentMachine(machines)

  return (
    <MachineSection>
      <InputPopover
        triggerClassName={cn(TRIGGER_CLASS, "px-[11px]")}
        trigger={
          <>
            <span className="flex min-w-0 items-center gap-2">
              <LaptopMinimal className="size-4 shrink-0" />
              <span className="truncate text-xs font-medium">
                {currentMachine?.name ?? window.location.hostname}
              </span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </>
        }
      >
        {(close) => (
          <>
            {machines.map((machine) => {
              const isCurrent = machine.subdomain === currentMachine?.subdomain
              return (
                <PopoverMenuItem
                  key={machine.subdomain}
                  onClick={() => {
                    close()
                    if (!isCurrent) {
                      window.location.href = machine.appOrigin
                    }
                  }}
                  selected={isCurrent}
                  icon={<OnlineDot online={machine.online} />}
                  label={machine.name}
                  description={`${machine.subdomain}.kanna.sh${machine.online ? "" : " · offline"}`}
                />
              )
            })}
            <PopoverMenuItem
              onClick={() => {
                close()
                window.open(MANAGE_MACHINES_URL, "_blank", "noopener")
              }}
              selected={false}
              icon={<ExternalLink className="h-4 w-4" />}
              label="Manage machines"
              description="Add or remove machines on kanna.sh"
            />
          </>
        )}
      </InputPopover>
    </MachineSection>
  )
}
