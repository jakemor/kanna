import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SecretsListResult } from "../../../shared/secrets"
import { AddSecretForm, addSecret, checkNewSecret, normalizeSecretKeyInput } from "./SecretsSection"

const LIST: SecretsListResult = {
  backend: "keychain",
  projects: [{ projectId: "p1", title: "Kanna", localPath: "/k", secrets: [{ key: "STRIPE_KEY", savedAt: 1 }] }],
}

describe("Add Secret", () => {
  test("a typed name becomes an environment-variable name", () => {
    expect(normalizeSecretKeyInput("google client-id")).toBe("GOOGLE_CLIENT_ID")
    expect(normalizeSecretKeyInput("api.key")).toBe("API_KEY")
  })

  test("needs a project, a valid name and a value, and says when it replaces one", () => {
    expect(checkNewSecret({ projectId: "", key: "A", value: "v" }, LIST).problem).toBe("Choose a project")
    expect(checkNewSecret({ projectId: "p1", key: "", value: "v" }, LIST).problem).toBe("Name it")
    expect(checkNewSecret({ projectId: "p1", key: "1BAD", value: "v" }, LIST).problem).toContain("start with a letter")
    expect(checkNewSecret({ projectId: "p1", key: "NEW_KEY", value: "  " }, LIST).problem).toBe("Enter its value")
    expect(checkNewSecret({ projectId: "p1", key: "NEW_KEY", value: "v" }, LIST)).toEqual({ problem: null, replaces: false })
    expect(checkNewSecret({ projectId: "p1", key: "STRIPE_KEY", value: "v" }, LIST)).toEqual({ problem: null, replaces: true })
    expect(checkNewSecret({ projectId: "p2", key: "STRIPE_KEY", value: "v" }, LIST).replaces).toBe(false)
  })

  test("sends one secrets.set and takes the names-only list back", async () => {
    const sent: unknown[] = []
    const reply: SecretsListResult = { ...LIST, projects: [{ ...LIST.projects[0]!, secrets: [...LIST.projects[0]!.secrets, { key: "NEW_KEY", savedAt: 2 }] }] }
    const result = await addSecret(async (command) => {
      sent.push(command)
      return reply
    }, { projectId: "p1", key: "NEW_KEY", value: "sk_live_canary" })
    expect(sent).toEqual([{ type: "secrets.set", projectId: "p1", key: "NEW_KEY", value: "sk_live_canary" }])
    expect(result.projects[0]!.secrets.map((secret) => secret.key)).toEqual(["STRIPE_KEY", "NEW_KEY"])
    expect(JSON.stringify(result)).not.toContain("sk_live_canary")
  })

  test("the form picks a project, takes a name and a masked value", () => {
    const html = renderToStaticMarkup(
      <AddSecretForm
        projects={[{ id: "p1", title: "Kanna" }, { id: "p2", title: "Site" }]}
        list={LIST}
        initialProjectId="p2"
        saving={false}
        onSave={async () => true}
        onCancel={() => {}}
      />
    )
    expect(html).toContain("New Secret")
    // Radix renders the chosen title only in the browser; statically, the labelled picker.
    expect(html).toMatch(/role="combobox"[^>]*aria-label="Project"/)
    expect(html).toContain('aria-label="Name"')
    expect(html).toMatch(/type="password"[^>]*aria-label="value"/)
    expect(html).toContain('aria-label="Show value" aria-pressed="false"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain(">Save<")
    expect(html).toContain(">Cancel<")
  })
})
