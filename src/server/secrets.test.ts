import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { HarnessTurn } from "./harness-types"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import type { KannaToolHost } from "./kanna-tools"
import { KANNA_TOOL_DESCRIPTION_LIMIT } from "./kanna-tools"
import { LIST_SECRETS_TOOL, REQUEST_SECRETS_TOOL } from "./kanna-secret-tools"
import {
  EncryptedFileSecretStore,
  KeychainSecretStore,
  LibsecretSecretStore,
  MemorySecretStore,
  parseSecurityPassword,
  type CommandRunner,
} from "./secret-store"
import { runSecretCli, type SecretCliDeps } from "./secret-cli"
import { SecretsService, buildSecretsList, resolveSecretsProject } from "./secrets"

// Values no test would write by accident, to search every written byte for.
const CLIENT_ID = "ID-7f3a91c0-canary.apps.googleusercontent.com"
const CLIENT_SECRET = "GOCSPX-zz9-canary-secret-Q4u8"

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kanna-secrets-")) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out")
    await Bun.sleep(5)
  }
}

async function everyFile(root: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...await everyFile(full))
    else found.push(full)
  }
  return found
}

/** A coordinator over a real store, with a codex stand-in that hands out the Kanna tool host. */
async function harness(store = new MemorySecretStore()) {
  const dataDir = path.join(dir, "data")
  const eventStore = new EventStore(dataDir)
  await eventStore.initialize()
  const projectDir = path.join(dir, "project")
  await mkdir(projectDir, { recursive: true })
  const project = await eventStore.openProject(projectDir, "Secrets")
  const chat = await eventStore.createChat(project.id)
  let host: KannaToolHost | undefined
  let closeStream!: () => void
  const manager = {
    async startSession(args: { customTools?: KannaToolHost }) { host ??= args.customTools },
    async startTurn(args: { customTools?: KannaToolHost }): Promise<HarnessTurn> {
      host ??= args.customTools
      const stream = (async function* () {
        await new Promise<void>((resolve) => { closeStream = resolve })
      })()
      return { provider: "codex", stream, interrupt: async () => closeStream(), close: () => closeStream() }
    },
  }
  const secrets = new SecretsService({ dataDir, store })
  const coordinator = new AgentCoordinator({
    store: eventStore,
    secrets,
    onStateChange: () => {},
    codexManager: manager as never,
    generateTitle: async () => ({ title: "Secrets", usedFallback: false, failureMessage: null }),
  })
  await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "codex", content: "Set up Google sign-in", model: "gpt-5.4" })
  await waitFor(() => host !== undefined)
  return { dataDir, eventStore, project, chat, coordinator, secrets, store, host: host!, stop: () => coordinator.cancel(chat.id) }
}

const REQUEST = {
  reason: "To create the Google OAuth app for sign-in.",
  fields: [
    { key: "GOOGLE_CLIENT_ID", label: "Client ID", secret: false },
    { key: "GOOGLE_CLIENT_SECRET", label: "Client secret" },
    { key: "GOOGLE_PROJECT", optional: true },
  ],
}

describe("request_secrets round trip", () => {
  test("the user's values reach the store and the model sees names only", async () => {
    const h = await harness()
    try {
      const call = h.host.execute("request_secrets", REQUEST)
      await waitFor(() => h.coordinator.getPendingTool(h.chat.id)?.toolKind === "request_secrets")
      const pending = h.coordinator.getPendingTool(h.chat.id)!
      expect(pending.preview).toBe(REQUEST.reason)
      expect(h.coordinator.getActiveStatuses().get(h.chat.id)).toBe("waiting_for_user")

      // The generic answer path can't carry values into the tool.
      await expect(h.coordinator.respondTool({
        type: "chat.respondTool", chatId: h.chat.id, toolUseId: pending.toolUseId,
        result: { saved: [CLIENT_SECRET], skipped: [] },
      })).rejects.toThrow("secrets.submit")

      const ack = await h.coordinator.submitSecrets({
        type: "secrets.submit", chatId: h.chat.id, toolUseId: pending.toolUseId,
        values: { GOOGLE_CLIENT_ID: `  ${CLIENT_ID}\n`, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_PROJECT: "" },
      })
      expect(ack).toEqual({ saved: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], skipped: ["GOOGLE_PROJECT"] })

      const result = await call
      expect(result.isError).not.toBe(true)
      const text = result.content.map((block) => block.text).join("")
      const reply = JSON.parse(text)
      expect(reply).toMatchObject({ saved: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], skipped: ["GOOGLE_PROJECT"] })
      expect(reply.use).toContain("secret exec GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET -- ")
      expect(JSON.stringify(result)).not.toContain(CLIENT_ID)
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET)

      expect(h.store.values.get(`${h.project.id}:GOOGLE_CLIENT_ID`)).toBe(CLIENT_ID)
      expect(h.store.values.get(`${h.project.id}:GOOGLE_CLIENT_SECRET`)).toBe(CLIENT_SECRET)
      expect(h.coordinator.getPendingTool(h.chat.id)).toBeNull()

      const messages = h.eventStore.getMessages(h.chat.id)
      const callEntry = messages.find((entry) => entry.kind === "tool_call")
      expect(callEntry).toMatchObject({ tool: { toolKind: "request_secrets", toolName: "request_secrets", input: { reason: REQUEST.reason } } })
      const resultEntry = messages.find((entry) => entry.kind === "tool_result")
      expect(resultEntry).toMatchObject({ content: { saved: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], skipped: ["GOOGLE_PROJECT"] } })
      // The answered card is drawn from the header: its result is not trimmed to the sidecar.
      const wire = h.eventStore.getClientTranscript(h.chat.id).messages
      expect(wire.find((entry) => entry.kind === "tool_result")).toMatchObject({ content: { saved: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] } })

      // Nothing the store wrote, sent or exports holds a value: transcript,
      // payload sidecar, logs, snapshot, the secrets index.
      await h.eventStore.compact()
      const files = await everyFile(h.dataDir)
      expect(files.some((file) => file.endsWith(".payloads.jsonl") || file.endsWith(".jsonl"))).toBe(true)
      expect(files.some((file) => file.endsWith("secrets.json"))).toBe(true)
      for (const file of files) {
        const bytes = await readFile(file, "utf8")
        expect(`${file}: ${bytes.includes(CLIENT_ID)}`).toBe(`${file}: false`)
        expect(`${file}: ${bytes.includes(CLIENT_SECRET)}`).toBe(`${file}: false`)
      }
      for (const blob of [JSON.stringify(messages), JSON.stringify(wire)]) {
        expect(blob).not.toContain(CLIENT_ID)
        expect(blob).not.toContain(CLIENT_SECRET)
      }
    } finally {
      await h.stop()
    }
  })

  test("cancel saves nothing and tells the model", async () => {
    const h = await harness()
    try {
      const call = h.host.execute("request_secrets", REQUEST)
      await waitFor(() => h.coordinator.getPendingTool(h.chat.id) !== null)
      const { toolUseId } = h.coordinator.getPendingTool(h.chat.id)!
      await h.coordinator.submitSecrets({ type: "secrets.submit", chatId: h.chat.id, toolUseId, values: { GOOGLE_CLIENT_SECRET: CLIENT_SECRET }, cancel: true })
      const reply = JSON.parse((await call).content[0]!.text)
      expect(reply).toEqual({ saved: [], skipped: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PROJECT"], cancelled: true })
      expect(h.store.values.size).toBe(0)
      expect(await h.secrets.listAll()).toEqual([])
    } finally {
      await h.stop()
    }
  })

  test("a missing required value is refused, stores nothing, and leaves the form open", async () => {
    const h = await harness()
    try {
      const call = h.host.execute("request_secrets", REQUEST)
      await waitFor(() => h.coordinator.getPendingTool(h.chat.id) !== null)
      const { toolUseId } = h.coordinator.getPendingTool(h.chat.id)!
      const submit = (values: Record<string, string>) => h.coordinator.submitSecrets({ type: "secrets.submit", chatId: h.chat.id, toolUseId, values })
      await expect(submit({ GOOGLE_CLIENT_ID: CLIENT_ID })).rejects.toThrow("GOOGLE_CLIENT_SECRET is required")
      await expect(submit({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "x", OTHER: "y" })).rejects.toThrow("Unknown secret OTHER")
      expect(h.store.values.size).toBe(0)
      expect(h.coordinator.getPendingTool(h.chat.id)?.toolUseId).toBe(toolUseId)
      await submit({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET })
      expect(JSON.parse((await call).content[0]!.text).saved).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])
    } finally {
      await h.stop()
    }
  })

  test("stopping the chat while the form is open records it as discarded", async () => {
    const h = await harness()
    const call = h.host.execute("request_secrets", REQUEST)
    await waitFor(() => h.coordinator.getPendingTool(h.chat.id) !== null)
    await h.stop()
    expect(await call).toMatchObject({ isError: true })
    expect(h.eventStore.getMessages(h.chat.id).find((entry) => entry.kind === "tool_result")).toMatchObject({ content: { discarded: true } })
  })

  test("bad requests are refused before the user sees a form", async () => {
    const h = await harness()
    try {
      for (const input of [
        { reason: "x", fields: [] },
        { reason: "x", fields: [{ key: "lower_case" }] },
        { reason: "x", fields: [{ key: "A" }, { key: "A" }] },
        { reason: "", fields: [{ key: "A" }] },
      ]) {
        expect(await h.host.execute("request_secrets", input)).toMatchObject({ isError: true })
      }
      expect(h.coordinator.getPendingTool(h.chat.id)).toBeNull()
    } finally {
      await h.stop()
    }
  })

  test("list_secrets names what the project has", async () => {
    const h = await harness()
    try {
      await h.secrets.set({ id: h.project.id, localPath: h.project.localPath }, "STRIPE_KEY", CLIENT_SECRET)
      const result = await h.host.execute("list_secrets", {})
      const reply = JSON.parse(result.content[0]!.text)
      expect(reply.secrets.map((secret: { key: string }) => secret.key)).toEqual(["STRIPE_KEY"])
      expect(reply.use).toContain("secret exec STRIPE_KEY -- ")
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET)
    } finally {
      await h.stop()
    }
  })
})

describe("tool descriptions", () => {
  test("fit in what Claude Code shows of one", () => {
    for (const tool of [REQUEST_SECRETS_TOOL, LIST_SECRETS_TOOL]) {
      expect(tool.description.length).toBeLessThanOrEqual(KANNA_TOOL_DESCRIPTION_LIMIT)
    }
    expect(REQUEST_SECRETS_TOOL.description).toContain("kanna secret exec")
    expect(REQUEST_SECRETS_TOOL.description).toContain("never visible to you")
    expect(REQUEST_SECRETS_TOOL.description).toContain("Never try to print")
  })
})

describe("settings commands", () => {
  test("set, list and delete, by project, with the chat that saved each", async () => {
    const h = await harness()
    try {
      const other = await h.eventStore.openProject(path.join(dir, "other"), "Other")
      await h.secrets.set({ id: h.project.id, localPath: h.project.localPath }, "B_KEY", "b", { chatId: h.chat.id })
      await h.secrets.set({ id: h.project.id, localPath: h.project.localPath }, "A_KEY", "a")
      await h.secrets.set({ id: other.id, localPath: other.localPath }, "A_KEY", "other")
      let list = await buildSecretsList(h.secrets, h.eventStore)
      expect(list.projects.map((project) => [project.title, project.secrets.map((secret) => secret.key)])).toEqual([
        ["Other", ["A_KEY"]],
        ["Secrets", ["A_KEY", "B_KEY"]],
      ])
      const saved = list.projects[1]!.secrets[1]!
      expect(saved).toMatchObject({ key: "B_KEY", chatId: h.chat.id })
      expect(typeof saved.savedAt).toBe("number")
      expect(JSON.stringify(list)).not.toMatch(/"(a|b|other)"/)

      await h.secrets.set({ id: h.project.id, localPath: h.project.localPath }, "A_KEY", "replaced")
      expect(await h.store.get(h.project.id, "A_KEY")).toBe("replaced")
      await h.secrets.delete(other.id, "A_KEY")
      list = await buildSecretsList(h.secrets, h.eventStore)
      expect(list.projects.map((project) => project.title)).toEqual(["Secrets"])
      expect(await h.store.get(other.id, "A_KEY")).toBeNull()
      await expect(h.secrets.set({ id: h.project.id, localPath: h.project.localPath }, "bad key", "x")).rejects.toThrow("Invalid secret name")
    } finally {
      await h.stop()
    }
  })
})

describe("kanna secret", () => {
  async function cli(argv: string[], options: { cwd: string; service: SecretsService; env?: Record<string, string> }) {
    let stdout = ""
    let stderr = ""
    const runs: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = []
    const deps: SecretCliDeps = {
      cwd: options.cwd,
      env: options.env ?? { PATH: "/usr/bin" },
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
      service: options.service,
      run: async (command, args, env) => {
        runs.push({ command, args, env })
        return 3
      },
    }
    const code = await runSecretCli(argv, deps)
    return { code, stdout, stderr, runs }
  }

  async function twoProjects() {
    const store = new MemorySecretStore()
    const service = new SecretsService({ dataDir: dir, store })
    const one = path.join(dir, "one")
    const two = path.join(dir, "two")
    await mkdir(path.join(one, "src"), { recursive: true })
    await mkdir(two, { recursive: true })
    await service.set({ id: "project-one", localPath: one }, "API_KEY", CLIENT_SECRET)
    await service.set({ id: "project-two", localPath: two }, "OTHER_KEY", CLIENT_ID)
    return { service, one, two }
  }

  test("exec puts the values in the child's environment, passes its exit code, and prints none", async () => {
    const { service, one } = await twoProjects()
    const result = await cli(["exec", "API_KEY", "--", "node", "deploy.js", "--prod"], { cwd: path.join(one, "src"), service })
    expect(result.code).toBe(3)
    expect(result.runs).toEqual([{ command: "node", args: ["deploy.js", "--prod"], env: { PATH: "/usr/bin", API_KEY: CLIENT_SECRET } }])
    expect(result.stdout + result.stderr).not.toContain(CLIENT_SECRET)
  })

  test("exec runs a real child with the variable set and its code passed through", async () => {
    const { service, one } = await twoProjects()
    const { runInherited } = await import("./secret-cli")
    const out = path.join(dir, "out.txt")
    const code = await runSecretCli(["exec", "API_KEY", "--", "sh", "-c", `printf %s "$API_KEY" > ${JSON.stringify(out)}; exit 7`], {
      cwd: one, env: { PATH: process.env.PATH }, stdout: () => {}, stderr: () => {}, service, run: runInherited,
    })
    expect(code).toBe(7)
    expect(await readFile(out, "utf8")).toBe(CLIENT_SECRET)
  })

  test("a project reaches only its own secrets", async () => {
    const { service, one, two } = await twoProjects()
    const fromOne = await cli(["exec", "OTHER_KEY", "--", "true"], { cwd: one, service })
    expect(fromOne.code).toBe(1)
    expect(fromOne.runs).toEqual([])
    expect(fromOne.stderr).toContain("No secret named OTHER_KEY in this project")
    const fromTwo = await cli(["exec", "OTHER_KEY", "--", "true"], { cwd: two, service })
    expect(fromTwo.runs[0]!.env.OTHER_KEY).toBe(CLIENT_ID)
    expect(fromTwo.runs[0]!.env.API_KEY).toBeUndefined()
    const outside = await cli(["exec", "API_KEY", "--", "true"], { cwd: dir, service })
    expect(outside.code).toBe(1)
    expect(outside.runs).toEqual([])
    expect(resolveSecretsProject([{ projectId: "p", localPath: one }], `${one}-sibling`)).toBeNull()
  })

  test("list names the secrets and never their values", async () => {
    const { service, one } = await twoProjects()
    const text = await cli(["list"], { cwd: one, service })
    expect(text.code).toBe(0)
    expect(text.stdout).toMatch(/^API_KEY\tsaved \d{4}-/)
    expect(text.stdout).not.toContain(CLIENT_SECRET)
    const json = JSON.parse((await cli(["list", "--json"], { cwd: one, service })).stdout)
    expect(json).toMatchObject({ projectId: "project-one", secrets: [{ key: "API_KEY" }] })
    expect(JSON.stringify(json)).not.toContain(CLIENT_SECRET)
  })

  test("usage errors", async () => {
    const { service, one } = await twoProjects()
    expect((await cli(["exec", "API_KEY", "true"], { cwd: one, service })).code).toBe(2)
    expect((await cli(["exec", "--", "true"], { cwd: one, service })).code).toBe(2)
    expect((await cli(["exec", "api_key", "--", "true"], { cwd: one, service })).code).toBe(2)
    expect((await cli(["exec", "API_KEY", "--"], { cwd: one, service })).code).toBe(2)
    expect((await cli(["nope"], { cwd: one, service })).code).toBe(2)
  })
})

describe("keychain store", () => {
  function fakeSecurity() {
    const items = new Map<string, { data: Buffer; comment?: string }>()
    const calls: Array<{ args: string[]; stdin?: string }> = []
    const run: CommandRunner = async (command, args, stdin) => {
      expect(command).toBe("security")
      calls.push({ args, stdin })
      const flag = (list: string[], name: string) => list[list.indexOf(name) + 1]!
      if (args[0] === "-i") {
        for (const line of (stdin ?? "").trim().split("\n")) {
          const match = /^add-generic-password -U -a "([^"]+)" -s "([^"]+)"(?: -j "([^"]+)")? -X ([0-9a-f]+)$/.exec(line)
          if (!match) return { code: 1, stdout: "", stderr: "bad line" }
          items.set(match[2]!, { data: Buffer.from(match[4]!, "hex"), comment: match[3] })
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const service = flag(args, "-s")
      const item = items.get(service)
      if (args[0] === "find-generic-password") {
        if (!item) return { code: 44, stdout: "", stderr: "not found" }
        const printable = /^[\x20-\x5b\x5d-\x7e]*$/.test(item.data.toString("latin1"))
        const password = printable ? `"${item.data.toString("utf8")}"` : `0x${item.data.toString("hex").toUpperCase()}  "..."`
        return { code: 0, stdout: `    "icmt"<blob>=${item.comment ? `"${item.comment}"` : "<NULL>"}\n`, stderr: `password: ${password}\n` }
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(service) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" }
      }
      throw new Error(`unexpected ${args[0]}`)
    }
    return { items, calls, run }
  }

  test("values go to security on stdin as hex, never in argv", async () => {
    const security = fakeSecurity()
    const store = new KeychainSecretStore({ servicePrefix: "kanna-test", run: security.run })
    await store.set("project-1", "API_KEY", CLIENT_SECRET)
    for (const call of security.calls) expect(call.args.join(" ")).not.toContain(CLIENT_SECRET)
    const write = security.calls.find((call) => call.args[0] === "-i")!
    expect(write.stdin).not.toContain(CLIENT_SECRET)
    expect(write.stdin).toContain(Buffer.from(CLIENT_SECRET).toString("hex"))
    expect([...security.items.keys()]).toEqual(["kanna-test:project-1:API_KEY"])
    expect(await store.get("project-1", "API_KEY")).toBe(CLIENT_SECRET)
    expect(await store.get("project-1", "MISSING")).toBeNull()
  })

  test("long, multi-line and quoted values survive, chunked past the line limit", async () => {
    const security = fakeSecurity()
    const store = new KeychainSecretStore({ run: security.run })
    const pem = `-----BEGIN PRIVATE KEY-----\n${"QUJD\\\"".repeat(1000)}\n-----END PRIVATE KEY-----\n`
    await store.set("project-1", "PEM", pem)
    expect(security.items.size).toBe(Math.ceil(Buffer.byteLength(pem) / 1800))
    for (const call of security.calls) expect((call.stdin ?? "").split("\n").every((line) => line.length < 4000)).toBe(true)
    expect(await store.get("project-1", "PEM")).toBe(pem)
    // Shorter again: the old chunks go.
    await store.set("project-1", "PEM", "short \"quoted\" é")
    expect([...security.items.keys()]).toEqual(["kanna:project-1:PEM"])
    expect(await store.get("project-1", "PEM")).toBe("short \"quoted\" é")
    await store.delete("project-1", "PEM")
    expect(security.items.size).toBe(0)
  })

  test("parses both forms security prints", () => {
    expect(parseSecurityPassword("password: \"abc\"def\"\n").toString()).toBe("abc\"def")
    expect(parseSecurityPassword("password: 0x6C690A6E65  \"li\\012ne\"\n").toString()).toBe("li\nne")
    expect(parseSecurityPassword("password: \n").toString()).toBe("")
  })

  test("refuses names that could break out of a security line", async () => {
    const store = new KeychainSecretStore({ run: fakeSecurity().run })
    await expect(store.set("x\" -s \"y", "API_KEY", "v")).rejects.toThrow("Invalid project id")
    await expect(store.set("project-1", "API_KEY\"", "v")).rejects.toThrow("Invalid secret key")
  })
})

describe("libsecret store", () => {
  test("stores through stdin and looks up through stdout", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = []
    const values = new Map<string, string>()
    const store = new LibsecretSecretStore({
      run: async (command, args, stdin) => {
        expect(command).toBe("secret-tool")
        calls.push({ args, stdin })
        const service = args[args.indexOf("service") + 1]!
        if (args[0] === "store") { values.set(service, stdin ?? ""); return { code: 0, stdout: "", stderr: "" } }
        if (args[0] === "lookup") return values.has(service) ? { code: 0, stdout: values.get(service)!, stderr: "" } : { code: 1, stdout: "", stderr: "" }
        values.delete(service)
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    await store.set("project-1", "API_KEY", CLIENT_SECRET)
    expect(calls[0]!.args.join(" ")).not.toContain(CLIENT_SECRET)
    expect(calls[0]!.stdin).toBe(CLIENT_SECRET)
    expect(await store.get("project-1", "API_KEY")).toBe(CLIENT_SECRET)
    await store.delete("project-1", "API_KEY")
    expect(await store.get("project-1", "API_KEY")).toBeNull()
  })
})

describe("encrypted file store", () => {
  test("round trips, keeps files private, and holds no plaintext", async () => {
    const secretsDir = path.join(dir, "secrets")
    const store = new EncryptedFileSecretStore(secretsDir)
    const multiLine = `${CLIENT_SECRET}\nline two ✓`
    await store.set("project-1", "API_KEY", multiLine)
    await store.set("project-2", "API_KEY", "two")
    expect(await new EncryptedFileSecretStore(secretsDir).get("project-1", "API_KEY")).toBe(multiLine)
    expect(await store.get("project-2", "API_KEY")).toBe("two")
    expect(await store.get("project-1", "OTHER")).toBeNull()
    for (const file of ["key", "store.json"]) {
      expect((await stat(path.join(secretsDir, file))).mode & 0o777).toBe(0o600)
    }
    expect((await stat(secretsDir)).mode & 0o777).toBe(0o700)
    expect(await readFile(path.join(secretsDir, "store.json"), "utf8")).not.toContain(CLIENT_SECRET)

    // An entry moved to another project's slot fails to decrypt.
    const file = JSON.parse(await readFile(path.join(secretsDir, "store.json"), "utf8"))
    file.entries["project-2:API_KEY"] = file.entries["project-1:API_KEY"]
    await Bun.write(path.join(secretsDir, "store.json"), JSON.stringify(file))
    await expect(store.get("project-2", "API_KEY")).rejects.toThrow()

    await store.delete("project-1", "API_KEY")
    expect(await store.get("project-1", "API_KEY")).toBeNull()
  })
})
