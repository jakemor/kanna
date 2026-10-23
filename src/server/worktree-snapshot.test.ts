import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { TestPlatform } from "./effect/testing"
import { LARGE_FILE_BYTES, TurnFileRecordError, TurnFileTracker, type TouchedFile } from "./worktree-snapshot"

const tempDirs: string[] = []
const runtimes: Array<ManagedRuntime.ManagedRuntime<TurnFileTracker, never>> = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  return stdout
}

async function exitCode(command: string[], cwd: string) {
  return Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" }).exited
}

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-turn-files-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8")
  await run(["git", "add", "."], root)
  await run(["git", "commit", "-m", "init"], root)
  return root
}

/** A tracker over one repo, collecting what it records per chat. */
function trackerFor(repoRoot: string | null) {
  const recordedFiles = new Map<string, TouchedFile[]>()
  const runtime = ManagedRuntime.make(TurnFileTracker.layer({
    resolveChatPath: () => repoRoot,
    recordFiles: (chatId, files) => Effect.sync(() => {
      recordedFiles.set(chatId, [...(recordedFiles.get(chatId) ?? []), ...files])
    }),
  }).pipe(Layer.provide(TestPlatform)))
  runtimes.push(runtime)
  /** The tracker's calls, run to completion. */
  const tracker = {
    beginTurn: (chatId: string) => runtime.runPromise(Effect.flatMap(Effect.service(TurnFileTracker), (service) => service.beginTurn(chatId))),
    endTurn: (chatId: string) => runtime.runPromise(Effect.flatMap(Effect.service(TurnFileTracker), (service) => service.endTurn(chatId))),
    forget: (chatId: string) => runtime.runPromise(Effect.flatMap(Effect.service(TurnFileTracker), (service) => service.forget(chatId))),
  }
  const pathsFor = (chatId: string) => (recordedFiles.get(chatId) ?? []).map((file) => file.path)
  /** One whole turn: snapshot, let `mutate` play the agent, snapshot and diff. */
  const runTurn = async (chatId: string, mutate: () => Promise<void>) => {
    await tracker.beginTurn(chatId)
    await mutate()
    await tracker.endTurn(chatId)
    return pathsFor(chatId)
  }
  /** Same turn, but keeping the base blobs the paths were recorded with. */
  const runTurnForFiles = async (chatId: string, mutate: () => Promise<void>) => {
    await runTurn(chatId, mutate)
    return recordedFiles.get(chatId) ?? []
  }
  return { tracker, recordedFiles, runTurn, runTurnForFiles }
}

describe("TurnFileTracker", () => {
  test("records a file the turn modified", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("records files created by any means, not just edit tools", async () => {
    // The reason this is a filesystem snapshot rather than tool-call parsing:
    // a shell redirect inside a Bash call is invisible to the transcript.
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await run(["sh", "-c", "echo generated > from-bash.txt"], repoRoot)
    })

    expect(paths).toEqual(["from-bash.txt"])
  })

  test("records deletions — a removed file is still a file the chat changed", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await rm(path.join(repoRoot, "app.txt"))
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("records both sides of a rename", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await run(["git", "mv", "app.txt", "renamed.txt"], repoRoot)
    })

    expect(paths.sort()).toEqual(["app.txt", "renamed.txt"])
  })

  test("records nothing for a turn that changed nothing", async () => {
    const repoRoot = await createRepo()
    const { runTurn, recordedFiles: recorded } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {})

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("ignores gitignored paths, exactly as git status does", async () => {
    // The dirty set comes from `git status`, so anything it hides must be
    // hidden here too or a chat could hold paths that can never intersect.
    const repoRoot = await createRepo()
    const { runTurn, recordedFiles: recorded } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await mkdir(path.join(repoRoot, "ignored"), { recursive: true })
      await writeFile(path.join(repoRoot, "ignored", "junk.txt"), "noise\n", "utf8")
    })

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("attributes only what changed during the turn", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    // Dirt that predates the turn belongs to whoever made it, not to this chat.
    await writeFile(path.join(repoRoot, "pre-existing.txt"), "not mine\n", "utf8")

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "mine.txt"), "mine\n", "utf8")
    })

    expect(paths).toEqual(["mine.txt"])
  })

  test("a committed change still counts as touched", async () => {
    // Committing inside the turn leaves the tree clean, but the chat did change
    // the file — the intersection with the dirty set decides relevance later.
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
      await run(["git", "commit", "-am", "agent commit"], repoRoot)
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("records the blob each path held at the turn's starting commit", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    const baseBlob = (await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    })

    // The committed content the edit was made on top of — not the edit itself,
    // and not whatever HEAD holds by the time the sidebar asks.
    expect(files).toEqual([{ path: "app.txt", baseBlob, additions: 1, deletions: 1 }])
  })

  test("a file the turn created has no committed base at all", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "new.txt"), "brand new\n", "utf8")
    })

    // `null`, meaning "not committed" — distinct from an absent base, which
    // would mean the lookup never ran.
    expect(files).toEqual([{ path: "new.txt", baseBlob: null, additions: 1, deletions: 0 }])
  })

  test("a turn that commits its own work records the base it started from", async () => {
    // Read at turn start, so the chat's own commit can't become its base — the
    // recorded blob is the content it replaced, which is what lets that commit
    // retire the claim.
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    const beforeTurn = (await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
      await run(["git", "commit", "-am", "agent commit"], repoRoot)
    })

    expect(files).toEqual([{ path: "app.txt", baseBlob: beforeTurn, additions: 1, deletions: 1 }])
    expect((await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()).not.toBe(beforeTurn)
  })

  test("records a null base for every path in a repo with no commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-turn-files-unborn-"))
    tempDirs.push(root)
    await run(["git", "init", "-b", "main"], root)
    const { runTurnForFiles } = trackerFor(root)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(root, "app.txt"), "first\n", "utf8")
    })

    // Nothing is committed here, so "not in HEAD" is the honest base — and the
    // first commit of this path will duly retire the claim.
    expect(files).toEqual([{ path: "app.txt", baseBlob: null, additions: 1, deletions: 0 }])
  })

  test("counts the lines the turn added and removed", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "one\ntwo\nthree\n", "utf8")
      await writeFile(path.join(repoRoot, "extra.txt"), "a\nb\n", "utf8")
    })

    expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      // Rewrote the one committed line as three.
      ["app.txt", 3, 1],
      ["extra.txt", 2, 0],
    ])
  })

  test("leaves a binary file's counts out rather than calling them zero", async () => {
    // numstat reports `-` for binary. Absent counts mean "unknown", which the
    // hover card renders as no number at all — "+0" would be a claim.
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    })

    expect(files).toEqual([{ path: "logo.png", baseBlob: null }])
  })

  test("keeps paths with spaces intact", async () => {
    // `-z` earns its place here: git C-quotes such a path by default, and a
    // quoted path matches neither `git status` nor the file on disk.
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "notes with spaces.md"), "hi\n", "utf8")
    })

    expect(paths).toEqual(["notes with spaces.md"])
  })

  test("leaves no temp index files behind", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    })

    const gitDirEntries = await readdir(path.join(repoRoot, ".git"))
    expect(gitDirEntries.filter((entry) => entry.startsWith("kanna-snapshot-index"))).toEqual([])
  })

  test("never touches the user's index or refs", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "staged-by-nobody.txt"), "new\n", "utf8")
    })

    // Still untracked rather than staged: `git add -A` ran against a throwaway
    // index, so the real one never saw it.
    expect(await run(["git", "status", "--short"], repoRoot)).toContain("?? staged-by-nobody.txt")
    // And nothing was committed or ref'd — unlike t3's checkpoints, we keep no
    // trees, because the path list is all we need.
    const refs = await run(["git", "for-each-ref", "--format=%(refname)"], repoRoot)
    expect(refs.split("\n").filter((ref) => ref && !ref.startsWith("refs/heads/"))).toEqual([])
  })

  test("records nothing when the project is not a repo", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "kanna-turn-files-plain-"))
    tempDirs.push(plain)
    const { runTurn, recordedFiles: recorded } = trackerFor(plain)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(plain, "app.txt"), "changed\n", "utf8")
    })

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("records nothing when the turn's start was never captured", async () => {
    // Server restarted mid-turn: no baseline, so we say nothing rather than
    // attributing every change since some arbitrary point to this chat.
    const repoRoot = await createRepo()
    const { tracker, recordedFiles: recorded } = trackerFor(repoRoot)

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tracker.endTurn("chat-1")

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("records a large file the turn wrote without hashing it", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    const videoPath = path.join(repoRoot, "render.mp4")

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(videoPath, Buffer.alloc(LARGE_FILE_BYTES, 1))
    })

    // No counts: there is no blob to count lines in.
    expect(files).toEqual([{ path: "render.mp4", baseBlob: null }])
    // And none was written. Hashing it is the cost this path exists to avoid.
    const sha = (await run(["git", "hash-object", videoPath], repoRoot)).trim()
    expect(await exitCode(["git", "cat-file", "-e", sha], repoRoot)).not.toBe(0)
  })

  test("records nothing for a large file the turn left alone", async () => {
    const repoRoot = await createRepo()
    const { runTurn, recordedFiles: recorded } = trackerFor(repoRoot)
    await writeFile(path.join(repoRoot, "dataset.bin"), Buffer.alloc(LARGE_FILE_BYTES, 1))

    await runTurn("chat-1", async () => {})

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("records a large file the turn deleted", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)
    await writeFile(path.join(repoRoot, "dataset.bin"), Buffer.alloc(LARGE_FILE_BYTES, 1))

    const paths = await runTurn("chat-1", async () => {
      await rm(path.join(repoRoot, "dataset.bin"))
    })

    expect(paths).toEqual(["dataset.bin"])
  })

  test("records a large tracked file the turn edited", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    const assetPath = path.join(repoRoot, "asset.bin")
    await writeFile(assetPath, Buffer.alloc(LARGE_FILE_BYTES, 1))
    await run(["git", "add", "asset.bin"], repoRoot)
    await run(["git", "commit", "-m", "asset"], repoRoot)
    const baseBlob = (await run(["git", "rev-parse", "HEAD:asset.bin"], repoRoot)).trim()

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(assetPath, Buffer.alloc(LARGE_FILE_BYTES + 1, 2))
    })

    expect(files).toEqual([{ path: "asset.bin", baseBlob }])
    const sha = (await run(["git", "hash-object", assetPath], repoRoot)).trim()
    expect(await exitCode(["git", "cat-file", "-e", sha], repoRoot)).not.toBe(0)
  })

  test("a file one byte under the threshold keeps its line counts", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "almost.txt"), `${"a".repeat(LARGE_FILE_BYTES - 2)}\n`, "utf8")
    })

    expect(files).toEqual([{ path: "almost.txt", additions: 1, deletions: 0, baseBlob: null }])
  })

  test("records a file that grows past the threshold, without counts", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), Buffer.alloc(LARGE_FILE_BYTES, 65))
    })

    expect(files.map((file) => file.path)).toEqual(["app.txt"])
    expect(files[0]).not.toHaveProperty("additions")
  })

  test("records a file that shrinks under the threshold, without counts", async () => {
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), Buffer.alloc(LARGE_FILE_BYTES, 65))

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "small\n", "utf8")
    })

    expect(files.map((file) => file.path)).toEqual(["app.txt"])
    expect(files[0]).not.toHaveProperty("additions")
  })

  test("a large file with glob characters in its name excludes only itself", async () => {
    // As globs, `*.bin` would match `a.bin` and `[ab].txt` would match
    // `b.txt`, keeping both out of the tree.
    const repoRoot = await createRepo()
    const { runTurnForFiles } = trackerFor(repoRoot)
    await writeFile(path.join(repoRoot, "*.bin"), Buffer.alloc(LARGE_FILE_BYTES, 1))
    await writeFile(path.join(repoRoot, "[ab].txt"), Buffer.alloc(LARGE_FILE_BYTES, 1))

    const files = await runTurnForFiles("chat-1", async () => {
      await writeFile(path.join(repoRoot, "a.bin"), "small\n", "utf8")
      await writeFile(path.join(repoRoot, "b.txt"), "small\n", "utf8")
    })

    expect(files.map((file) => file.path).sort()).toEqual(["a.bin", "b.txt"])
  })

  test("records nothing when a large dirty file is only staged mid-turn", async () => {
    // Its tree entry follows the user's index, so staging moves the tree even
    // though the file on disk never changed.
    const repoRoot = await createRepo()
    const { runTurn, recordedFiles: recorded } = trackerFor(repoRoot)
    await writeFile(path.join(repoRoot, "asset.bin"), Buffer.alloc(LARGE_FILE_BYTES, 1))
    await run(["git", "add", "asset.bin"], repoRoot)
    await run(["git", "commit", "-m", "asset"], repoRoot)
    await writeFile(path.join(repoRoot, "asset.bin"), Buffer.alloc(LARGE_FILE_BYTES + 1, 2))

    await runTurn("chat-1", async () => {
      await run(["git", "add", "asset.bin"], repoRoot)
    })

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("concurrent turns that start together each get a baseline", async () => {
    // Their captures are merged into one, which must still predate both edits.
    const repoRoot = await createRepo()
    const { tracker, recordedFiles: recorded } = trackerFor(repoRoot)

    await Promise.all([tracker.beginTurn("chat-a"), tracker.beginTurn("chat-b"), tracker.beginTurn("chat-c")])
    await writeFile(path.join(repoRoot, "a.txt"), "a\n", "utf8")
    await tracker.endTurn("chat-a")
    await writeFile(path.join(repoRoot, "b.txt"), "b\n", "utf8")
    await tracker.endTurn("chat-b")

    expect(recorded.get("chat-a")?.map((file) => file.path)).toEqual(["a.txt"])
    expect(recorded.get("chat-b")?.map((file) => file.path).sort()).toEqual(["a.txt", "b.txt"])
  })

  test("tracks concurrent turns independently", async () => {
    // Two chats in one worktree. Each still gets its own baseline; what they
    // can't do is tell each other's edits apart inside an overlapping window.
    const repoRoot = await createRepo()
    const { tracker, recordedFiles: recorded } = trackerFor(repoRoot)

    await tracker.beginTurn("chat-a")
    await writeFile(path.join(repoRoot, "a.txt"), "a\n", "utf8")
    await tracker.endTurn("chat-a")

    await tracker.beginTurn("chat-b")
    await writeFile(path.join(repoRoot, "b.txt"), "b\n", "utf8")
    await tracker.endTurn("chat-b")

    expect(recorded.get("chat-a")?.map((file) => file.path)).toEqual(["a.txt"])
    expect(recorded.get("chat-b")?.map((file) => file.path)).toEqual(["b.txt"])
  })

  test("a turn ends cleanly when its files cannot be recorded", async () => {
    // File tracking must never break a turn's completion path: the failure is
    // logged, and the end of the turn still succeeds.
    const repoRoot = await createRepo()
    let attempts = 0
    const runtime = ManagedRuntime.make(TurnFileTracker.layer({
      resolveChatPath: () => repoRoot,
      recordFiles: (chatId) => Effect.suspend(() => {
        attempts += 1
        return Effect.fail(new TurnFileRecordError({ chatId, cause: new Error("disk full") }))
      }),
    }).pipe(Layer.provide(TestPlatform)))
    runtimes.push(runtime)

    await runtime.runPromise(Effect.gen(function* () {
      const tracker = yield* TurnFileTracker
      yield* tracker.beginTurn("chat-1")
      yield* Effect.promise(() => writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8"))
      yield* tracker.endTurn("chat-1")
    }))

    expect(attempts).toBe(1)
  })

  test("a turn the tracker was told to forget records nothing", async () => {
    const repoRoot = await createRepo()
    const { tracker, recordedFiles: recorded } = trackerFor(repoRoot)

    await tracker.beginTurn("chat-1")
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tracker.forget("chat-1")
    await tracker.endTurn("chat-1")

    expect(recorded.has("chat-1")).toBe(false)
  })
})
