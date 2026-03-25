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
        model="gpt-5.3-codex"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onClaudeReasoningEffortChange={() => {}}
        onCodexReasoningEffortChange={() => {}}
        onGeminiThinkingModeChange={() => {}}
        onCodexFastModeChange={() => {}}
        includePlanMode={false}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.3 Codex")
    expect(html).toContain("XHigh")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("renders claude plan mode controls when enabled", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="opus"
        modelOptions={{ reasoningEffort: "max" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onClaudeReasoningEffortChange={() => {}}
        onCodexReasoningEffortChange={() => {}}
        onGeminiThinkingModeChange={() => {}}
        onCodexFastModeChange={() => {}}
        planMode
        onPlanModeChange={() => {}}
        includePlanMode
      />
    )

    expect(html).toContain("Claude")
    expect(html).toContain("Opus")
    expect(html).toContain("Max")
    expect(html).toContain("Plan")
  })

  test("renders gemini-specific thinking controls", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="gemini"
        model="auto-gemini-2.5"
        modelOptions={{ thinkingMode: "high" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onClaudeReasoningEffortChange={() => {}}
        onCodexReasoningEffortChange={() => {}}
        onGeminiThinkingModeChange={() => {}}
        onCodexFastModeChange={() => {}}
        planMode
        onPlanModeChange={() => {}}
        includePlanMode
      />
    )

    expect(html).toContain("Gemini")
    expect(html).toContain("High")
    expect(html).toContain("Plan")
  })
})
