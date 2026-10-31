import { describe, expect, test } from "bun:test"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedRequestSecretsToolCall } from "../../../shared/types"
import { hydrateToolResult, normalizeToolCall } from "../../../shared/tools"
import { secretStorageNote } from "../../lib/secret-storage"
import { TooltipProvider } from "../ui/tooltip"
import { TranscriptRenderOptionsProvider, type TranscriptRenderOptions } from "./render-context"
import { RequestSecretsMessage } from "./RequestSecretsMessage"

const REASON = "To create the Google OAuth app."

function call(result?: unknown): HydratedRequestSecretsToolCall {
  const tool = normalizeToolCall({
    toolName: "request_secrets",
    toolId: "kanna-1",
    input: {
      reason: REASON,
      fields: [
        { key: "GOOGLE_CLIENT_ID", label: "Client ID", secret: false },
        { key: "GOOGLE_CLIENT_SECRET", label: "Client secret", description: "Shown once, on the Credentials page" },
        // As a model wrote one: "Optional" in its own description.
        { key: "GOOGLE_DOMAIN", label: "Workspace domain", description: "Optional. Who may sign in", secret: false, optional: true },
      ],
    },
  })
  return {
    ...tool,
    id: "entry-1",
    kind: "tool",
    timestamp: new Date(0).toISOString(),
    ...(result === undefined ? {} : { result: hydrateToolResult(tool, result) }),
  } as HydratedRequestSecretsToolCall
}

const live: Partial<TranscriptRenderOptions> = {
  submitSecrets: async () => ({ saved: [], skipped: [] }),
  loadSecretBackend: async () => "keychain",
}

function render(node: ReactNode, options: Partial<TranscriptRenderOptions> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TranscriptRenderOptionsProvider value={options}>{node}</TranscriptRenderOptionsProvider>
    </TooltipProvider>
  )
}

/** The markup with tags stripped, for what a reader sees. */
function text(html: string) {
  return html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'")
}

describe("RequestSecretsMessage, open", () => {
  const html = render(<RequestSecretsMessage message={call()} isWaiting />, live)

  test("the reason is the title, and each field is one row: key, then the input", () => {
    expect(html).toMatch(/<h3 [^>]*>To create the Google OAuth app\.<\/h3>/)
    // No separate human-label line: the key is the row's label.
    expect(html).toMatch(/<label for="[^"]+-GOOGLE_CLIENT_SECRET"[^>]*><span[^>]*>GOOGLE_CLIENT_SECRET<\/span><span[^>]*>\*<\/span><\/label><input/)
    expect(text(html)).not.toContain("Client secret")
  })

  test("the placeholder is the description alone, with nothing added for an optional field", () => {
    expect(html).toContain('placeholder="Shown once, on the Credentials page"')
    expect(html).toContain('placeholder="Optional. Who may sign in"')
    expect(html).not.toContain("Optional ·")
    // With no description, a neutral hint.
    expect(html).toMatch(/id="[^"]+-GOOGLE_CLIENT_ID"[^>]*placeholder="Enter a value"/)
  })

  test("required fields carry a red * hidden from screen readers, and aria-required on the input", () => {
    const star = /<span aria-hidden="true" class="[^"]*text-destructive[^"]*">\*<\/span>/g
    expect(html.match(star)).toHaveLength(2)
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      expect(html).toMatch(new RegExp(`>${key}</span><span aria-hidden="true"[^>]*>\\*</span></label>`))
      expect(html).toMatch(new RegExp(`id="[^"]+-${key}"[^>]*aria-required="true"`))
    }
    expect(html).toMatch(/>GOOGLE_DOMAIN<\/span><\/label>/)
    expect(html).not.toMatch(/id="[^"]+-GOOGLE_DOMAIN"[^>]*aria-required/)
  })

  test("masked fields are password fields with an eye toggle; plain ones are text", () => {
    expect(html).toMatch(/id="[^"]+-GOOGLE_CLIENT_SECRET" type="password"/)
    expect(html).toMatch(/id="[^"]+-GOOGLE_CLIENT_ID" type="text"/)
    expect(html).toContain('aria-label="Show Client secret" aria-pressed="false"')
    expect(html).not.toContain('aria-label="Show Client ID"')
  })

  test("inputs are named for screen readers and kept from autofill and spellcheck", () => {
    expect(html).toContain('aria-label="Client secret"')
    expect(html).toContain('aria-label="Workspace domain, optional"')
    expect(html).toContain('aria-description="Shown once, on the Credentials page"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('spellCheck="false"')
    expect(html).toContain('data-1p-ignore=""')
    expect(html).toContain('enterKeyHint="next"')
    expect(html).toContain('enterKeyHint="done"')
  })

  test("the last row is the storage line with Cancel and a fixed-width Save", () => {
    expect(text(html)).toContain(secretStorageNote(null))
    expect(html).toMatch(/type="button">Cancel<\/button>/)
    expect(html).toMatch(/class="[^"]*\bw-20\b[^"]*" type="submit" aria-disabled="true"><span[^>]*>Save<\/span>/)
  })
})

describe("RequestSecretsMessage, answered", () => {
  test("saved: one muted line of names, with the skipped ones", () => {
    const html = render(<RequestSecretsMessage message={call({ saved: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], skipped: ["GOOGLE_DOMAIN"] })} isWaiting={false} />)
    expect(text(html)).toBe("Saved GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET · skipped GOOGLE_DOMAIN")
    expect(html).toContain(`aria-description="${REASON}"`)
    expect(html).not.toContain("<input")
    expect(html).not.toContain("<form")
  })

  test("cancelled and stopped name what wasn't saved", () => {
    expect(text(render(<RequestSecretsMessage message={call({ saved: [], skipped: [], cancelled: true })} isWaiting={false} />)))
      .toBe("Cancelled. Didn't save GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DOMAIN")
    expect(text(render(<RequestSecretsMessage message={call({ discarded: true })} isWaiting={false} />)))
      .toBe("Stopped. Didn't save GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DOMAIN")
  })

  test("a turn that ended without an answer, and an export, show no form", () => {
    const ended = render(<RequestSecretsMessage message={call()} isWaiting={false} />, live)
    expect(text(ended)).toStartWith("No longer waiting.")
    expect(ended).not.toContain("<input")
    const exported = render(<RequestSecretsMessage message={call()} isWaiting />, { readonly: true })
    expect(text(exported)).toBe("Asked for GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DOMAIN")
    expect(exported).not.toContain("<input")
  })
})

describe("secretStorageNote", () => {
  test("follows the backend and never claims a Keychain it doesn't have", () => {
    expect(secretStorageNote("keychain")).toContain("Keychain")
    for (const backend of ["libsecret", "file", null] as const) {
      expect(secretStorageNote(backend)).not.toContain("Keychain")
      expect(secretStorageNote(backend)).toContain("The agent sees only the names.")
    }
  })
})
