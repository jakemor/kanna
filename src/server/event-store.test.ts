import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(directory)
  return directory
}

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `Command failed: ${cmd.join(" ")}`)
  }
}

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }

  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("creates a feature directory and overview, then moves chats to general when deleted", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Stage Nav Button", "Improve the stage navigation interactions.")
    const chat = await store.createChat(project.id, feature.id)

    expect(feature.directoryRelativePath).toBe(".kanna/Stage_Nav_Button")
    expect(readFileSync(path.join(projectDir, feature.overviewRelativePath), "utf8")).toContain("Improve the stage navigation interactions.")
    expect(store.getChat(chat.id)?.featureId).toBe(feature.id)

    await store.deleteFeature(feature.id)

    expect(store.getFeature(feature.id)).toBeNull()
    expect(store.getChat(chat.id)?.featureId).toBeNull()
  })

  test("creates a placeholder summary when the feature description is blank", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Blank Summary", "")
    const overview = readFileSync(path.join(projectDir, feature.overviewRelativePath), "utf8")

    expect(overview).toContain("## Summary")
    expect(overview).toContain("TODO: Add a short summary for this feature.")
    expect(store.getFeature(feature.id)?.description).toBe("")
  })

  test("persists feature browser state to feature metadata", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Collapsed Feature", "Save browser state")

    await store.setFeatureBrowserState(feature.id, "CLOSED")

    const metadata = readFileSync(path.join(projectDir, feature.directoryRelativePath, "feature.json"), "utf8")
    expect(metadata).toContain('"browserState": "CLOSED"')
    expect(store.getFeature(feature.id)?.browserState).toBe("CLOSED")
  })

  test("persists in-flight feature writes before compaction", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const featurePromise = store.createFeature(project.id, "Feature One", "Persist across restart")

    await store.compact()
    const feature = await featurePromise

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getFeature(feature.id)?.title).toBe("Feature One")
    expect(reloaded.listFeaturesByProject(project.id)).toHaveLength(1)
  })

  test("hiding a project preserves feature state for reopen", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Persistent Feature", "Keep this feature")
    await store.removeProject(project.id)

    expect(store.getProject(project.id)).not.toBeNull()
    expect(store.isProjectHidden(project.repoKey)).toBe(true)

    await store.unhideProject(projectDir)
    const reopened = await store.openProject(projectDir, "Project")

    expect(reopened.id).toBe(project.id)
    expect(store.getFeature(feature.id)?.title).toBe("Persistent Feature")
  })

  test("imports feature state from per-feature .kanna metadata for a fresh store", async () => {
    const sandboxDir = makeTempDir()
    const sourceDataDir = path.join(sandboxDir, "source-data")
    const reloadedDataDir = path.join(sandboxDir, "reloaded-data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })

    const sourceStore = new EventStore(sourceDataDir)
    await sourceStore.initialize()
    const project = await sourceStore.openProject(projectDir, "Project")
    const feature = await sourceStore.createFeature(project.id, "Imported Feature", "Restore this from disk")
    const chat = await sourceStore.createChat(project.id, feature.id)
    await sourceStore.setChatProvider(chat.id, "codex")
    await sourceStore.setSessionToken(chat.id, "thread-1")

    const freshStore = new EventStore(reloadedDataDir)
    await freshStore.initialize()
    const freshProject = await freshStore.openProject(projectDir, "Project")
    const freshChat = await freshStore.createChat(freshProject.id)
    await freshStore.setChatProvider(freshChat.id, "codex")
    await freshStore.setSessionToken(freshChat.id, "thread-1")

    const importedCount = await freshStore.reconcileProjectFeatureState(freshProject.id)
    const importedFeature = freshStore.listFeaturesByProject(freshProject.id)[0]

    expect(importedCount).toBe(1)
    expect(importedFeature?.title).toBe("Imported Feature")
    expect(importedFeature?.stage).toBe("idea")
    expect(freshStore.getChat(freshChat.id)?.featureId).toBe(importedFeature?.id)
    expect(readFileSync(path.join(projectDir, ".kanna", "Imported_Feature", "feature.json"), "utf8")).toContain("Imported Feature")
  })

  test("reconcile removes in-memory features when feature metadata is missing on disk", async () => {
    const sandboxDir = makeTempDir()
    const dataDir = path.join(sandboxDir, "data")
    const projectDir = path.join(sandboxDir, "project")
    mkdirSync(projectDir, { recursive: true })

    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Transient Feature", "Remove when metadata is gone")

    rmSync(path.join(projectDir, ".kanna"), { recursive: true, force: true })

    const reconciled = await store.reconcileProjectFeatureState(project.id)

    expect(reconciled).toBe(0)
    expect(store.getFeature(feature.id)).toBeNull()
    expect(store.listFeaturesByProject(project.id)).toHaveLength(0)
  })

  test("reuses one project across linked git worktrees", async () => {
    const sandboxDir = makeTempDir()
    const repoDir = path.join(sandboxDir, "kanna")
    const worktreeDir = path.join(sandboxDir, "kanna-feature")
    const dataDir = path.join(sandboxDir, "data")
    mkdirSync(repoDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)

    const store = new EventStore(dataDir)
    await store.initialize()

    const rootProject = await store.openProject(repoDir)
    const worktreeProject = await store.openProject(worktreeDir)

    expect(worktreeProject.id).toBe(rootProject.id)
    expect(worktreeProject.worktreePaths.sort()).toEqual([repoDir, worktreeDir].sort())
    expect(worktreeProject.localPath).toBe(worktreeDir)
  })

  test("hydrates linked git worktrees for an existing saved project on initialize", async () => {
    const sandboxDir = makeTempDir()
    const repoDir = path.join(sandboxDir, "kanna")
    const worktreeDir = path.join(sandboxDir, "kanna-feature")
    const dataDir = path.join(sandboxDir, "data")
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)

    await Bun.write(path.join(dataDir, "snapshot.json"), JSON.stringify({
      v: 3,
      generatedAt: Date.now(),
      projects: [{
        id: "project-1",
        repoKey: `git:${path.join(repoDir, ".git")}`,
        localPath: repoDir,
        worktreePaths: [repoDir],
        title: "kanna",
        createdAt: 1,
        updatedAt: 1,
      }],
      chats: [],
      messages: [],
      hiddenProjectKeys: [],
    }, null, 2))

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getProject("project-1")?.worktreePaths.sort()).toEqual([repoDir, worktreeDir].sort())
  })
})
