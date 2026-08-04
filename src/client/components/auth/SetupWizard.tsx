import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Check, ChevronLeft, Cloud, Flower } from "lucide-react"
import { AUTH_SERVICE_LABELS, type AuthServiceId } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { displayClaimUrl } from "../../lib/pairSession"
import { useProviderAuthStore, useSetupStatus, selectAuthService } from "../../stores/providerAuthStore"
import { CloudPairPanel } from "../cloud/CloudPairPanel"
import { useCloudPairSession } from "../cloud/useCloudPairSession"
import { AUTH_SERVICE_ICONS } from "../provider-icons"
import { Button } from "../ui/button"
import { AuthCard } from "./AuthCard"

/**
 * The cloud step is dropped entirely when this machine can't use it (already
 * paired, or a run that can't pair in place), so the progress bar never
 * promises a step that won't appear.
 */
const BASE_STEPS = ["github", "agents", "openrouter"] as const
type SetupStep = (typeof BASE_STEPS)[number] | "cloud" | "done"

/** Auto-advance delay after a skippable step connects — long enough to see the ✓ land. */
const AUTO_ADVANCE_MS = 900

const AGENT_SERVICES: AuthServiceId[] = ["claude", "codex", "cursor", "opencode"]

/** Cards that carry a pill in the agents step. */
const AGENT_BADGES: Partial<Record<AuthServiceId, string>> = {
  // opencode ships free models, so it's the fastest card to get running.
  opencode: "Recommended",
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2 text-center">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

/**
 * Shared step footer:
 *   [ (‹)  |        Continue        ]
 *              Skip for now
 * Back is a circular icon button inline with Continue; Skip sits below.
 */
function StepFooter({
  canContinue,
  onContinue,
  onBack,
  onSkip,
  hint,
}: {
  canContinue: boolean
  onContinue: () => void
  onBack?: () => void
  onSkip?: () => void
  hint?: string
}) {
  return (
    <div className="mt-auto space-y-2 pt-10">
      <div className="flex items-center gap-2">
        {/* Back (or an equal spacer) plus a mirrored spacer on the right keep
            Continue the same width and dead-center on every step. */}
        {onBack ? (
          <Button
            variant="outline"
            aria-label="Back"
            onClick={onBack}
            className="h-11 w-11 shrink-0 rounded-full p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : (
          <div aria-hidden className="h-11 w-11 shrink-0" />
        )}
        <Button className="h-11 flex-1" disabled={!canContinue} onClick={onContinue}>
          Continue
        </Button>
        <div aria-hidden className="h-11 w-11 shrink-0" />
      </div>
      {/* The skip slot always occupies its height so the row above never jumps. */}
      {onSkip ? (
        <Button
          variant="ghost"
          onClick={onSkip}
          className="h-10 w-full text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:border-transparent hover:text-foreground"
        >
          Skip for now
        </Button>
      ) : (
        <div aria-hidden={hint ? undefined : true} className="flex h-10 items-center justify-center">
          {hint ? <p className="text-center text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      )}
    </div>
  )
}

/**
 * Full-screen, distraction-free onboarding flow:
 *   1. GitHub (skippable) → 2. at least one coding agent → 3. OpenRouter
 *   (skippable) → 4. Kanna Cloud (skippable, omitted when unavailable) →
 *   5. done. Reuses the AuthCard sign-in mechanics; steps that are already
 * satisfied are skipped on open, and skippable steps auto-advance the moment
 * they connect.
 */
export function SetupWizard() {
  const open = useProviderAuthStore((store) => store.setupWizardOpen)
  const socket = useProviderAuthStore((store) => store.socket)
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  const dismissSetupWizard = useProviderAuthStore((store) => store.dismissSetupWizard)
  const completeSetupWizard = useProviderAuthStore((store) => store.completeSetupWizard)
  const status = useSetupStatus()
  const navigate = useNavigate()

  // Finishing onboarding always lands on the home page.
  const handleComplete = () => {
    completeSetupWizard()
    navigate("/")
  }

  const [step, setStep] = useState<SetupStep>("github")
  const wasOpenRef = useRef(false)

  const cloud = useCloudPairSession({ enabled: open })
  // Decided once per open, from the first status that lands: a machine that
  // pairs mid-wizard must not yank its own step out from under itself.
  const [cloudStepEnabled, setCloudStepEnabled] = useState(false)
  const cloudDecidedRef = useRef(false)
  const cloudStartedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      cloudDecidedRef.current = false
      cloudStartedRef.current = false
      return
    }
    if (cloudDecidedRef.current || !cloud.loaded) return
    cloudDecidedRef.current = true
    setCloudStepEnabled(cloud.session.status !== "paired" && cloud.session.status !== "unsupported")
  }, [open, cloud.loaded, cloud.session.status])

  const steps = useMemo<SetupStep[]>(
    () => [...BASE_STEPS, ...(cloudStepEnabled ? (["cloud"] as const) : []), "done"],
    [cloudStepEnabled]
  )

  // On open, start at the first unsatisfied step (all satisfied → done).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setStep(
        !status.githubConnected ? "github"
        : !status.anyAgentConnected ? "agents"
        : !status.openRouterConnected ? "openrouter"
        : "done"
      )
    }
    wasOpenRef.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Entering the cloud step mints the claim URL (once — the server hands back
  // the live session if one is already open).
  const cloudStatus = cloud.session.status
  const beginCloudPairing = cloud.begin
  useEffect(() => {
    if (step !== "cloud" || cloudStartedRef.current || cloudStatus === "paired") return
    cloudStartedRef.current = true
    beginCloudPairing()
  }, [step, cloudStatus, beginCloudPairing])

  // Auto-advance skippable steps on the false→true connect transition only,
  // so navigating Back to an already-connected step doesn't bounce forward.
  const prevGithubRef = useRef(status.githubConnected)
  const prevOpenRouterRef = useRef(status.openRouterConnected)
  useEffect(() => {
    const githubJustConnected = !prevGithubRef.current && status.githubConnected
    const openRouterJustConnected = !prevOpenRouterRef.current && status.openRouterConnected
    prevGithubRef.current = status.githubConnected
    prevOpenRouterRef.current = status.openRouterConnected
    if (!open) return
    if (step === "github" && githubJustConnected) {
      const timer = setTimeout(() => setStep("agents"), AUTO_ADVANCE_MS)
      return () => clearTimeout(timer)
    }
    if (step === "openrouter" && openRouterJustConnected) {
      const timer = setTimeout(() => setStep(cloudStepEnabled ? "cloud" : "done"), AUTO_ADVANCE_MS)
      return () => clearTimeout(timer)
    }
  }, [open, step, status.githubConnected, status.openRouterConnected, cloudStepEnabled])

  // Same treatment for the cloud step: let the "you're live" state land, then
  // move on. The machine keeps connecting in the background either way.
  const machinePaired = cloud.session.status === "paired"
  const prevPairedRef = useRef(machinePaired)
  useEffect(() => {
    const justPaired = !prevPairedRef.current && machinePaired
    prevPairedRef.current = machinePaired
    if (!open || step !== "cloud" || !justPaired) return
    const timer = setTimeout(() => setStep("done"), AUTO_ADVANCE_MS * 2)
    return () => clearTimeout(timer)
  }, [open, step, machinePaired])

  const stepIndex = steps.indexOf(step)
  const progressPercent = ((stepIndex + 1) / steps.length) * 100

  const services = useMemo(() => ({
    gh: selectAuthService(snapshot, "gh"),
    agents: AGENT_SERVICES.map((id) => selectAuthService(snapshot, id)).filter(
      (service): service is NonNullable<typeof service> => service !== null
    ),
    openrouter: selectAuthService(snapshot, "openrouter"),
  }), [snapshot])

  if (!open || !socket) return null

  const goBack = () => setStep(steps[Math.max(0, stepIndex - 1)])
  const goNext = () => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)])

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-background animate-in fade-in duration-300">
      {/* Low-emphasis escape hatch — suppresses auto-launch, keeps the Setup card. */}
      <button
        type="button"
        onClick={dismissSetupWizard}
        className="absolute right-4 top-4 z-10 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        Set up later
      </button>

      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-10 pt-14 sm:pt-20">
        {/* Logo + progress — hidden on the final step, which stands alone. */}
        {step !== "done" ? (
          <div className="mb-10 flex flex-col items-center gap-5">
            <Flower className="h-7 w-7 text-logo" />
            <div className="h-1 w-44 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-logo transition-[width] duration-500 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <div key={step} className="flex flex-1 flex-col animate-in fade-in slide-in-from-bottom-2 duration-300">
          {step === "github" ? (
            <>
              <StepHeading
                title="Connect GitHub"
                description="Clone repos, publish projects, and open pull requests without leaving Kanna."
              />
              <div className="mt-8 space-y-3">
                {services.gh ? <AuthCard service={services.gh} socket={socket} /> : null}
              </div>
              <StepFooter
                canContinue={status.githubConnected}
                onContinue={goNext}
                onSkip={!status.githubConnected ? goNext : undefined}
              />
            </>
          ) : null}

          {step === "agents" ? (
            <>
              <StepHeading
                title="Connect your coding agents"
                description="Kanna drives the agents you already use. Connect at least one — you can add the rest anytime."
              />
              <div className="mt-8 space-y-3">
                {services.agents.map((service) => (
                  <AuthCard
                    key={service.service}
                    service={service}
                    socket={socket}
                    badge={AGENT_BADGES[service.service]}
                  />
                ))}
              </div>
              <StepFooter
                canContinue={status.anyAgentConnected}
                onContinue={goNext}
                onBack={goBack}
                hint={!status.anyAgentConnected ? "Connect at least one agent to continue." : undefined}
              />
            </>
          ) : null}

          {step === "openrouter" ? (
            <>
              <StepHeading
                title="Connect OpenRouter"
                description="Powers the Pi harness and extras like chat naming and commit messages. Pay per token — no subscription needed."
              />
              <div className="mt-8 space-y-3">
                {services.openrouter ? <AuthCard service={services.openrouter} socket={socket} /> : null}
              </div>
              <StepFooter
                canContinue={status.openRouterConnected}
                onContinue={goNext}
                onBack={goBack}
                onSkip={!status.openRouterConnected ? goNext : undefined}
              />
            </>
          ) : null}

          {step === "cloud" ? (
            <>
              <StepHeading
                title="Use this machine from anywhere"
                description="Get a personal URL that works from any browser, 100% free. Open the link or scan it with your phone — this machine comes online on its own."
              />
              <div className="mt-8">
                <CloudPairPanel
                  session={cloud.session}
                  starting={cloud.starting}
                  onRetry={cloud.begin}
                />
              </div>
              <StepFooter
                canContinue={machinePaired}
                onContinue={goNext}
                onBack={goBack}
                onSkip={!machinePaired ? goNext : undefined}
              />
            </>
          ) : null}

          {step === "done" ? (
            <>
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
                  <Check className="h-6 w-6 text-emerald-500" />
                </div>
                <StepHeading
                  title="You're all set"
                  description="Kanna is ready. Manage providers anytime in Settings."
                />
              </div>
              <div className="mt-8 space-y-2">
                {(["claude", "codex", "cursor", "gh", "openrouter"] as AuthServiceId[]).map((id) => {
                  const service = selectAuthService(snapshot, id)
                  const connected = service?.authStatus === "signed_in"
                  const Icon = AUTH_SERVICE_ICONS[id]
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-2.5 rounded-2xl border border-border bg-card/40 px-3.5 py-2.5"
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", connected ? "text-foreground" : "text-muted-foreground/50")} />
                      <span className={cn("flex-1 truncate text-sm", connected ? "font-medium text-foreground" : "text-muted-foreground")}>
                        {AUTH_SERVICE_LABELS[id]}
                      </span>
                      {connected ? (
                        <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground/70">Skipped</span>
                      )}
                    </div>
                  )
                })}
                {cloudStepEnabled ? (
                  <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-card/40 px-3.5 py-2.5">
                    <Cloud
                      className={cn(
                        "h-4 w-4 shrink-0",
                        machinePaired ? "text-foreground" : "text-muted-foreground/50"
                      )}
                    />
                    <span
                      className={cn(
                        "flex-1 truncate text-sm",
                        machinePaired ? "font-medium text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {machinePaired && cloud.session.appOrigin
                        ? displayClaimUrl(cloud.session.appOrigin)
                        : "Kanna Cloud"}
                    </span>
                    {machinePaired ? (
                      <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground/70">Skipped</span>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="mt-auto pt-10">
                <Button className="h-11 w-full" onClick={handleComplete}>
                  Start Building
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
