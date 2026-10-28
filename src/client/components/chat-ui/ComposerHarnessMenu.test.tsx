import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS, type AgentProvider } from "../../../shared/types"
import { deriveComposerOptionControls } from "../../lib/composer"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { ComposerState } from "../../stores/chatPreferencesStore"
import { describeContextUsage, HarnessMenuBody, isContextNearlyFull } from "./ComposerHarnessMenu"

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
  )
}

describe("HarnessMenuBody", () => {
  test("lists every harness, the harness's models, effort as a pop-up and fast mode as a switch", () => {
    const html = renderMenu({ provider: "claude", model: "opus", modelOptions: { reasoningEffort: "high", fastMode: true } })

    for (const provider of PROVIDERS) expect(html).toContain(`aria-label="${provider.label}"`)
    expect(html).toContain('role="radio" aria-checked="true" aria-label="Claude Code"')
    // Bare marks: no tile behind any of them, a dot under the current one.
    expect(html).not.toContain("bg-muted text-foreground")
    expect(html.match(/rounded-full bg-foreground/g)).toHaveLength(1)
    for (const model of PROVIDERS.find((provider) => provider.id === "claude")!.models) expect(html).toContain(model.label)
    expect(html).toContain('aria-label="Effort"')
    expect(html).toContain(">High<")
    expect(html).toContain('role="switch" aria-checked="true" aria-label="Fast Mode"')
  })

  test("drops the switch for a model without fast mode, and effort for a harness without it", () => {
    expect(renderMenu({ provider: "claude", model: "sonnet", modelOptions: { reasoningEffort: "high" } })).not.toContain('role="switch"')
    const cursor = renderMenu({ provider: "cursor", model: "composer-2.5", modelOptions: { fastMode: false } })
    expect(cursor).not.toContain('aria-label="Effort"')
    expect(cursor).toContain('role="switch" aria-checked="false" aria-label="Fast"')
  })

  test("offers the mode as a pop-up after fast mode, for a harness that has modes", () => {
    const html = renderMenu({ provider: "claude", model: "opus", modelOptions: { fastMode: false }, planMode: true })

    expect(html).toContain('aria-label="Mode"')
    expect(html).toContain(">Plan Mode<")
    expect(html.indexOf('aria-label="Mode"')).toBeGreaterThan(html.indexOf('role="switch"'))
    expect(renderMenu({ provider: "pi", model: PROVIDERS.find((provider) => provider.id === "pi")!.defaultModel })).not.toContain('aria-label="Mode"')
  })

  test("sinks a signed-out harness to the end of the strip and says so", () => {
    const html = renderMenu({ provider: "claude", model: "opus", unauthenticated: ["codex"] })

    expect(html).toContain('aria-label="Codex · Sign In"')
    expect(html.indexOf("Codex · Sign In")).toBeGreaterThan(html.indexOf('aria-label="Pi"'))
  })

  test("ends with the context meter: text, then a ring that turns amber from 90%", () => {
    const calm = renderMenu({ provider: "claude", model: "opus", contextWindow: usage(178_000, 200_000) })
    expect(calm).toContain("89% context used · 178k of 200k")
    expect(calm).toContain("<circle")
    expect(calm).not.toContain("text-amber-500")
    expect(renderMenu({ provider: "claude", model: "opus", contextWindow: usage(180_000, 200_000) })).toContain("text-amber-500")
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
