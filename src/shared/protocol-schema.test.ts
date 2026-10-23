import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import type { ClientCommand, ClientEnvelope, SubscriptionTopic } from "./protocol"
import { ClientCommandSchema, ClientEnvelopeFromJson, ClientEnvelopeSchema, ClientFrameJsonSchema, CompatibleClientEnvelopeSchema, SubscriptionTopicSchema } from "./protocol-schema"
import type { ChatAttachment, ModelOptions } from "./types"
import { DEFAULT_KEYBINDINGS } from "./types"

// --- The schemas and the protocol types describe the same values ----------
//
// Checked at compile time, both ways: every value the TypeScript union allows
// is one the schema's type allows, and the other way round. The schema's
// arrays and fields are readonly, which says nothing about which values fit,
// so that is set aside before comparing.

type DeepMutable<T> = T extends ReadonlyArray<infer Item>
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T

type Covers<Wide, Narrow> = [Narrow] extends [Wide] ? true : false

const commandTypesCoverSchema: Covers<ClientCommand, DeepMutable<typeof ClientCommandSchema.Type>> = true
const schemaCoversCommandTypes: Covers<DeepMutable<typeof ClientCommandSchema.Type>, ClientCommand> = true
const topicTypesCoverSchema: Covers<SubscriptionTopic, DeepMutable<typeof SubscriptionTopicSchema.Type>> = true
const schemaCoversTopicTypes: Covers<DeepMutable<typeof SubscriptionTopicSchema.Type>, SubscriptionTopic> = true
const envelopeTypesCoverSchema: Covers<ClientEnvelope, DeepMutable<typeof ClientEnvelopeSchema.Type>> = true
const schemaCoversEnvelopeTypes: Covers<DeepMutable<typeof ClientEnvelopeSchema.Type>, ClientEnvelope> = true

test("the schemas' types and the protocol's types are the same set of values", () => {
  expect([
    commandTypesCoverSchema,
    schemaCoversCommandTypes,
    topicTypesCoverSchema,
    schemaCoversTopicTypes,
    envelopeTypesCoverSchema,
    schemaCoversEnvelopeTypes,
  ]).toEqual([true, true, true, true, true, true])
})

// --- Every command decodes -------------------------------------------------

const attachment: ChatAttachment = {
  id: "att-1",
  kind: "image",
  displayName: "shot.png",
  absolutePath: "/tmp/shot.png",
  relativePath: "shot.png",
  contentUrl: "/uploads/shot.png",
  mimeType: "image/png",
  size: 1024,
}

const modelOptions: ModelOptions = {
  claude: { reasoningEffort: "max", contextWindow: "1m", fastMode: true },
  codex: { reasoningEffort: "some-runtime-effort", fastMode: false },
  cursor: { fastMode: true },
  grok: { reasoningEffort: "low" },
  pi: { reasoningEffort: "off" },
}

type CommandSamples = { [Type in ClientCommand["type"]]: [Extract<ClientCommand, { type: Type }>, ...Extract<ClientCommand, { type: Type }>[]] }

/**
 * At least one of every command, keyed by type, so a command added to the
 * union and not here fails to compile. Where a field is optional there is a
 * sample with it and, usually, one without.
 */
const samples: CommandSamples = {
  "project.open": [{ type: "project.open", localPath: "/p" }],
  "project.create": [{ type: "project.create", localPath: "/p" }, { type: "project.create", localPath: "/p", title: "P" }],
  "project.rename": [
    { type: "project.rename", projectId: "p1", title: "P" },
    { type: "project.rename", localPath: "/p", title: "P" },
  ],
  "project.setPinned": [
    { type: "project.setPinned", projectId: "p1", pinned: true },
    { type: "project.setPinned", projectId: "p1", pinned: false, pinnedAt: 1_700_000_000_000 },
  ],
  "project.clone": [
    { type: "project.clone", cloneUrl: "https://x/y.git", localPath: "/p", title: "Y" },
    { type: "project.clone", cloneUrl: "https://x/y.git", localPath: "/p", fallbackPath: "/q", title: "Y" },
  ],
  "github.listRecentRepos": [{ type: "github.listRecentRepos" }],
  "project.remove": [{ type: "project.remove", projectId: "p1" }, { type: "project.remove", localPath: "/p" }],
  "sidebar.reorderProjectGroups": [{ type: "sidebar.reorderProjectGroups", projectIds: ["a", "b"] }, { type: "sidebar.reorderProjectGroups", projectIds: [] }],
  "project.readDiffPatch": [
    { type: "project.readDiffPatch", projectId: "p1", path: "a.ts" },
    { type: "project.readDiffPatch", projectId: "p1", path: "a.ts", fullContext: true },
  ],
  "project.readCommit": [{ type: "project.readCommit", projectId: "p1", sha: "abc123" }],
  "project.readBranch": [
    { type: "project.readBranch", projectId: "p1", branch: { kind: "local", name: "main" } },
    { type: "project.readBranch", projectId: "p1", branch: { kind: "remote", name: "main", remoteRef: "origin/main" } },
    { type: "project.readBranch", projectId: "p1", branch: { kind: "pull_request", name: "pr", prNumber: 4, headRefName: "feat" } },
    {
      type: "project.readBranch",
      projectId: "p1",
      branch: {
        kind: "pull_request",
        name: "pr",
        prNumber: 4,
        headRefName: "feat",
        headRepoCloneUrl: "https://fork/x.git",
        isCrossRepository: true,
        remoteRef: "fork/feat",
      },
    },
  ],
  "project.generateCommitMessage": [{ type: "project.generateCommitMessage", projectId: "p1", paths: ["a.ts"] }],
  "project.commitDiffs": [
    { type: "project.commitDiffs", projectId: "p1", paths: ["a.ts"], summary: "Fix", mode: "commit_only" },
    { type: "project.commitDiffs", projectId: "p1", paths: [], summary: "Fix", description: "Why", mode: "commit_and_push" },
  ],
  "system.ping": [{ type: "system.ping" }],
  "fs.list": [{ type: "fs.list" }, { type: "fs.list", path: "/", nearest: true }],
  "fs.mkdir": [{ type: "fs.mkdir", path: "/new" }],
  "browser.listLocalHttpServers": [{ type: "browser.listLocalHttpServers" }, { type: "browser.listLocalHttpServers", projectId: "p1" }],
  "browser.killLocalHttpServer": [{ type: "browser.killLocalHttpServer", port: 3000 }],
  "browser.exposeLocalHttpServer": [{ type: "browser.exposeLocalHttpServer", port: 3000 }],
  "browser.unexposeLocalHttpServer": [{ type: "browser.unexposeLocalHttpServer", port: 3000 }],
  "project.readQuickActions": [{ type: "project.readQuickActions", projectId: "p1" }],
  "project.writeQuickActions": [
    { type: "project.writeQuickActions", projectId: "p1", quickActions: [{ id: "q", label: "Test", command: "bun test" }] },
  ],
  "update.check": [{ type: "update.check" }, { type: "update.check", force: true }],
  "update.install": [{ type: "update.install" }],
  "update.installNightly": [{ type: "update.installNightly" }],
  "update.installStable": [{ type: "update.installStable" }],
  "settings.readKeybindings": [{ type: "settings.readKeybindings" }],
  "settings.writeKeybindings": [{ type: "settings.writeKeybindings", bindings: DEFAULT_KEYBINDINGS }],
  "settings.readAppSettings": [{ type: "settings.readAppSettings" }],
  "settings.writeAppSettings": [{ type: "settings.writeAppSettings", analyticsEnabled: false }],
  "settings.writeAppSettingsPatch": [
    { type: "settings.writeAppSettingsPatch", patch: {} },
    {
      type: "settings.writeAppSettingsPatch",
      patch: {
        analyticsEnabled: true,
        browserSettingsMigrated: true,
        theme: "dark",
        chatSoundPreference: "unfocused",
        chatSoundId: "glass",
        chatBrowserNotificationPreference: "always",
        submitWhileRunning: "steer",
        newSidebarEnabled: false,
        projectIconsInChats: true,
        chatTabsEnabled: true,
        widgetsPeekEnabled: false,
        newProjectsDirectory: "~/code",
        setupShown: true,
        setupCompleted: true,
        setupDismissed: false,
        terminal: { scrollbackLines: 5000, minColumnWidth: 40, webglRenderer: true },
        editor: { preset: "zed", commandTemplate: "zed {path}" },
        transcript: { windowAssistantMessages: 50 },
        paneVisibility: { widgets: "chat", terminal: "project" },
        defaultProvider: "last_used",
        providerDefaults: {
          claude: { model: "opus", modelOptions: { reasoningEffort: "high" }, planMode: false, autoPlan: true },
          codex: { modelOptions: { reasoningEffort: "xhigh", fastMode: true } },
          cursor: { model: "auto", modelOptions: { fastMode: false }, planMode: true, autoPlan: false },
          grok: { modelOptions: { reasoningEffort: "medium" } },
          pi: { model: "~anthropic/x", modelOptions: {} },
        },
      },
    },
    { type: "settings.writeAppSettingsPatch", patch: { defaultProvider: "pi", terminal: { scrollbackLines: 100 } } },
  ],
  "settings.readLlmProvider": [{ type: "settings.readLlmProvider" }],
  "usage.refresh": [{ type: "usage.refresh" }, { type: "usage.refresh", force: false }],
  "auth.refresh": [{ type: "auth.refresh" }, { type: "auth.refresh", force: true }],
  "auth.install": [{ type: "auth.install", service: "gh" }],
  "auth.login.start": [{ type: "auth.login.start", service: "claude" }],
  "auth.login.submitCode": [{ type: "auth.login.submitCode", service: "claude", code: "abc" }],
  "auth.login.cancel": [{ type: "auth.login.cancel", service: "openrouter" }],
  "auth.openrouter.start": [{ type: "auth.openrouter.start", callbackUrl: "https://localhost/cb" }],
  "auth.openrouter.exchange": [{ type: "auth.openrouter.exchange", code: "xyz" }],
  "chat.listSkills": [
    { type: "chat.listSkills", provider: "codex" },
    { type: "chat.listSkills", provider: "cursor", chatId: "c1", projectId: "p1" },
  ],
  "skills.search": [{ type: "skills.search", query: "review" }, { type: "skills.search", query: "review", limit: 10 }],
  "skills.install": [{ type: "skills.install", source: "owner/repo", skillId: "skill" }],
  "skills.uninstall": [{ type: "skills.uninstall", skillId: "skill" }],
  "skills.listInstalled": [{ type: "skills.listInstalled" }],
  "skills.listGlobal": [{ type: "skills.listGlobal" }],
  "settings.writeLlmProvider": [
    { type: "settings.writeLlmProvider", provider: "openrouter", apiKey: "k", model: "m", baseUrl: "" },
    {
      type: "settings.writeLlmProvider",
      provider: "custom",
      apiKey: "k",
      model: "m",
      baseUrl: "https://llm",
      faveModels: [{ label: "Fast", id: "fast-1" }],
    },
  ],
  "settings.validateLlmProvider": [{ type: "settings.validateLlmProvider", provider: "openai", apiKey: "k", model: "m", baseUrl: "" }],
  "system.openExternal": [
    { type: "system.openExternal", localPath: "/p", action: "open_finder" },
    {
      type: "system.openExternal",
      localPath: "/p/a.ts",
      action: "open_editor",
      line: 3,
      column: 7,
      editor: { preset: "custom", commandTemplate: "vim {path}" },
    },
    { type: "system.openExternal", localPath: "/p", action: "open_terminal", terminal: "ghostty" },
  ],
  "chat.create": [
    { type: "chat.create", projectId: "p1" },
    { type: "chat.create", projectId: "p1", delegator: true, chatId: "6f1c3b8e-2a4d-4c1e-9f0a-1b2c3d4e5f60" },
  ],
  "chat.setDelegator": [{ type: "chat.setDelegator", chatId: "c1", delegator: false }],
  "chat.fork": [{ type: "chat.fork", chatId: "c1" }],
  "chat.rename": [{ type: "chat.rename", chatId: "c1", title: "T" }],
  "chat.setPinned": [{ type: "chat.setPinned", chatId: "c1", pinned: true }],
  "chat.archive": [{ type: "chat.archive", chatId: "c1" }],
  "chat.unarchive": [{ type: "chat.unarchive", chatId: "c1" }],
  "chat.delete": [{ type: "chat.delete", chatId: "c1" }],
  "chat.setDraftProtection": [{ type: "chat.setDraftProtection", chatIds: ["c1", "c2"] }],
  "chat.touchedFiles": [{ type: "chat.touchedFiles", chatId: "c1" }],
  "chat.markRead": [{ type: "chat.markRead", chatId: "c1" }],
  "chat.setDone": [{ type: "chat.setDone", chatId: "c1", done: true }],
  "chat.setReadAnchor": [
    { type: "chat.setReadAnchor", chatId: "c1", messageId: "m1", atEnd: false },
    { type: "chat.setReadAnchor", chatId: "c1", messageId: "m1", atEnd: true, transcriptWidth: 720, offsetFromMessage: 12.5 },
  ],
  "chat.getReadAnchor": [{ type: "chat.getReadAnchor", chatId: "c1" }],
  "chat.getPreview": [{ type: "chat.getPreview", chatId: "c1" }],
  "chat.getEntryDebugRaw": [{ type: "chat.getEntryDebugRaw", chatId: "c1", entryId: "e1" }],
  "chat.getToolEntries": [{ type: "chat.getToolEntries", chatId: "c1", entryIds: ["e1", "e2"] }],
  "chat.loadOlder": [
    { type: "chat.loadOlder", chatId: "c1" },
    { type: "chat.loadOlder", chatId: "c1", untilMessageId: "m1", all: true },
  ],
  "chat.send": [
    { type: "chat.send", content: "hi" },
    {
      type: "chat.send",
      chatId: "c1",
      projectId: "p1",
      provider: "claude",
      content: "/review",
      attachments: [attachment],
      model: "opus",
      modelOptions,
      effort: "high",
      planMode: true,
      autoPlan: false,
      delegator: true,
    },
  ],
  "chat.refreshDiffs": [{ type: "chat.refreshDiffs", chatId: "c1" }],
  "chat.initGit": [{ type: "chat.initGit", chatId: "c1" }],
  "chat.getGitHubPublishInfo": [{ type: "chat.getGitHubPublishInfo", chatId: "c1" }],
  "chat.checkGitHubRepoAvailability": [{ type: "chat.checkGitHubRepoAvailability", chatId: "c1", owner: "o", name: "n" }],
  "chat.publishToGitHub": [
    { type: "chat.publishToGitHub", chatId: "c1", owner: "o", name: "n", visibility: "private" },
    { type: "chat.publishToGitHub", chatId: "c1", owner: "o", name: "n", visibility: "public", description: "D" },
  ],
  "chat.listBranches": [{ type: "chat.listBranches", chatId: "c1" }],
  "chat.previewMergeBranch": [{ type: "chat.previewMergeBranch", chatId: "c1", branch: { kind: "local", name: "feat" } }],
  "chat.mergeBranch": [{ type: "chat.mergeBranch", chatId: "c1", branch: { kind: "remote", name: "feat", remoteRef: "origin/feat" } }],
  "chat.syncBranch": [
    { type: "chat.syncBranch", chatId: "c1", action: "fetch" },
    { type: "chat.syncBranch", chatId: "c1", action: "publish" },
  ],
  "chat.checkoutBranch": [
    { type: "chat.checkoutBranch", chatId: "c1", branch: { kind: "local", name: "main" } },
    { type: "chat.checkoutBranch", chatId: "c1", branch: { kind: "local", name: "main" }, bringChanges: true },
  ],
  "chat.createBranch": [
    { type: "chat.createBranch", chatId: "c1", name: "feat" },
    { type: "chat.createBranch", chatId: "c1", name: "feat", baseBranchName: "main" },
  ],
  "chat.discardDiffFile": [{ type: "chat.discardDiffFile", chatId: "c1", path: "a.ts" }],
  "chat.ignoreDiffFile": [{ type: "chat.ignoreDiffFile", chatId: "c1", path: "a.ts" }],
  "chat.cancel": [{ type: "chat.cancel", chatId: "c1" }],
  "chat.stopDraining": [{ type: "chat.stopDraining", chatId: "c1" }],
  "chat.stopTask": [{ type: "chat.stopTask", chatId: "c1", taskId: "t1" }],
  "chat.exportStandalone": [
    { type: "chat.exportStandalone", chatId: "c1", theme: "light", attachmentMode: "metadata" },
    { type: "chat.exportStandalone", sourceOrigin: "https://kanna.local", chatId: "c1", theme: "dark", attachmentMode: "bundle" },
  ],
  "chat.respondTool": [
    { type: "chat.respondTool", chatId: "c1", toolUseId: "t1", result: { answers: { q: ["a"] } } },
    { type: "chat.respondTool", chatId: "c1", toolUseId: "t1", result: null },
    { type: "chat.respondTool", chatId: "c1", toolUseId: "t1", result: "text" },
  ],
  "message.enqueue": [
    { type: "message.enqueue", chatId: "c1", content: "next" },
    {
      type: "message.enqueue",
      chatId: "c1",
      content: "now",
      attachments: [attachment],
      provider: "codex",
      model: "gpt",
      modelOptions: { codex: { reasoningEffort: "medium" } },
      planMode: false,
      autoPlan: false,
      steer: true,
    },
  ],
  "message.steer": [{ type: "message.steer", chatId: "c1", queuedMessageId: "q1" }],
  "message.dequeue": [{ type: "message.dequeue", chatId: "c1", queuedMessageId: "q1" }],
  "terminal.create": [
    { type: "terminal.create", projectId: "p1", terminalId: "t1", cols: 80, rows: 24, scrollback: 1000 },
    { type: "terminal.create", projectId: null, terminalId: "t1", cols: 80, rows: 24, scrollback: 1000 },
  ],
  "terminal.input": [{ type: "terminal.input", terminalId: "t1", data: "ls\r" }],
  "terminal.resize": [{ type: "terminal.resize", terminalId: "t1", cols: 120, rows: 40 }],
  "terminal.close": [{ type: "terminal.close", terminalId: "t1" }],
  "terminal.tail": [
    { type: "terminal.tail", terminalId: "t1", sinceVersion: 42 },
    { type: "terminal.tail", terminalId: "t1", sinceVersion: null },
  ],
}

const topics: SubscriptionTopic[] = [
  { type: "sidebar" },
  { type: "sidebar", patches: true },
  { type: "local-projects" },
  { type: "update" },
  { type: "keybindings" },
  { type: "app-settings" },
  { type: "usage-limits" },
  { type: "provider-auth" },
  { type: "chat", chatId: "c1" },
  { type: "chat", chatId: "c1", cachedSpan: { start: 0, end: 10, endEntryId: "e9" }, background: true },
  { type: "project-git", projectId: "p1" },
  { type: "terminal", terminalId: "t1" },
]

const decodeFrame = Schema.decodeUnknownEffect(ClientEnvelopeFromJson)

/** Decodes a frame the way the server receives one: as JSON text. */
const decode = (frame: string) => Effect.runSync(Effect.result(decodeFrame(frame)))
const decodeCompatible = (frame: string) => Effect.runSync(Effect.result(
  Schema.decodeUnknownEffect(ClientFrameJsonSchema)(frame).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CompatibleClientEnvelopeSchema)),
  ),
))

describe("compatible WebSocket envelope", () => {
  test.each([
    { v: 1, type: "command", id: "unknown", command: { type: "future.command", value: 1 } },
    { v: 1, type: "command", id: "incomplete", command: { type: "chat.rename", chatId: "c1" } },
    { v: 1, type: "command", id: "nested", command: { type: "settings.writeAppSettingsPatch", patch: { theme: "sepia" } } },
    { v: 1, type: "command", id: "extra", extra: { kept: true }, command: { type: "system.ping", extra: 42 } },
    { v: 1, type: "future.envelope", anything: true },
  ])("preserves the parsed envelope: $id", (envelope) => {
    const result = decodeCompatible(JSON.stringify(envelope))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(JSON.stringify(result.success)).toBe(JSON.stringify(envelope))
  })

  test.each(["{bad", "42", "null", "[]", JSON.stringify({ v: 2, type: "command" }), JSON.stringify({ v: 1, type: 42 })])(
    "rejects an invalid frame: %s", (frame) => {
      expect(Result.isFailure(decodeCompatible(frame))).toBe(true)
    },
  )
})

describe("ClientEnvelopeFromJson", () => {
  const allCommands = Object.values(samples).flat() as ClientCommand[]

  test.each(allCommands.map((command) => [command.type, command] as const))("decodes %s", (_type, command) => {
    const envelope: ClientEnvelope = { v: 1, type: "command", id: "req-1", command }
    const result = decode(JSON.stringify(envelope))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success).toEqual(envelope)
  })

  test("decodes every subscription topic and unsubscribe", () => {
    for (const topic of topics) {
      const envelope: ClientEnvelope = { v: 1, type: "subscribe", id: "sub-1", topic }
      const result = decode(JSON.stringify(envelope))
      expect(Result.isSuccess(result) && result.success).toEqual(envelope)
    }
    const unsubscribe: ClientEnvelope = { v: 1, type: "unsubscribe", id: "sub-1" }
    const result = decode(JSON.stringify(unsubscribe))
    expect(Result.isSuccess(result) && result.success).toEqual(unsubscribe)
  })

  test("reads a tool response whose result JSON dropped as undefined", () => {
    const command: ClientCommand = { type: "chat.respondTool", chatId: "c1", toolUseId: "t1", result: undefined }
    const result = decode(JSON.stringify({ v: 1, type: "command", id: "req-1", command }))
    expect(Result.isSuccess(result) && result.success).toEqual({ v: 1, type: "command", id: "req-1", command })
  })

  test("drops fields the protocol does not have", () => {
    const result = decode(JSON.stringify({ v: 1, type: "command", id: "r", extra: 1, command: { type: "chat.fork", chatId: "c1", stray: true } }))
    expect(Result.isSuccess(result) && result.success).toEqual({ v: 1, type: "command", id: "r", command: { type: "chat.fork", chatId: "c1" } })
  })

  test.each([
    ["text that is not JSON", "{not json"],
    ["a JSON value that is not an object", "42"],
    ["a protocol version other than 1", JSON.stringify({ v: 2, type: "unsubscribe", id: "x" })],
    ["no id", JSON.stringify({ v: 1, type: "unsubscribe" })],
    ["an unknown envelope type", JSON.stringify({ v: 1, type: "publish", id: "x" })],
    ["an unknown command", JSON.stringify({ v: 1, type: "command", id: "x", command: { type: "chat.explode", chatId: "c1" } })],
    ["a command missing a required field", JSON.stringify({ v: 1, type: "command", id: "x", command: { type: "chat.rename", chatId: "c1" } })],
    ["a field of the wrong type", JSON.stringify({ v: 1, type: "command", id: "x", command: { type: "browser.killLocalHttpServer", port: "3000" } })],
    ["a value outside its literal union", JSON.stringify({ v: 1, type: "command", id: "x", command: { type: "chat.syncBranch", chatId: "c1", action: "rebase" } })],
    ["a nested payload of the wrong shape", JSON.stringify({ v: 1, type: "command", id: "x", command: { type: "settings.writeAppSettingsPatch", patch: { theme: "sepia" } } })],
    ["an unknown subscription topic", JSON.stringify({ v: 1, type: "subscribe", id: "x", topic: { type: "everything" } })],
    ["a subscription topic missing its id", JSON.stringify({ v: 1, type: "subscribe", id: "x", topic: { type: "chat" } })],
  ])("fails with a SchemaError on %s", (_label, frame) => {
    const result = decode(frame)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("SchemaError")
  })
})
