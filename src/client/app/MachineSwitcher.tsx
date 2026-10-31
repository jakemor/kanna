import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronsUpDown, Cloud, ExternalLink, LaptopMinimal, Loader2, Settings2, X } from "lucide-react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { Button } from "../components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip"
import { CloudPairPanel } from "../components/cloud/CloudPairPanel"
import { useCloudPairSession } from "../components/cloud/useCloudPairSession"
import { InputPopover, PopoverMenuItem } from "../components/chat-ui/ChatPreferenceControls"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { findCurrentMachine, useConnectionStore } from "../stores/connectionStore"
import { displayClaimUrl } from "../lib/pairSession"
import { postToMacApp } from "../lib/macApp"
import { cn } from "../lib/utils"
import type { CloudMachineSummary } from "../../shared/cloud-api"

export const FLEET_URL = "https://kanna.sh/fleet"
const THIS_MAC_NAME = "This Mac"

/**
 * Shared trigger padding: borderless, but keeps the same net inset as before.
 * With no fill, the text brightening is the hover and open-state feedback.
 */
const TRIGGER_CLASS = "w-full justify-between py-1.5 rounded-md transition-colors duration-150 hover:bg-transparent hover:text-foreground data-[state=open]:text-foreground"

/**
 * How long the picker shows a switch as pending. Leaving the page (or Kanna
 * for Mac reporting the new machine) normally ends it first; this covers a
 * switch that went nowhere, like the Mac app sending you to sign in.
 */
const SWITCH_PENDING_MS = 8_000

const SIDEBAR_BUTTON_CLASS = cn(
  "flex items-center gap-1.5 px-[10px] text-sm text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
  TRIGGER_CLASS
)

/** Wrapper for the sidebar footer: sits just above the Settings button. */
function MachineSection({ children }: { children: ReactNode }) {
  return <div className="pl-2.5 pr-[7px] py-1 border-t ">{children}</div>
}

/** Centred in an icon-sized box, so machine names line up with Manage Fleet's icon row. */
function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <span className={`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`} />
    </span>
  )
}

/**
 * Sidebar machine switcher. Cloud mode lists the account's machines and
 * navigates between their subdomains (mode comes from connectionStore's
 * /__cloud/machines feature detection); local mode offers one-click pairing,
 * or a shortcut to the hosted URL once this machine has one. A paired
 * machine on localhost lists its Fleet too (connectionStore). In Kanna for
 * Mac the app does the switching (this Mac at localhost, the rest at
 * kanna.sh).
 */
export function MachineSwitcher({ onDismissCloudSetup }: { onDismissCloudSetup: () => void }) {
  const mode = useConnectionStore((state) => state.mode)
  const machines = useConnectionStore((state) => state.machines)
  const load = useConnectionStore((state) => state.load)
  const fromMacApp = useConnectionStore((state) => state.fromMacApp)
  const thisMachineSubdomain = useConnectionStore((state) => state.thisMachine)
  const showingMachine = useConnectionStore((state) => state.showingMachine)
  const cloudSetupDismissed = useAppSettingsStore((state) => state.settings?.cloudSetupDismissed === true)
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const { session, starting, begin } = useCloudPairSession({ enabled: mode === "local" })
  const startedRef = useRef(false)
  // The machine being switched to. Loading another machine takes a moment
  // (a new origin, a new socket), and without this the picker closes and
  // nothing seems to happen.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  useEffect(() => {
    if (switchingTo === null) return
    const timeout = window.setTimeout(() => setSwitchingTo(null), SWITCH_PENDING_MS)
    // Back/forward restores this page from the cache mid-switch.
    const onPageShow = () => setSwitchingTo(null)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [switchingTo])

  // Kanna for Mac reports the machine it now shows.
  useEffect(() => {
    setSwitchingTo(null)
  }, [showingMachine])

  useEffect(() => {
    if (mode === "unknown") {
      void load()
    }
  }, [mode, load])

  // Mint a claim URL the first time the dialog opens; the server reuses a
  // live session, so reopening never burns a code.
  useEffect(() => {
    if (!pairDialogOpen || startedRef.current) return
    if (session.status === "paired" || session.status === "unsupported") return
    startedRef.current = true
    begin()
  }, [pairDialogOpen, session.status, begin])

  if (mode === "unknown") {
    return null
  }

  if (mode === "local") {
    const pairedOrigin = session.status === "paired" ? session.appOrigin : null
    // Only the setup prompt can be hidden; a paired machine keeps its link.
    if (!pairedOrigin && cloudSetupDismissed) return null
    return (
      <MachineSection>
        {pairedOrigin ? (
          <a href={pairedOrigin} target="_blank" rel="noreferrer" className={SIDEBAR_BUTTON_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              <Cloud className="ml-[1px] size-4 shrink-0" />
              <span className="truncate text-xs font-medium">{displayClaimUrl(pairedOrigin)}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : (
          // The dismiss X takes the link icon's place, drawn like the sidebar
          // section headers' hover buttons. Where a pointer hovers it shows
          // only while the row is hovered or has keyboard focus. A touch
          // screen has no hover, so there it is always shown, and under a
          // finger its target grows to 44px wide and the section's full height.
          <div className="group/cloud-setup relative">
            <button type="button" onClick={() => setPairDialogOpen(true)} className={SIDEBAR_BUTTON_CLASS}>
              <span className="flex min-w-0 items-center gap-2">
                <Cloud className="ml-[1px] size-4 shrink-0" />
                <span className="truncate text-xs font-medium">Setup Kanna Cloud</span>
              </span>
              <ExternalLink className="size-3.5 shrink-0 opacity-60 transition-opacity duration-150 [@media(hover:none)]:invisible [@media(hover:hover)]:group-hover/cloud-setup:opacity-0 group-has-[:focus-visible]/cloud-setup:opacity-0" />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDismissCloudSetup}
                  aria-label="Dismiss Kanna Cloud setup"
                  className={cn(
                    "absolute right-1.5 top-1/2 h-5.5 w-5.5 -translate-y-1/2 !rounded",
                    "duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/cloud-setup:opacity-100 [@media(hover:hover)]:group-has-[:focus-visible]/cloud-setup:opacity-100",
                    "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-[11px] pointer-coarse:before:-inset-y-[7px] pointer-coarse:before:content-['']",
                  )}
                >
                  <X className="size-3.5 text-slate-500 dark:text-slate-400" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                Dismiss
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        <Dialog open={pairDialogOpen} onOpenChange={setPairDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Use this machine from anywhere</DialogTitle>
              <DialogDescription>
                Get a personal URL that works from any browser, 100% free.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <CloudPairPanel session={session} starting={starting} onRetry={begin} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      </MachineSection>
    )
  }

  // On localhost (the server names itself) and in Kanna for Mac (the app
  // says which machine is showing), the page knows which machine it's on,
  // and lists it first as This machine. The Mac app lists this Mac even when
  // it isn't on Kanna Cloud, so there's a way back.
  const knowsSelf = fromMacApp || thisMachineSubdomain !== null
  // Kanna for Mac is always on a Mac; a localhost page could be any machine.
  const thisMachineLabel = fromMacApp ? THIS_MAC_NAME : "This machine"
  const thisMachine = knowsSelf ? machines.find((machine) => machine.subdomain === thisMachineSubdomain) : undefined
  const currentMachine = knowsSelf
    ? machines.find((machine) => machine.subdomain === (showingMachine ?? thisMachineSubdomain)) ?? null
    : findCurrentMachine(machines)
  const showingThisMac = knowsSelf && (showingMachine === null || showingMachine === thisMachineSubdomain)
  const otherMachines = knowsSelf
    ? machines.filter((machine) => machine.subdomain !== thisMachineSubdomain)
    : machines
  const open = (machine: CloudMachineSummary | null) => {
    setSwitchingTo(machine?.name ?? thisMachine?.name ?? THIS_MAC_NAME)
    if (fromMacApp) {
      postToMacApp({ type: "openMachine", subdomain: machine?.subdomain ?? null })
    } else if (machine) {
      window.location.href = machine.appOrigin
    }
  }

  return (
    <MachineSection>
      <InputPopover
        triggerClassName={cn(TRIGGER_CLASS, "px-[11px]")}
        trigger={
          <>
            <span className="flex min-w-0 items-center gap-2">
              <LaptopMinimal className="size-4 shrink-0" />
              <span className="truncate text-xs font-medium">
                {switchingTo ?? currentMachine?.name ?? (showingThisMac ? THIS_MAC_NAME : window.location.hostname)}
              </span>
            </span>
            {/* The list opens upward from the footer, so the chevron points
                both ways, as a macOS pop-up button does. */}
            {switchingTo !== null ? (
              <Loader2 aria-label={`Switching to ${switchingTo}`} className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
            )}
          </>
        }
      >
        {(close) => (
          <>
            {knowsSelf ? (
              <PopoverMenuItem
                onClick={() => {
                  close()
                  if (!showingThisMac) open(null)
                }}
                selected={showingThisMac}
                icon={<OnlineDot online />}
                // Named once: off Kanna Cloud the label is the name.
                label={<span className="[overflow-wrap:anywhere]">{thisMachine?.name ?? thisMachineLabel}</span>}
                // Kept whole: a long name wraps in the label instead of
                // squeezing this, even one with no spaces to break at.
                trailing={thisMachine ? (
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{thisMachineLabel}</span>
                ) : undefined}
              />
            ) : null}
            {otherMachines.map((machine) => {
              const isCurrent = machine.subdomain === currentMachine?.subdomain
              return (
                <PopoverMenuItem
                  key={machine.subdomain}
                  onClick={() => {
                    close()
                    if (!isCurrent) open(machine)
                  }}
                  selected={isCurrent}
                  icon={<OnlineDot online={machine.online} />}
                  // The dot says online or offline; the address isn't needed to pick one.
                  label={machine.name}
                />
              )
            })}
            <PopoverMenuItem
              onClick={() => {
                close()
                window.open(FLEET_URL, "_blank", "noopener")
              }}
              selected={false}
              icon={<Settings2 className="size-4 shrink-0 text-muted-foreground" />}
              label="Manage Fleet"
              // Says it leaves the app, on the side the other rows use.
              trailing={<ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />}
            />
          </>
        )}
      </InputPopover>
    </MachineSection>
  )
}
