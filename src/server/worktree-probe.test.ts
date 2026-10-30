import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { createEmptyState, type StoreState } from "./events"
import { deriveSidebarData } from "./read-models"
import { extractRemoteOwner, WorktreeProbe } from "./worktree-probe"
import { TurnFileTracker } from "./worktree-snapshot"

/**
 * The exact seam server.ts wires: turn start snapshots the tree, turn end
 * records the delta and then reprobes. Returns the in-flight promises so tests
 * can await work the production hooks deliberately fire and forget.
 */
function wireTurnTracking(store: EventStore, probe: WorktreeProbe) {
  const turnStarted: Array<Promise<void>> = []
  const turnEnded: Array<Promise<void>> = []
  const tracker = new TurnFileTracker({
    resolveChatPath: (chatId) => {
      const chat = store.state.chatsById.get(chatId)
      const project = chat ? store.state.projectsById.get(chat.projectId) : undefined
      return project?.localPath ?? null
    },
    recordFiles: (chatId, files) => store.recordFilesTouched(chatId, files),
  })
  store.onTurnStarted = (chatId) => {
    turnStarted.push(tracker.beginTurn(chatId))
  }
  store.onTurnEnded = (chatId) => {
    turnEnded.push(tracker.endTurn(chatId).then(() => probe.refreshForChat(chatId)))
  }
  return { tracker, turnStarted, turnEnded }
}

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  }
  return stdout
}

const tempDirs: string[] = []

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await run(["git", "add", "."], root)
  await run(["git", "commit", "-m", "init"], root)
  return root
}

/** State with one project and one chat that has finished a turn (so it's a tick candidate). */
function createState(localPath: string, options?: { lastTurnEndedAt?: number }): StoreState {
  const state = createEmptyState()
  state.projectsById.set("project-1", {
    id: "project-1",
    localPath,
    title: "Project",
    createdAt: 1,
    updatedAt: 1,
  })
  state.projectIdsByPath.set(localPath, "project-1")
  state.chatsById.set("chat-1", {
    id: "chat-1",
    projectId: "project-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    provider: "claude",
    planMode: false,
    autoPlan: false,
    sessionToken: null,
    lastTurnOutcome: null,
    ...(options?.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: options.lastTurnEndedAt }),
  })
  return state
}

/** The tick is private; exercise it the way the interval would. */
function tick(probe: WorktreeProbe) {
  return (probe as unknown as { tick: () => Promise<void> }).tick()
}

describe("WorktreeProbe", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("refreshForChat records the project's dirty state", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    expect(probe.getStates().get("project-1")).toBeUndefined()
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, trackedDirty: false, ahead: 0, additions: 0, deletions: 0, paths: new Set(), headBlobs: new Map() })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")

    const recorded = probe.getStates().get("project-1")
    expect(recorded?.dirty).toBe(true)
    expect([...(recorded?.paths ?? [])]).toEqual(["app.txt"])
  })

  test("onChange fires only when the probe result actually changes", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    // Same clean result twice — no rebroadcast.
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(2)
  })

  test("a probe does not re-trigger itself on the next tick", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    const afterFirst = changes

    // The stamp was re-read after probing, so a quiet repo produces no work.
    await tick(probe)
    await tick(probe)
    expect(changes).toBe(afterFirst)
  })

  test("the tick notices a commit made outside Kanna and clears the dirty state", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")?.dirty).toBe(true)

    // Commit behind Kanna's back — this rewrites .git/index, which is exactly
    // the signal the stat tick watches for.
    await run(["git", "commit", "-am", "external"], repoRoot)
    await tick(probe)

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, trackedDirty: false, ahead: 0, additions: 0, deletions: 0, paths: new Set(), headBlobs: new Map() })
  })

  test("the tick probes projects whose chats never finished a turn", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot)
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    // No chat there can dot, but the channel's place in Relevant reads the repo.
    expect(probe.getStates().get("project-1")?.trackedDirty).toBe(true)
  })

  test("notifies when the line counts move, and only then", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")).toMatchObject({ additions: 1, deletions: 1 })
    changes = 0

    // Same paths, same counts: nothing for the sidebar to push.
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(0)

    // Same dirty path, more lines in it: the counts alone are a change.
    await writeFile(path.join(repoRoot, "app.txt"), "changed\nmore\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")).toMatchObject({ additions: 2, deletions: 1 })
    expect(changes).toBe(1)
  })

  test("tells tracked changes from untracked files", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "scratch.txt"), "new\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")).toMatchObject({ dirty: true, trackedDirty: false })

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await run(["git", "add", "app.txt"], repoRoot)
    await probe.refreshForChat("chat-1")
    // Staged counts as much as unstaged.
    expect(probe.getStates().get("project-1")).toMatchObject({ dirty: true, trackedDirty: true })
  })

  test("counts commits not yet pushed, and none for a branch with no upstream", async () => {
    const remote = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-remote-"))
    tempDirs.push(remote)
    await run(["git", "init", "--bare", "-b", "main"], remote)
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})
    const commit = async (message: string) => {
      await writeFile(path.join(repoRoot, "app.txt"), `${message}\n`, "utf8")
      await run(["git", "commit", "-am", message], repoRoot)
    }

    // Local-only: committed work with nowhere it was meant to go yet.
    await commit("local")
    await probe.refreshForChat("chat-1")
    expect(probe.getStates().get("project-1")?.ahead).toBe(0)

    await run(["git", "remote", "add", "origin", remote], repoRoot)
    await run(["git", "push", "-u", "origin", "main"], repoRoot)
    await commit("one")
    await commit("two")
    await tick(probe)
    expect(probe.getStates().get("project-1")).toMatchObject({ ahead: 2, trackedDirty: false })

    // A push outside Kanna moves only the remote-tracking ref, which the
    // tick's stamp watches for exactly this.
    let changes = 0
    const watched = new WorktreeProbe(() => state, () => {
      changes += 1
    })
    await tick(watched)
    changes = 0
    await Bun.sleep(5)
    await run(["git", "push"], repoRoot)
    await tick(watched)
    expect(watched.getStates().get("project-1")?.ahead).toBe(0)
    expect(changes).toBe(1)
  })

  test("the tick skips deleted projects", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    state.projectsById.get("project-1")!.deletedAt = 2
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    expect(probe.getStates().get("project-1")).toBeUndefined()
  })

  test("recordExternalProbe accepts a result computed elsewhere", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    // Resolves the project's location itself, so a scan arriving from the git
    // panel before any tick still gets its HEAD blobs read.
    await probe.recordExternalProbe("project-1", { dirty: true, paths: ["a.txt"] })

    expect(probe.getStates().get("project-1")).toEqual({
      dirty: true,
      // A scan that doesn't say reads as tracked, and as 0 ahead.
      trackedDirty: true,
      ahead: 0,
      paths: new Set(["a.txt"]),
      // Uncommitted file: in the working tree, absent from HEAD.
      headBlobs: new Map([["a.txt", null]]),
    })
    expect(changes).toBe(1)
  })

  test("a project that is not a repo reports not dirty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(root)
    const state = createState(root, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getStates().get("project-1")).toEqual({ dirty: false, trackedDirty: false, ahead: 0, paths: new Set(), headBlobs: new Map() })
  })
})

/**
 * The seam `server.ts` wires up: a turn ending drives a probe, and the probe
 * feeds the sidebar row. Unit tests cover each half; this covers the join.
 */
describe("WorktreeProbe integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("a finished turn flags the chat's sidebar row as uncommitted work", async () => {
    const repoRoot = await createRepo()
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
    tempDirs.push(dataDir)

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(repoRoot)
    const chat = await store.createChat(project.id)

    let broadcasts = 0
    const probe = new WorktreeProbe(() => store.state, () => {
      broadcasts += 1
    })
    // Mirrors server.ts.
    const { turnStarted, turnEnded } = wireTurnTracking(store, probe)

    // An agent edits a file during its turn.
    await store.recordTurnStarted(chat.id)
    await Promise.all(turnStarted)
    await writeFile(path.join(repoRoot, "app.txt"), "changed by agent\n", "utf8")
    await store.recordTurnFinished(chat.id)
    await Promise.all(turnEnded)

    expect(broadcasts).toBeGreaterThan(0)
    const touched = store.state.chatsById.get(chat.id)?.touchedFiles ?? []
    expect(touched.map((file) => file.path)).toEqual(["app.txt"])
    // Recorded against the commit the turn started from, so committing this
    // work is what later retires the claim.
    expect(touched[0]?.baseBlob).toMatch(/^[0-9a-f]{40}$/u)
    // And the turn's own numstat rides along, through the exact wiring
    // `server.ts` uses — this is what the hover card's `+1 -1` reads.
    expect([touched[0]?.additions, touched[0]?.deletions]).toEqual([1, 1])
    const flagged = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(flagged.projectGroups[0]?.chats[0]?.uncommittedWork).toBe(true)

    // Committing externally clears it on the next tick.
    await run(["git", "commit", "-am", "external"], repoRoot)
    await tick(probe)

    const cleared = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(cleared.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("a chat that touched none of the dirty files is not flagged", async () => {
    // The case the old timestamp rule got wrong: this chat ran, and the tree is
    // dirty, but somebody else's file is what's outstanding.
    const repoRoot = await createRepo()
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
    tempDirs.push(dataDir)

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(repoRoot)
    const chat = await store.createChat(project.id)

    const probe = new WorktreeProbe(() => store.state, () => {})
    const { turnStarted, turnEnded } = wireTurnTracking(store, probe)

    await store.recordTurnStarted(chat.id)
    await Promise.all(turnStarted)
    await writeFile(path.join(repoRoot, "mine.txt"), "this chat's work\n", "utf8")
    await store.recordTurnFinished(chat.id)
    await Promise.all(turnEnded)

    // That work lands; someone else's edit is what stays outstanding.
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "land it"], repoRoot)
    await writeFile(path.join(repoRoot, "theirs.txt"), "another agent\n", "utf8")
    await probe.refreshForChat(chat.id)

    const sidebar = deriveSidebarData(store.state, new Map(), { workingTrees: probe.getStates() })
    expect(sidebar.projectGroups[0]?.chats[0]?.uncommittedWork).toBeUndefined()
  })

  test("labels a project with its repo name and branch", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")).toEqual({
      repoName: path.basename(repoRoot),
      branchName: "main",
    })
  })

  test("picks up the origin owner, and survives a repo with no origin", async () => {
    // The owner qualifies the repo in the sidebar's branch tooltip; a repo with
    // no remote simply has none, which must not disturb the rest of the label.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")
    expect(probe.getRepoLabels().get("project-1")?.repoOwner).toBeUndefined()

    await run(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], repoRoot)
    // A remote alone doesn't move HEAD or the index, so the stamp is unchanged —
    // re-read explicitly rather than via the tick, which is stamp-gated.
    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoOwner).toBe("acme")
  })

  test("resolves the origin to a browsable page, host and all", async () => {
    // The client never sees the remote URL, and the host is the part it can't
    // reconstruct from `owner/repo` — so "Open on GitHub" is only correct
    // because this ran.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")
    expect(probe.getRepoLabels().get("project-1")?.repoUrl).toBeUndefined()

    await run(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], repoRoot)
    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoUrl).toBe("https://github.com/acme/widgets")
  })

  test("leaves a local-path remote without a page, rather than inventing one", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await run(["git", "remote", "add", "origin", "/srv/git/widgets.git"], repoRoot)
    await probe.refreshForChat("chat-1")

    const label = probe.getRepoLabels().get("project-1")
    expect(label?.repoUrl).toBeUndefined()
    // And the rest of the label is undisturbed by the remote it couldn't use.
    expect(label?.repoName).toBe(path.basename(repoRoot))
  })

  test("the tick labels projects with no finished turn", async () => {
    const repoRoot = await createRepo()
    // No lastTurnEndedAt: this project can never show the dot, but its label is
    // still on screen, so the label must not depend on being a dot candidate.
    const state = createState(repoRoot)
    const probe = new WorktreeProbe(() => state, () => {})

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tick(probe)

    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")
  })

  test("the tick picks up a branch switch made outside Kanna", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await tick(probe)
    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")

    await run(["git", "checkout", "-b", "feature/side-quest"], repoRoot)
    await tick(probe)

    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("feature/side-quest")
  })

  test("a probe supplied from outside doesn't freeze the branch label", async () => {
    // The git panel's refresh hands us a scan for free (`recordExternalProbe`),
    // which banks a fresh stamp so the tick doesn't redo the same scan. That
    // stamp must not also count as a *label* read: a checkout followed by a
    // panel refresh would otherwise leave the sidebar naming the old branch
    // until some unrelated commit moved the index — while the git panel, which
    // reads the branch itself, showed the new one.
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await tick(probe)
    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("main")

    await run(["git", "checkout", "-b", "feature/side-quest"], repoRoot)
    probe.recordExternalProbe("project-1", { dirty: false, paths: [] })
    // Fire-and-forget by design; let its stamp write land before the tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await tick(probe)

    expect(probe.getRepoLabels().get("project-1")?.branchName).toBe("feature/side-quest")
  })

  test("a detached HEAD keeps the repo name and drops the branch", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await run(["git", "checkout", "--detach", "HEAD"], repoRoot)
    await probe.refreshForChat("chat-1")

    const label = probe.getRepoLabels().get("project-1")
    expect(label?.repoName).toBe(path.basename(repoRoot))
    expect(label?.branchName).toBeUndefined()
  })

  test("a project inside a repo is labelled with the repo root, not its own folder", async () => {
    const repoRoot = await createRepo()
    const nested = path.join(repoRoot, "packages", "ui")
    await mkdir(nested, { recursive: true })
    const state = createState(nested, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")?.repoName).toBe(path.basename(repoRoot))
  })

  test("a project that is not in a repo gets no label", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    await probe.refreshForChat("chat-1")

    expect(probe.getRepoLabels().get("project-1")).toBeUndefined()
    // A missing label alone can't say this — it also covers every project the
    // probe hasn't reached yet — so the answer is tracked separately.
    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(true)
  })

  test("nothing is claimed about a project the probe has not looked at", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(false)

    await probe.refreshForChat("chat-1")

    expect(probe.getProjectsWithoutRepo().has("project-1")).toBe(false)
  })

  test("learning a folder is not a repo is itself a broadcast", async () => {
    // There is no label to drop, so the repo-label path stays quiet — but the
    // sidebar has just learned it can offer to initialize the folder.
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    await probe.refreshForChat("chat-1")

    expect(changes).toBe(1)
  })

  test("one refresh is one broadcast even when label and dirty state both change", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    let changes = 0
    const probe = new WorktreeProbe(() => state, () => {
      changes += 1
    })

    // First pass sets both the label and the probe — one broadcast, not two.
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(1)

    // A checkout that also dirties the tree still coalesces.
    await run(["git", "checkout", "-b", "next"], repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await probe.refreshForChat("chat-1")
    expect(changes).toBe(2)
  })

  test("the sidebar snapshot carries the repo label", async () => {
    const repoRoot = await createRepo()
    const state = createState(repoRoot, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})
    await probe.refreshForChat("chat-1")

    const sidebar = deriveSidebarData(state, new Map(), { repoLabels: probe.getRepoLabels() })

    expect(sidebar.projectGroups[0]?.repoName).toBe(path.basename(repoRoot))
    expect(sidebar.projectGroups[0]?.branchName).toBe("main")
    expect(sidebar.projectGroups[0]?.hasGitRepo).toBe(true)
  })

  test("the sidebar snapshot states a folder is not a repo, but only once probed", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-plain-"))
    tempDirs.push(plainDir)
    const state = createState(plainDir, { lastTurnEndedAt: 1 })
    const probe = new WorktreeProbe(() => state, () => {})

    const unprobed = deriveSidebarData(state, new Map(), {
      repoLabels: probe.getRepoLabels(),
      projectsWithoutRepo: probe.getProjectsWithoutRepo(),
    })
    expect(unprobed.projectGroups[0]?.hasGitRepo).toBeUndefined()

    await probe.refreshForChat("chat-1")

    const probed = deriveSidebarData(state, new Map(), {
      repoLabels: probe.getRepoLabels(),
      projectsWithoutRepo: probe.getProjectsWithoutRepo(),
    })
    expect(probed.projectGroups[0]?.hasGitRepo).toBe(false)
  })
})

/**
 * One real repo, one real store, turns wired exactly as `server.ts` wires them.
 * Everything here runs git for real — the point is that the claim rules hold
 * against actual commits, not against a hand-built probe.
 */
async function createTrackedProject() {
  const repoRoot = await createRepo()
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-worktree-probe-data-"))
  tempDirs.push(dataDir)

  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(repoRoot)
  const probe = new WorktreeProbe(() => store.state, () => {})
  const { turnStarted, turnEnded } = wireTurnTracking(store, probe)

  /** A whole turn: start (snapshot + base commit), agent edits, finish (record + reprobe). */
  const runTurn = async (chatId: string, mutate: () => Promise<void>) => {
    await store.recordTurnStarted(chatId)
    await Promise.all(turnStarted)
    await mutate()
    await store.recordTurnFinished(chatId)
    await Promise.all(turnEnded)
  }
  const write = (name: string, contents: string) =>
    writeFile(path.join(repoRoot, name), contents, "utf8")
  const commitAll = (message: string) => run(["git", "commit", "-am", message], repoRoot)
  /** Chat ids the sidebar currently marks as bearing on uncommitted work. */
  const flaggedChatIds = (state = store.state) =>
    (deriveSidebarData(state, new Map(), { workingTrees: probe.getStates() }).projectGroups[0]?.chats ?? [])
      .filter((row) => row.uncommittedWork)
      .map((row) => row.chatId)
      .sort()

  return { repoRoot, dataDir, store, project, probe, runTurn, write, commitAll, flaggedChatIds }
}

/**
 * The rule the sidebar's dot turns on: a chat is relevant while a file it
 * changed is dirty *and* nobody has committed that file since it did.
 *
 * The scenario throughout is the one that motivated base blobs — chat A edits a
 * file and its work is committed, then hours later chat B edits the same file.
 */
describe("uncommitted-work claims", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("without base blobs, a commit doesn't retire the claim — the bug", async () => {
    // Reproduces the old paths-only rule against a real repo. `touchedFiles`
    // recorded before base blobs existed carry no base, which is exactly what
    // the previous implementation stored and how it decided: intersect the
    // chat's paths with the dirty set, full stop. `touchedFiles` is a union
    // that only ever grows and a commit writes nothing against the chat, so
    // chat A's claim on app.txt outlives the commit that shipped it — and chat
    // B dirtying the same file five hours later drags chat A back into
    // Relevant alongside it.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat A\n"))
    await tracked.commitAll("chat A's work")
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat B\n"))

    // The root cause, pinned: the commit wrote nothing against chat A, so its
    // claim on the path is still there afterwards. Only the base blob beside it
    // can say the claim is spent.
    expect(tracked.store.state.chatsById.get(chatA.id)?.touchedFiles?.map((file) => file.path))
      .toEqual(["app.txt"])

    // Age the records down to the pre-base-blob shape, leaving everything else
    // — the real repo, the real commit, the real probe — untouched.
    for (const chat of tracked.store.state.chatsById.values()) {
      chat.touchedFiles = chat.touchedFiles?.map((file) => ({ path: file.path }))
    }

    expect(tracked.flaggedChatIds()).toEqual([chatA.id, chatB.id].sort())
  })

  test("with base blobs, only the chat with live work is flagged", async () => {
    // Same repo, same commit, same second edit — now with what the tracker
    // actually records. Chat A's base is the blob it edited *from*; the commit
    // moved HEAD to chat A's own content, so its base no longer matches and the
    // claim is settled. Chat B recorded that new commit as its base, so its
    // claim is the live one.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat A\n"))
    await tracked.commitAll("chat A's work")
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat B\n"))

    expect(tracked.flaggedChatIds()).toEqual([chatB.id])
  })

  test("the settled claim stays settled across a restart", async () => {
    // Base blobs live in the event log, not in memory, so a reload can't
    // resurrect chat A the way replaying a bare path list would.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat A\n"))
    await tracked.commitAll("chat A's work")
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat B\n"))

    const reloaded = new EventStore(tracked.dataDir)
    await reloaded.initialize()

    expect(tracked.flaggedChatIds(reloaded.state)).toEqual([chatB.id])
  })

  test("both chats stay flagged while neither one's work is committed", async () => {
    // The other side of the rule: two chats with live edits to one file are
    // both genuinely part of the current diff, and expiring either would hide
    // uncommitted work.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat A\n"))
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat A\nchat B\n"))

    expect(tracked.flaggedChatIds()).toEqual([chatA.id, chatB.id].sort())
  })

  test("a chat that commits its own work mid-turn doesn't stay claimed to it", async () => {
    // Why the base is read at turn *start*: agents commit their own work all
    // the time, and a base read afterwards would be the chat's own commit —
    // leaving it live on work it had already landed.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, async () => {
      await tracked.write("app.txt", "chat A\n")
      await tracked.commitAll("chat A commits its own work")
    })
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat B\n"))

    expect(tracked.flaggedChatIds()).toEqual([chatB.id])
  })

  test("a chat that edits the file again after the commit is flagged again", async () => {
    // Last write wins per path: chat A's second turn rebases its claim onto the
    // commit that landed its first one, so a settled chat comes back the moment
    // it does new work — it just can't come back on someone else's.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)
    const chatB = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat A\n"))
    await tracked.commitAll("chat A's work")
    await tracked.runTurn(chatB.id, () => tracked.write("app.txt", "chat B\n"))
    expect(tracked.flaggedChatIds()).toEqual([chatB.id])

    await tracked.runTurn(chatA.id, () => tracked.write("app.txt", "chat B\nchat A again\n"))

    expect(tracked.flaggedChatIds()).toEqual([chatA.id, chatB.id].sort())
  })

  test("a new file both chats never committed keeps its author flagged", async () => {
    // The null-base path: never in HEAD on either side is a match, and the
    // commit that first adds it is what retires the claim.
    const tracked = await createTrackedProject()
    const chatA = await tracked.store.createChat(tracked.project.id)

    await tracked.runTurn(chatA.id, () => tracked.write("new.txt", "brand new\n"))
    expect(tracked.flaggedChatIds()).toEqual([chatA.id])

    await run(["git", "add", "."], tracked.repoRoot)
    await run(["git", "commit", "-m", "land the new file"], tracked.repoRoot)
    const chatB = await tracked.store.createChat(tracked.project.id)
    await tracked.runTurn(chatB.id, () => tracked.write("new.txt", "chat B\n"))

    expect(tracked.flaggedChatIds()).toEqual([chatB.id])
  })
})

describe("extractRemoteOwner", () => {
  test("reads the owner out of every remote URL shape git writes", () => {
    expect(extractRemoteOwner("git@github.com:acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("ssh://git@github.com/acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("https://github.com/acme/widgets.git")).toBe("acme")
    expect(extractRemoteOwner("https://github.com/acme/widgets")).toBe("acme")
  })

  test("is host-agnostic, including nested group paths", () => {
    // GitLab subgroups: the owner is whatever sits directly above the repo.
    expect(extractRemoteOwner("https://gitlab.com/acme/tools/widgets.git")).toBe("tools")
    expect(extractRemoteOwner("git@git.internal:acme/widgets.git")).toBe("acme")
  })

  test("has no owner to give for a local or ownerless remote", () => {
    expect(extractRemoteOwner("/srv/git/widgets.git")).toBeUndefined()
    expect(extractRemoteOwner(undefined)).toBeUndefined()
  })
})
