import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { openEventStore, type EventStoreBridge as EventStore } from "./event-store-bridge"
import { deriveSidebarData } from "./read-models"
import { Effect } from "effect"
import { runTest } from "./effect/testing"
import { backfillTouchedFileBases as backfillEffect } from "./touched-file-backfill"
import { WorktreeProbe } from "./worktree-probe"

const tempDirs: string[] = []

const backfillTouchedFileBases = (store: EventStore) => runTest(backfillEffect(store.service))

/** A fresh probe's readings after it refreshed the chat's project, as the sidebar would get them. */
function probeWorkingTrees(store: EventStore, chatId: string) {
  return runTest(Effect.gen(function* () {
    const probe = yield* WorktreeProbe
    yield* probe.refreshForChat(chatId)
    return yield* probe.states
  }).pipe(Effect.provide(WorktreeProbe.layer({ state: Effect.sync(() => store.state) }))))
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string, env?: Record<string, string>) {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...Bun.env, ...env } } : {}),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  return stdout
}

/**
 * The backfill dates a claim by asking which commit the repo was at when the
 * chat ran, so these tests need a real timeline rather than a handful of
 * commits all stamped "now" — with second-granularity commit dates, a repo
 * built in one tick can't express "before" at all.
 */
const AT = {
  init: Date.parse("2026-01-01T00:00:00Z"),
  oldChatRan: Date.parse("2026-02-01T00:00:00Z"),
  secondCommit: Date.parse("2026-03-01T00:00:00Z"),
  recentChatRan: Date.parse("2026-04-01T00:00:00Z"),
}

/** Commits everything in the tree with both git dates pinned. */
async function commitAllAt(repoRoot: string, message: string, atMs: number) {
  const stamp = new Date(atMs).toISOString()
  await run(["git", "add", "-A"], repoRoot)
  await run(["git", "commit", "-m", message], repoRoot, {
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp,
  })
}

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-backfill-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await commitAllAt(root, "init", AT.init)
  return root
}

async function createStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-backfill-data-"))
  tempDirs.push(dataDir)
  const store = await openEventStore(dataDir)
  return { store, dataDir }
}

/**
 * A chat as an install predating base blobs left it: touched paths, no bases,
 * and a last-activity timestamp — which is the only handle the backfill has.
 */
async function createLegacyChat(store: EventStore, projectId: string, options: {
  paths: string[]
  lastTurnEndedAt: number
}) {
  const chat = await store.createChat(projectId)
  const record = store.state.chatsById.get(chat.id)!
  record.touchedFiles = options.paths.map((filePath) => ({ path: filePath }))
  record.lastTurnEndedAt = options.lastTurnEndedAt
  record.lastMessageAt = options.lastTurnEndedAt
  return chat
}

describe("backfillTouchedFileBases", () => {
  test("retires a legacy claim whose file was committed after the chat ran", async () => {
    // The upgrade case: chat A's work shipped months ago, but its claim has no
    // base, so any later edit to that file drags it back into Relevant. The
    // base is recoverable — it's whatever HEAD held for the path when the chat
    // last ran.
    const repoRoot = await createRepo()
    const { store } = await createStore()
    const project = await store.openProject(repoRoot)
    const chatA = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })

    // Chat A's work lands, then someone else dirties the same file.
    await writeFile(path.join(repoRoot, "app.txt"), "chat A\n", "utf8")
    await commitAllAt(repoRoot, "chat A's work", AT.secondCommit)
    await writeFile(path.join(repoRoot, "app.txt"), "someone else\n", "utf8")

    const workingTrees = await probeWorkingTrees(store, chatA.id)
    // Before: the claim can't expire, so the chat is still "relevant".
    const before = deriveSidebarData(store.state, new Map(), { workingTrees })
    expect(before.projectGroups[0]?.chats[0]?.uncommittedWork).toBe(true)

    const result = await backfillTouchedFileBases(store)

    expect(result).toEqual({ chats: 1, files: 1 })
    const after = deriveSidebarData(store.state, new Map(), { workingTrees })
    expect(after.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("keeps a legacy claim whose file has not been committed since", async () => {
    // The other half: this chat's edit is still sitting in the tree, so dating
    // it must not retire it. A migration that cleared everything would hide
    // work the user hasn't committed.
    const repoRoot = await createRepo()
    const { store } = await createStore()
    const project = await store.openProject(repoRoot)
    const chat = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })
    await writeFile(path.join(repoRoot, "app.txt"), "still uncommitted\n", "utf8")

    await backfillTouchedFileBases(store)

    const workingTrees = await probeWorkingTrees(store, chat.id)
    const sidebar = deriveSidebarData(store.state, new Map(), { workingTrees })
    expect(sidebar.projectGroups[0]?.chats[0]?.uncommittedWork).toBe(true)
  })

  test("dates each claim from the commit the repo was at when its chat ran", async () => {
    // Two chats, two eras of the same file. The older one is measured against
    // the older commit, so the commit that followed it settles that claim
    // while the newer chat's stays live.
    const repoRoot = await createRepo()
    const { store } = await createStore()
    const project = await store.openProject(repoRoot)

    const firstBlob = (await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()
    const oldChat = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })

    // A commit lands between the two chats' activity.
    await writeFile(path.join(repoRoot, "app.txt"), "second era\n", "utf8")
    await commitAllAt(repoRoot, "second era", AT.secondCommit)
    const secondBlob = (await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()
    const recentChat = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.recentChatRan,
    })

    await backfillTouchedFileBases(store)

    expect(store.state.chatsById.get(oldChat.id)?.touchedFiles)
      .toEqual([{ path: "app.txt", baseBlob: firstBlob }])
    expect(store.state.chatsById.get(recentChat.id)?.touchedFiles)
      .toEqual([{ path: "app.txt", baseBlob: secondBlob }])

    // And that difference is what the sidebar reads: dirty the file now and
    // only the chat whose base still matches HEAD is flagged.
    await writeFile(path.join(repoRoot, "app.txt"), "third\n", "utf8")
    const workingTrees = await probeWorkingTrees(store, recentChat.id)
    const flagged = (deriveSidebarData(store.state, new Map(), { workingTrees })
      .projectGroups[0]?.chats ?? [])
      .filter((row) => row.uncommittedWork)
      .map((row) => row.chatId)
    expect(flagged).toEqual([recentChat.id])
  })

  test("gives a null base to a path that wasn't committed when the chat ran", async () => {
    const repoRoot = await createRepo()
    const { store } = await createStore()
    const project = await store.openProject(repoRoot)
    const chat = await createLegacyChat(store, project.id, {
      paths: ["added-later.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })

    await backfillTouchedFileBases(store)

    // Not in HEAD then — so the commit that first adds it retires the claim.
    expect(store.state.chatsById.get(chat.id)?.touchedFiles)
      .toEqual([{ path: "added-later.txt", baseBlob: null }])
  })

  test("persists through the event log, so it only has to run once", async () => {
    const repoRoot = await createRepo()
    const { store, dataDir } = await createStore()
    const project = await store.openProject(repoRoot)
    const chat = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })

    await backfillTouchedFileBases(store)
    const dated = store.state.chatsById.get(chat.id)?.touchedFiles

    const reloaded = await openEventStore(dataDir)
    expect(reloaded.state.chatsById.get(chat.id)?.touchedFiles).toEqual(dated)
    // Nothing left to date, so a second boot is a no-op.
    expect(await backfillTouchedFileBases(reloaded)).toEqual({ chats: 0, files: 0 })
  })

  test("leaves claims it can't date alone rather than guessing", async () => {
    // A project that isn't a repo has nothing to read a base from. Leaving the
    // claim unknown keeps the pre-existing behaviour; inventing a base could
    // retire work that is genuinely outstanding.
    const plain = await mkdtemp(path.join(tmpdir(), "kanna-backfill-plain-"))
    tempDirs.push(plain)
    const { store } = await createStore()
    const project = await store.openProject(plain)
    const chat = await createLegacyChat(store, project.id, {
      paths: ["app.txt"],
      lastTurnEndedAt: AT.oldChatRan,
    })

    expect(await backfillTouchedFileBases(store)).toEqual({ chats: 0, files: 0 })
    expect(store.state.chatsById.get(chat.id)?.touchedFiles).toEqual([{ path: "app.txt" }])
  })

  test("leaves already-dated claims untouched", async () => {
    const repoRoot = await createRepo()
    const { store } = await createStore()
    const project = await store.openProject(repoRoot)
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "app.txt", baseBlob: "blob-from-a-real-turn" }])

    expect(await backfillTouchedFileBases(store)).toEqual({ chats: 0, files: 0 })
    expect(store.state.chatsById.get(chat.id)?.touchedFiles)
      .toEqual([{ path: "app.txt", baseBlob: "blob-from-a-real-turn" }])
  })
})
