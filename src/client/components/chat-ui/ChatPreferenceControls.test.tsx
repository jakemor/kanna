import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("renders codex-specific controls and can omit plan mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.5"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.5")
    expect(html).toContain("Extra High")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("hides the fast mode toggle for codex models without fast mode support", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.3-codex"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: false }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("GPT-5.3 Codex")
    expect(html).not.toContain("Fast Mode")
  })

  test("renders Ultra as a reasoning level for supported GPT-5.6 models", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.6-sol"
        modelOptions={{ reasoningEffort: "ultra", fastMode: false }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("GPT-5.6 Sol")
    expect(html).toContain("Ultra")
  })

  test("renders Astra with its Codex reasoning and fast-mode controls", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-6-astra"
        modelOptions={{ reasoningEffort: "ultra", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("GPT-6 Astra")
    expect(html).toContain("Ultra")
    expect(html).toContain("Fast Mode")
  })

  test("renders claude plan mode controls when enabled", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="opus"
        modelOptions={{ reasoningEffort: "max", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        mode="plan"
        onModeChange={() => {}}
        includeMode
      />
    )

    expect(html).toContain("Claude")
    expect(html).not.toContain("Claude Code")
    expect(html).toContain("Opus")
    expect(html).toContain("Max")
    expect(html).toContain("1M")
    expect(html).toContain("Plan Mode")
  })

  test("renders Fable as a Claude model option", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="fable"
        modelOptions={{ reasoningEffort: "high", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includeMode={false}
      />
    )

    expect(html).toContain("Fable")
    expect(html).toContain("High")
  })
})
