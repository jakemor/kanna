import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS, type AgentProvider } from "../../../shared/types"
import { deriveComposerOptionControls } from "../../lib/composer"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { ComposerState } from "../../stores/chatPreferencesStore"
import { TooltipProvider } from "../ui/tooltip"
import { describeContextUsage, HarnessMenuBody, HarnessStatusMarks, isContextNearlyFull, rowClick } from "./ComposerHarnessMenu"

function usage(usedTokens: number, maxTokens?: number): ContextWindowSnapshot {
  const usedPercentage = maxTokens ? (usedTokens / maxTokens) * 100 : null
  return {
    usedTokens,
    maxTokens,
    usedPercentage,
    remainingTokens: maxTokens ? maxTokens - usedTokens : null,
    remainingPercentage: usedPercentage === null ? null : 100 - usedPercentage,
    updatedAt: new Date(0).toISOString(),
  }
}

function renderMenu(args: {
  provider: AgentProvider
  model: string
  modelOptions?: Record<string, unknown>
  planMode?: boolean
  unauthenticated?: AgentProvider[]
  contextWindow?: ContextWindowSnapshot | null
}) {
  const providerConfig = PROVIDERS.find((provider) => provider.id === args.provider)!
  const modelOptions = (args.modelOptions ?? {}) as ComposerState["modelOptions"]
  const controls = deriveComposerOptionControls(
    { provider: args.provider, model: args.model, modelOptions, planMode: args.planMode ?? false, autoPlan: false } as ComposerState,
    providerConfig,
  )
  return renderToStaticMarkup(
    <TooltipProvider>
    <HarnessMenuBody
      providers={PROVIDERS}
      unauthenticated={new Set(args.unauthenticated ?? [])}
      selectedProvider={args.provider}
      providerConfig={providerConfig}
      providerSwitchPending={false}
      model={args.model}
      modelOptions={modelOptions}
      reasoning={controls.reasoning}
      fastMode={controls.fastMode}
      mode={controls.mode}
      contextWindow={args.contextWindow ?? null}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      onReasoningChange={() => {}}
      onFastModeChange={() => {}}
      onModeChange={() => {}}
    />
    </TooltipProvider>
  )
}

/** The segment for a harness: its button, named by the hidden label inside it. */
function segment(html: string, label: string) {
  const end = html.indexOf(`<span class="sr-only">${label}</span>`)
  return html.slice(html.lastIndexOf("<button", end), end)
}

describe("HarnessMenuBody", () => {
  test("lists every harness, then model and effort as pop-ups and fast mode as a switch", () => {
    const html = renderMenu({ provider: "claude", model: "opus", modelOptions: { reasoningEffort: "high", fastMode: true } })

    // A segmented control, one icon per harness, the current one pressed.
    for (const provider of PROVIDERS) expect(html).toContain(`<span class="sr-only">${provider.label}</span>`)
    expect(segment(html, "Claude Code")).toContain('aria-pressed="true"')
    expect(segment(html, "Codex")).toContain('aria-pressed="false"')
    // Borderless and edge to edge: no track, no outline.
    expect(html).not.toContain("rounded-lg border border-border p-[3px]")
    // The models are one picker now, not a list of rows, and no harness label heads them.
    expect(html).toContain('aria-label="Model"')
    expect(html).not.toContain('text-muted-foreground">Claude Code')
    expect(html).toContain('aria-label="Effort"')
    expect(html).toContain('role="switch" aria-checked="true" aria-label="Fast Mode"')
  })

  test("drops the switch for a model without fast mode, and effort for a harness without it", () => {
    expect(renderMenu({ provider: "claude", model: "sonnet", modelOptions: { reasoningEffort: "high" } })).not.toContain('role="switch"')
    const cursor = renderMenu({ provider: "cursor", model: "composer-2.5", modelOptions: { fastMode: false } })
    expect(cursor).not.toContain('aria-label="Effort"')
    expect(cursor).toContain('role="switch" aria-checked="false" aria-label="Fast"')
  })

  test("runs Model, Effort, Mode, then Fast Mode last, then the context line", () => {
    const html = renderMenu({
      provider: "claude",
      model: "opus",
      modelOptions: { reasoningEffort: "high", fastMode: false },
      planMode: true,
      contextWindow: usage(86_000, 200_000),
    })
    const order = ['aria-label="Model"', 'aria-label="Effort"', 'aria-label="Mode"', 'role="switch"', "context used"].map((needle) => html.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Settings' borderless accessory, not a boxed select.
    expect(html).not.toContain("rounded-lg border border-border bg-background px-3")
    expect(renderMenu({ provider: "pi", model: PROVIDERS.find((provider) => provider.id === "pi")!.defaultModel })).not.toContain('aria-label="Mode"')
  })

  test("sinks a signed-out harness to the end of the strip and says so", () => {
    const html = renderMenu({ provider: "claude", model: "opus", unauthenticated: ["codex"] })

    expect(html).toContain('<span class="sr-only">Codex · Sign In</span>')
    expect(html.indexOf("Codex · Sign In")).toBeGreaterThan(html.indexOf('<span class="sr-only">Pi</span>'))
  })

  test("ends with the context meter: text, then a ring in Kanna's colour at every level", () => {
    const calm = renderMenu({ provider: "claude", model: "opus", contextWindow: usage(178_000, 200_000) })
    expect(calm).toContain("89% context used · 178k of 200k")
    expect(calm).toContain("<circle")
    expect(calm).toContain("text-logo")
    expect(calm).not.toContain("text-amber-500")
    const full = renderMenu({ provider: "claude", model: "opus", contextWindow: usage(180_000, 200_000) })
    expect(full).toContain("text-logo")
    expect(full).not.toContain("text-amber-500")
    expect(renderMenu({ provider: "claude", model: "opus" })).not.toContain("context used")
  })
})

describe("context usage", () => {
  test("warns from 90%", () => {
    expect(isContextNearlyFull(usage(90_000, 100_000))).toBe(true)
    expect(isContextNearlyFull(usage(89_000, 100_000))).toBe(false)
    expect(isContextNearlyFull(usage(90_000))).toBe(false)
    expect(isContextNearlyFull(null)).toBe(false)
  })

  test("says the raw count when the harness gave no ceiling", () => {
    expect(describeContextUsage(usage(12_500))).toBe("13k tokens used so far")
    expect(describeContextUsage(usage(6_000, 1_000_000))).toBe("0.6% context used · 6k of 1m")
  })
})

describe("rowClick", () => {
  // Stand-ins for the row and what was clicked: `contains` is the row's DOM,
  // `closest` the clicked element's ancestry.
  const row = (inside: boolean) => ({ contains: () => inside })
  const target = (onControl: boolean) => ({ closest: () => (onControl ? {} : null) })

  test("a click on the row opens its picker", () => {
    let opened = 0
    rowClick({ currentTarget: row(true), target: target(false) }, () => { opened += 1 })
    expect(opened).toBe(1)
  })

  test("a click in the picker's portalled panel does not reopen it", () => {
    let opened = 0
    rowClick({ currentTarget: row(false), target: target(false) }, () => { opened += 1 })
    expect(opened).toBe(0)
  })

  test("the Fast row toggles from anywhere, and once when the switch itself is clicked", () => {
    let toggles = 0
    rowClick({ currentTarget: row(true), target: target(false) }, () => { toggles += 1 }, '[role="switch"]')
    expect(toggles).toBe(1)
    // On the switch, its own handler flips it; the row leaves it alone.
    rowClick({ currentTarget: row(true), target: target(true) }, () => { toggles += 1 }, '[role="switch"]')
    expect(toggles).toBe(1)
  })
})

describe("HarnessStatusMarks", () => {
  const marks = (contextPercent: number | null, staged: boolean) =>
    renderToStaticMarkup(<HarnessStatusMarks provider="claude" contextPercent={contextPercent} staged={staged} />)

  test("no badge below 90% of the context window, a plain dot in Kanna's colour from 90%", () => {
    expect(marks(89, false)).not.toContain("data-badge")
    const full = marks(90, false)
    expect(full).toMatch(/data-badge="context" class="[^"]*h-2 w-2 rounded-full bg-logo/)
    expect(full).not.toContain("<circle")
    expect(full).not.toContain('data-badge="staged"')
  })

  test("a staged switch is an amber dot, and the mark keeps its own colour", () => {
    const html = marks(40, true)
    expect(html).toContain('data-badge="staged"')
    expect(html).toContain("bg-amber-500")
    expect(html).not.toContain("text-amber")
    expect(html).toContain("h-4 w-4 text-foreground")
    expect(html).not.toContain('data-badge="context"')
  })

  test("both at once: the context dot keeps the top right, the amber dot moves to the top left", () => {
    const html = marks(95, true)
    expect(html).toMatch(/data-badge="context" class="[^"]*-right-1 /)
    expect(html).toMatch(/data-badge="staged" class="[^"]*-left-1/)
  })
})
