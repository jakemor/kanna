# `@` File Mention Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code-style `@` file/directory picker to Kanna's chat input. Typing `@` at a word boundary opens a fuzzy-searchable picker populated from the project's git-tracked + untracked files (with ripgrep / readdir fallbacks). Selecting a row inserts `@relative/path` text and registers a `kind: "mention"` attachment. The server renders mentions inside the existing `<kanna-attachments>` block so both Claude and Codex sessions receive them.

**Architecture:** Additive. New server module `project-paths.ts` owns file indexing + fuzzy filter; new route `GET /api/projects/:id/paths?query=`. A new `"mention"` variant on `AttachmentKind` flows through the existing attachment hint renderer in `src/server/agent.ts`. Client adds `mention-suggestions.ts`, `useMentionSuggestions`, `MentionPicker.tsx`, and a branch in `AttachmentCard.tsx`; `ChatInput.tsx` wires them.

**Tech Stack:** TypeScript, Bun, React 19, Zustand, Vitest/bun:test, Tailwind, Bun.spawn for git subprocesses.

**Design reference:** `docs/superpowers/specs/2026-04-20-at-mention-file-picker-design.md`.

**Baseline:** Branch `main`, clean tree at `16eee47`. Before starting, create a feature branch: `git checkout -b feature/at-mention-picker`. Verify `bun run check` passes.

---

## Task 1 — Shared `"mention"` attachment kind

**Files:**
- Modify: `src/shared/types.ts` (lines 9-20)

- [ ] **Step 1: Extend `AttachmentKind`**

Edit `src/shared/types.ts`:

```ts
export type AttachmentKind = "image" | "file" | "mention"
```

- [ ] **Step 2: Run typecheck**

Run: `bun run check`
Expected: PASS. The addition is a union widening — existing narrowings (`kind === "image"` / `kind === "file"`) are still valid. If a `switch (kind)` exhaustive check fails somewhere, note the file and add a `case "mention":` branch that falls through to the default (no-op for now).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add \"mention\" variant to AttachmentKind"
```

---

## Task 2 — Server path indexer (`project-paths.ts`)

**Files:**
- Create: `src/server/project-paths.ts`
- Create: `src/server/project-paths.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/project-paths.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import { clearProjectPathCache, listProjectPaths } from "./project-paths"

const tempDirs: string[] = []

beforeEach(() => {
  clearProjectPathCache()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe("listProjectPaths", () => {
  test("empty query returns top-level entries with dirs suffixed", async () => {
    const root = await makeTempDir("kanna-paths-empty-")
    await writeFile(path.join(root, "a.txt"), "a")
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "b.ts"), "b")

    const paths = await listProjectPaths({ projectId: "p1", localPath: root, query: "" })
    const names = paths.map((p) => p.path).sort()
    expect(names).toEqual(["a.txt", "src/"])
    expect(paths.find((p) => p.path === "src/")?.kind).toBe("dir")
    expect(paths.find((p) => p.path === "a.txt")?.kind).toBe("file")
  })

  test("git repo: returns tracked files + derived dirs", async () => {
    const root = await makeTempDir("kanna-paths-git-")
    await $`git init -q`.cwd(root)
    await $`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.cwd(root)
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "agent.ts"), "x")
    await writeFile(path.join(root, "README.md"), "r")
    await $`git add .`.cwd(root)
    await $`git -c user.email=t@t -c user.name=t commit -q -m add`.cwd(root)

    const paths = await listProjectPaths({ projectId: "p2", localPath: root, query: "agent" })
    const names = paths.map((p) => p.path)
    expect(names).toContain("src/agent.ts")
  })

  test("git repo: respects .gitignore for untracked files", async () => {
    const root = await makeTempDir("kanna-paths-ignore-")
    await $`git init -q`.cwd(root)
    await writeFile(path.join(root, ".gitignore"), "node_modules\n")
    await mkdir(path.join(root, "node_modules"))
    await writeFile(path.join(root, "node_modules", "junk.js"), "x")
    await writeFile(path.join(root, "app.ts"), "x")

    const paths = await listProjectPaths({ projectId: "p3", localPath: root, query: "junk" })
    expect(paths.map((p) => p.path)).not.toContain("node_modules/junk.js")
  })

  test("fuzzy ranking: prefix matches before substring matches", async () => {
    const root = await makeTempDir("kanna-paths-rank-")
    await writeFile(path.join(root, "review.ts"), "")
    await writeFile(path.join(root, "unreview.ts"), "")

    const paths = await listProjectPaths({ projectId: "p4", localPath: root, query: "rev" })
    expect(paths.map((p) => p.path)).toEqual(["review.ts", "unreview.ts"])
  })

  test("respects limit", async () => {
    const root = await makeTempDir("kanna-paths-limit-")
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(root, `file-${i}.txt`), "")
    }

    const paths = await listProjectPaths({ projectId: "p5", localPath: root, query: "file", limit: 3 })
    expect(paths.length).toBe(3)
  })

  test("cache returns from memory on repeat call", async () => {
    const root = await makeTempDir("kanna-paths-cache-")
    await writeFile(path.join(root, "a.txt"), "")

    const first = await listProjectPaths({ projectId: "p6", localPath: root, query: "a" })
    await writeFile(path.join(root, "b.txt"), "") // added after first call
    const second = await listProjectPaths({ projectId: "p6", localPath: root, query: "b" })

    expect(first.map((p) => p.path)).toContain("a.txt")
    // b.txt was added after cache built and no .git/index triggered invalidation,
    // but since this is non-git, the 5s TTL won't have elapsed so b.txt should
    // NOT appear yet.
    expect(second.map((p) => p.path)).not.toContain("b.txt")
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `bun test src/server/project-paths.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `project-paths.ts`**

Create `src/server/project-paths.ts`:

```ts
import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "bun"

export interface ProjectPath {
  path: string
  kind: "file" | "dir"
}

interface CacheEntry {
  files: string[]       // relative, forward slashes
  dirs: string[]        // relative, forward slashes, no trailing separator
  gitIndexMtime: number | null
  builtAt: number
}

const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_WALK_ENTRIES = 10_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const DEFAULT_WALK_EXCLUDES = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".svn", ".hg", ".jj", ".sl",
])

export function clearProjectPathCache(projectId?: string) {
  if (projectId) CACHE.delete(projectId)
  else CACHE.clear()
}

export async function listProjectPaths(args: {
  projectId: string
  localPath: string
  query: string
  limit?: number
}): Promise<ProjectPath[]> {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const query = args.query ?? ""

  if (query === "") {
    return listTopLevelEntries(args.localPath, limit)
  }

  const entry = await getOrBuildCache(args.projectId, args.localPath)
  return fuzzyRank(entry, query, limit)
}

async function listTopLevelEntries(localPath: string, limit: number): Promise<ProjectPath[]> {
  try {
    const entries = await readdir(localPath, { withFileTypes: true })
    const result: ProjectPath[] = []
    for (const e of entries) {
      if (DEFAULT_WALK_EXCLUDES.has(e.name)) continue
      if (e.name.startsWith(".")) continue
      result.push(e.isDirectory()
        ? { path: `${e.name}/`, kind: "dir" }
        : { path: e.name, kind: "file" })
    }
    result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
      return a.path.localeCompare(b.path)
    })
    return result.slice(0, limit)
  } catch {
    return []
  }
}

async function getOrBuildCache(projectId: string, localPath: string): Promise<CacheEntry> {
  const existing = CACHE.get(projectId)
  const gitIndexMtime = getGitIndexMtime(localPath)
  const now = Date.now()

  if (existing) {
    const gitChanged = gitIndexMtime !== null && gitIndexMtime !== existing.gitIndexMtime
    const expired = now - existing.builtAt > CACHE_TTL_MS
    if (!gitChanged && !expired) return existing
  }

  const built = await buildCacheEntry(localPath)
  const next: CacheEntry = { ...built, gitIndexMtime, builtAt: now }
  CACHE.set(projectId, next)
  return next
}

function getGitIndexMtime(localPath: string): number | null {
  const indexPath = path.join(localPath, ".git", "index")
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs")
    return statSync(indexPath).mtimeMs
  } catch {
    return null
  }
}

async function buildCacheEntry(localPath: string): Promise<Pick<CacheEntry, "files" | "dirs">> {
  const gitFiles = await listGitFiles(localPath)
  const files = gitFiles ?? await walkDirectory(localPath)
  const dirs = deriveDirectories(files)
  return { files, dirs }
}

async function listGitFiles(localPath: string): Promise<string[] | null> {
  if (!existsSync(path.join(localPath, ".git"))) return null

  const tracked = await runGit(localPath, ["-c", "core.quotepath=false", "ls-files"])
  if (tracked === null) return null

  const untracked = await runGit(localPath, [
    "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard",
  ])

  const all = new Set<string>()
  for (const line of tracked) all.add(line)
  for (const line of untracked ?? []) all.add(line)
  return [...all].filter((p) => p.length > 0).map((p) => p.replaceAll("\\", "/"))
}

async function runGit(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const proc = spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    return stdout.split("\n").filter(Boolean)
  } catch {
    return null
  }
}

async function walkDirectory(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = [""]
  while (queue.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const rel = queue.shift()!
    const abs = path.join(root, rel)
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (DEFAULT_WALK_EXCLUDES.has(e.name)) continue
      const nextRel = rel === "" ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        queue.push(nextRel)
      } else if (e.isFile()) {
        out.push(nextRel)
        if (out.length >= MAX_WALK_ENTRIES) break
      }
    }
  }
  return out
}

function deriveDirectories(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    let idx = f.lastIndexOf("/")
    while (idx > 0) {
      dirs.add(f.slice(0, idx))
      idx = f.lastIndexOf("/", idx - 1)
    }
  }
  return [...dirs]
}

function fuzzyRank(entry: CacheEntry, query: string, limit: number): ProjectPath[] {
  const q = query.toLowerCase()
  const prefix: ProjectPath[] = []
  const substring: ProjectPath[] = []

  for (const f of entry.files) {
    const hay = f.toLowerCase()
    if (hay.startsWith(q)) prefix.push({ path: f, kind: "file" })
    else if (hay.includes(q)) substring.push({ path: f, kind: "file" })
  }
  for (const d of entry.dirs) {
    const hay = d.toLowerCase()
    const withSlash = `${d}/`
    if (hay.startsWith(q)) prefix.push({ path: withSlash, kind: "dir" })
    else if (hay.includes(q)) substring.push({ path: withSlash, kind: "dir" })
  }

  const byPath = (a: ProjectPath, b: ProjectPath) => a.path.localeCompare(b.path)
  prefix.sort(byPath)
  substring.sort(byPath)
  return [...prefix, ...substring].slice(0, limit)
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/server/project-paths.test.ts`
Expected: PASS (all cases).

If the `cache returns from memory` test fails because writes happened too fast for the TTL check, that test is still valid — it asserts that a freshly-added file does NOT appear in the second call. If the test is flaky, replace the assertion with: `expect(CACHE.has("p6")).toBe(true)` by exporting a helper. Keep it simple and adjust only if needed.

- [ ] **Step 5: Commit**

```bash
git add src/server/project-paths.ts src/server/project-paths.test.ts
git commit -m "feat(server): add project-paths module for @ mention suggestions"
```

---

## Task 3 — HTTP route `/api/projects/:id/paths`

**Files:**
- Modify: `src/server/server.ts` (add import + route handler + call site around line 228)

- [ ] **Step 1: Write failing test**

Add to `src/server/uploads.test.ts` (reuses existing `startKannaServer` setup) or create `src/server/paths-route.test.ts` if preferred. Use the latter for isolation:

Create `src/server/paths-route.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startKannaServer } from "./server"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function makeProject(): Promise<{ projectDir: string; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-data-"))
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-proj-"))
  tempDirs.push(dataDir, projectDir)
  process.env.KANNA_DATA_DIR = dataDir
  return { projectDir, dataDir }
}

describe("GET /api/projects/:id/paths", () => {
  test("returns 404 for unknown project", async () => {
    const { projectDir } = await makeProject()
    await mkdir(path.join(projectDir, "src"))
    await writeFile(path.join(projectDir, "src", "a.ts"), "")

    const server = await startKannaServer({ port: 0 })
    try {
      const response = await fetch(`http://localhost:${server.port}/api/projects/does-not-exist/paths`)
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("returns top-level entries for empty query", async () => {
    const { projectDir } = await makeProject()
    await mkdir(path.join(projectDir, "src"))
    await writeFile(path.join(projectDir, "README.md"), "")

    const server = await startKannaServer({ port: 0 })
    try {
      const project = server.store.openProject({ localPath: projectDir, title: "t" })
      const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/paths`)
      expect(response.status).toBe(200)
      const payload = await response.json() as { paths: Array<{ path: string; kind: string }> }
      const names = payload.paths.map((p) => p.path)
      expect(names).toContain("README.md")
      expect(names).toContain("src/")
    } finally {
      await server.stop()
    }
  })

  test("respects ?query= and ?limit=", async () => {
    const { projectDir } = await makeProject()
    for (let i = 0; i < 5; i++) await writeFile(path.join(projectDir, `file-${i}.txt`), "")

    const server = await startKannaServer({ port: 0 })
    try {
      const project = server.store.openProject({ localPath: projectDir, title: "t" })
      const response = await fetch(
        `http://localhost:${server.port}/api/projects/${project.id}/paths?query=file&limit=2`,
      )
      const payload = await response.json() as { paths: Array<{ path: string }> }
      expect(payload.paths.length).toBe(2)
    } finally {
      await server.stop()
    }
  })
})
```

**Note:** Before writing the test, verify how existing tests set up the data directory — read `src/server/uploads.test.ts` around the `startKannaServer` call and mirror its pattern. If `KANNA_DATA_DIR` isn't the correct env var, check `src/shared/branding.ts` and `src/server/paths.ts` for the actual env var name. Adjust the test accordingly. Also verify how `store.openProject` signature looks — Grep for `openProject` in `src/server/event-store.ts`.

- [ ] **Step 2: Run failing tests**

Run: `bun test src/server/paths-route.test.ts`
Expected: FAIL — route returns 404 (fallthrough to static serve) for all requests.

- [ ] **Step 3: Implement handler**

Edit `src/server/server.ts`:

Add to imports at top:

```ts
import { listProjectPaths } from "./project-paths"
```

Add a new handler function after `handleProjectUploadDelete` (after line ~450):

```ts
async function handleProjectPaths(req: Request, url: URL, store: EventStore) {
  if (req.method !== "GET") return null
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/paths$/)
  if (!match) return null

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const query = url.searchParams.get("query") ?? ""
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined

  try {
    const paths = await listProjectPaths({
      projectId: project.id,
      localPath: project.localPath,
      query,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
    return Response.json({ paths })
  } catch (error) {
    console.error("[paths] list failed:", error)
    return Response.json({ error: "Failed to list paths" }, { status: 500 })
  }
}
```

Wire it into the request handler block (near line 228, next to `handleProjectFileContent`):

```ts
const projectPathsResponse = await handleProjectPaths(req, url, store)
if (projectPathsResponse) {
  return projectPathsResponse
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/server/paths-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.ts src/server/paths-route.test.ts
git commit -m "feat(server): add GET /api/projects/:id/paths route"
```

---

## Task 4 — Verify agent hint renders `kind="mention"`

**Files:**
- Modify: `src/server/agent.test.ts` (append a new test)

- [ ] **Step 1: Read the existing test to mirror its style**

Read: `src/server/agent.test.ts` lines 140-210 (the existing attachment-hint tests).

- [ ] **Step 2: Add failing test**

Append to `src/server/agent.test.ts` inside the existing describe block that covers `buildAttachmentHintText` (or create a new describe if none):

```ts
test("buildAttachmentHintText renders kind=\"mention\" attachments", () => {
  const prompt = buildAttachmentHintText([
    {
      id: "m1",
      kind: "mention",
      displayName: "src/agent.ts",
      absolutePath: "/tmp/project/src/agent.ts",
      relativePath: "./src/agent.ts",
      contentUrl: "",
      mimeType: "",
      size: 0,
    },
  ])
  expect(prompt).toContain("kind=\"mention\"")
  expect(prompt).toContain("path=\"/tmp/project/src/agent.ts\"")
  expect(prompt).toContain("project_path=\"./src/agent.ts\"")
})
```

- [ ] **Step 3: Run test**

Run: `bun test src/server/agent.test.ts`
Expected: PASS immediately — `buildAttachmentHintText` at `src/server/agent.ts:211-223` already emits `kind="${attachment.kind}"` unconditionally, so mentions flow through. This task exists to lock in that invariant.

If FAIL, check the imports at the top of `agent.test.ts` for `buildAttachmentHintText` and add it if missing.

- [ ] **Step 4: Commit**

```bash
git add src/server/agent.test.ts
git commit -m "test(agent): lock in kind=\"mention\" rendering in attachment hint"
```

---

## Task 5 — Client pure utils (`mention-suggestions.ts`)

**Files:**
- Create: `src/client/lib/mention-suggestions.ts`
- Create: `src/client/lib/mention-suggestions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/client/lib/mention-suggestions.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { applyMentionToInput, shouldShowMentionPicker } from "./mention-suggestions"

describe("shouldShowMentionPicker", () => {
  test("opens on bare @ at start", () => {
    expect(shouldShowMentionPicker("@", 1)).toEqual({ open: true, query: "", tokenStart: 0 })
  })

  test("opens on @src at start", () => {
    expect(shouldShowMentionPicker("@src", 4)).toEqual({ open: true, query: "src", tokenStart: 0 })
  })

  test("opens on @src after space", () => {
    expect(shouldShowMentionPicker("hi @src", 7)).toEqual({ open: true, query: "src", tokenStart: 3 })
  })

  test("opens after newline", () => {
    expect(shouldShowMentionPicker("hi\n@src", 7)).toEqual({ open: true, query: "src", tokenStart: 3 })
  })

  test("does not open on mid-word @ (email-like)", () => {
    expect(shouldShowMentionPicker("foo@bar", 7)).toEqual({ open: false, query: "", tokenStart: -1 })
  })

  test("does not open when caret before @", () => {
    expect(shouldShowMentionPicker("@src", 0)).toEqual({ open: false, query: "", tokenStart: -1 })
  })

  test("does not open after space breaks the token", () => {
    expect(shouldShowMentionPicker("@src foo", 8)).toEqual({ open: false, query: "", tokenStart: -1 })
  })

  test("does not open on empty input", () => {
    expect(shouldShowMentionPicker("", 0)).toEqual({ open: false, query: "", tokenStart: -1 })
  })
})

describe("applyMentionToInput", () => {
  test("replaces @query at start with @pickedPath", () => {
    const result = applyMentionToInput({
      value: "@src",
      caret: 4,
      tokenStart: 0,
      pickedPath: "src/agent.ts",
    })
    expect(result.value).toBe("@src/agent.ts")
    expect(result.caret).toBe("@src/agent.ts".length)
  })

  test("replaces mid-input token", () => {
    const result = applyMentionToInput({
      value: "hi @src tail",
      caret: 7,
      tokenStart: 3,
      pickedPath: "src/agent.ts",
    })
    expect(result.value).toBe("hi @src/agent.ts tail")
    expect(result.caret).toBe("hi @src/agent.ts".length)
  })

  test("preserves bare @ with empty query", () => {
    const result = applyMentionToInput({
      value: "@",
      caret: 1,
      tokenStart: 0,
      pickedPath: "README.md",
    })
    expect(result.value).toBe("@README.md")
    expect(result.caret).toBe("@README.md".length)
  })

  test("handles dir paths (trailing slash)", () => {
    const result = applyMentionToInput({
      value: "@src",
      caret: 4,
      tokenStart: 0,
      pickedPath: "src/",
    })
    expect(result.value).toBe("@src/")
    expect(result.caret).toBe("@src/".length)
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `bun test src/client/lib/mention-suggestions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/client/lib/mention-suggestions.ts`:

```ts
export interface MentionTrigger {
  open: boolean
  query: string
  tokenStart: number
}

const CLOSED: MentionTrigger = { open: false, query: "", tokenStart: -1 }

export function shouldShowMentionPicker(value: string, caret: number): MentionTrigger {
  if (caret <= 0) return CLOSED
  const upToCaret = value.slice(0, caret)

  let atIndex = -1
  for (let i = upToCaret.length - 1; i >= 0; i--) {
    const ch = upToCaret[i]
    if (ch === "@") { atIndex = i; break }
    if (ch === " " || ch === "\n" || ch === "\t") return CLOSED
  }
  if (atIndex === -1) return CLOSED

  const before = atIndex === 0 ? "" : upToCaret[atIndex - 1]
  if (before !== "" && before !== " " && before !== "\n" && before !== "\t") return CLOSED

  return { open: true, query: upToCaret.slice(atIndex + 1), tokenStart: atIndex }
}

export function applyMentionToInput(args: {
  value: string
  caret: number
  tokenStart: number
  pickedPath: string
}): { value: string; caret: number } {
  const before = args.value.slice(0, args.tokenStart)
  const after = args.value.slice(args.caret)
  const replacement = `@${args.pickedPath}`
  const nextValue = `${before}${replacement}${after}`
  const nextCaret = before.length + replacement.length
  return { value: nextValue, caret: nextCaret }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/client/lib/mention-suggestions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/client/lib/mention-suggestions.ts src/client/lib/mention-suggestions.test.ts
git commit -m "feat(client): add mention-suggestions trigger and apply utils"
```

---

## Task 6 — Client fetch hook (`useMentionSuggestions`)

**Files:**
- Create: `src/client/hooks/useMentionSuggestions.ts`
- Create: `src/client/hooks/useMentionSuggestions.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/client/hooks/useMentionSuggestions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fetchProjectPaths, type ProjectPath } from "./useMentionSuggestions"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("fetchProjectPaths", () => {
  test("requests the expected URL and returns paths", async () => {
    let receivedUrl: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      receivedUrl = typeof input === "string" ? input : input.toString()
      return new Response(
        JSON.stringify({ paths: [{ path: "a.ts", kind: "file" }] }),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const result = await fetchProjectPaths({ projectId: "p1", query: "a", signal: new AbortController().signal })
    expect(receivedUrl).toBe("/api/projects/p1/paths?query=a")
    expect(result).toEqual([{ path: "a.ts", kind: "file" }])
  })

  test("escapes query", async () => {
    let receivedUrl: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      receivedUrl = typeof input === "string" ? input : input.toString()
      return new Response(JSON.stringify({ paths: [] }), { headers: { "Content-Type": "application/json" } })
    }) as typeof fetch

    await fetchProjectPaths({ projectId: "p1", query: "a b/c", signal: new AbortController().signal })
    expect(receivedUrl).toBe("/api/projects/p1/paths?query=a+b%2Fc")
  })

  test("returns empty array on non-ok response", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch
    const result = await fetchProjectPaths({ projectId: "p1", query: "x", signal: new AbortController().signal })
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `bun test src/client/hooks/useMentionSuggestions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/client/hooks/useMentionSuggestions.ts`:

```ts
import { useEffect, useRef, useState } from "react"

export interface ProjectPath {
  path: string
  kind: "file" | "dir"
}

interface State {
  items: ProjectPath[]
  loading: boolean
  error: string | null
}

const DEBOUNCE_MS = 120

export async function fetchProjectPaths(args: {
  projectId: string
  query: string
  signal: AbortSignal
}): Promise<ProjectPath[]> {
  const params = new URLSearchParams({ query: args.query })
  try {
    const response = await fetch(`/api/projects/${args.projectId}/paths?${params.toString()}`, {
      signal: args.signal,
    })
    if (!response.ok) return []
    const payload = await response.json() as { paths?: ProjectPath[] }
    return payload.paths ?? []
  } catch {
    return []
  }
}

export function useMentionSuggestions(args: {
  projectId: string | null
  query: string
  enabled: boolean
}): State {
  const [state, setState] = useState<State>({ items: [], loading: false, error: null })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!args.enabled || !args.projectId) {
      setState({ items: [], loading: false, error: null })
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    abortRef.current?.abort()

    setState((s) => ({ ...s, loading: true, error: null }))
    const controller = new AbortController()
    abortRef.current = controller

    debounceRef.current = setTimeout(async () => {
      const items = await fetchProjectPaths({
        projectId: args.projectId!,
        query: args.query,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setState({ items, loading: false, error: null })
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      controller.abort()
    }
  }, [args.enabled, args.projectId, args.query])

  return state
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/client/hooks/useMentionSuggestions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/hooks/useMentionSuggestions.ts src/client/hooks/useMentionSuggestions.test.ts
git commit -m "feat(client): add useMentionSuggestions hook"
```

---

## Task 7 — `MentionPicker` component

**Files:**
- Create: `src/client/components/chat-ui/MentionPicker.tsx`

- [ ] **Step 1: Implement component**

Create `src/client/components/chat-ui/MentionPicker.tsx`:

```tsx
import { useEffect, useRef } from "react"
import { AtSign, Folder, FileText } from "lucide-react"
import type { ProjectPath } from "../../hooks/useMentionSuggestions"
import { cn } from "../../lib/utils"

interface MentionPickerProps {
  items: ProjectPath[]
  activeIndex: number
  loading: boolean
  onSelect: (path: ProjectPath) => void
  onHoverIndex: (index: number) => void
}

const SKELETON_ROWS = 4

export function MentionPicker({ items, activeIndex, loading, onSelect, onHoverIndex }: MentionPickerProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const el = listRef.current?.children.item(activeIndex) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (items.length === 0 && loading) {
    return (
      <ul
        aria-busy="true"
        aria-label="Loading file suggestions"
        className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl rounded-md border border-border bg-popover shadow-md overflow-hidden"
      >
        {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <li
            key={i}
            className="flex items-center gap-2 px-3 py-1.5"
            data-testid="mention-picker-skeleton-row"
          >
            <span className="h-3.5 w-3.5 rounded bg-muted animate-pulse" />
            <span className="h-3 w-40 max-w-full rounded bg-muted animate-pulse" />
          </li>
        ))}
      </ul>
    )
  }

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl rounded-md border border-border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        No matching files
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      className="absolute bottom-full left-0 mb-2 w-full max-w-md md:max-w-xl max-h-64 overflow-auto rounded-md border border-border bg-popover shadow-md"
    >
      {items.map((item, i) => {
        const Icon = item.kind === "dir" ? Folder : FileText
        return (
          <li
            key={`${item.kind}:${item.path}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(event) => {
              event.preventDefault()
              onSelect(item)
            }}
            onMouseEnter={() => onHoverIndex(i)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm",
              i === activeIndex && "bg-accent text-accent-foreground",
            )}
          >
            <AtSign className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono truncate">{item.path}</span>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/chat-ui/MentionPicker.tsx
git commit -m "feat(client): add MentionPicker component"
```

---

## Task 8 — Render mention attachments in `AttachmentCard`

**Files:**
- Modify: `src/client/components/messages/AttachmentCard.tsx`

- [ ] **Step 1: Read existing file**

Read `src/client/components/messages/AttachmentCard.tsx` end to end so you understand the existing `AttachmentFileCard` shape.

- [ ] **Step 2: Add mention branch**

Modify `AttachmentFileCard` (around line 90-118) so mentions render without the size/mime line (they're always zero/empty). Replace the body text block:

```tsx
        <div className="min-w-0">
          <div className="max-w-[150px] truncate text-[13px] font-medium text-foreground">{attachment.displayName}</div>
          {attachment.kind === "mention" ? (
            <div className="truncate text-[11px] text-muted-foreground">
              @mention
            </div>
          ) : (
            <div className="truncate text-[11px] text-muted-foreground">
              {attachment.mimeType} · {formatAttachmentSize(attachment.size)}
            </div>
          )}
        </div>
```

Also, for mentions, swap the icon: update `getAttachmentIcon` call site (near the top of `AttachmentFileCard`) to special-case mentions:

Find the line that computes `Icon = getAttachmentIcon(classifyAttachmentIcon(attachment))`. Before it, add:

```tsx
  const iconKind: AttachmentIconKind = attachment.kind === "mention" ? "text" : classifyAttachmentIcon(attachment)
  const Icon = getAttachmentIcon(iconKind)
```

And replace the existing `Icon` computation with the two lines above (delete the original). Import `AttachmentIconKind` if it isn't already imported (line 18 should already have `type AttachmentIconKind`).

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/messages/AttachmentCard.tsx
git commit -m "feat(client): render \"mention\" attachments without mime/size metadata"
```

---

## Task 9 — Wire `MentionPicker` into `ChatInput`

**Files:**
- Modify: `src/client/components/chat-ui/ChatInput.tsx`
- Modify: `src/client/components/chat-ui/ChatInput.test.ts`

- [ ] **Step 1: Read the current `ChatInput.tsx` handleKeyDown and render sections**

Re-read `src/client/components/chat-ui/ChatInput.tsx` lines 220-260 (state block) and 606-660 (keyboard) and 762-770 (picker render). Your wiring should mirror the slash picker but use mention state.

- [ ] **Step 2: Add mention state (above the existing slash-picker state)**

Inside the `ChatInputInner` body, add imports at the top of the file:

```tsx
import { MentionPicker } from "./MentionPicker"
import { shouldShowMentionPicker, applyMentionToInput } from "../../lib/mention-suggestions"
import { useMentionSuggestions, type ProjectPath } from "../../hooks/useMentionSuggestions"
```

Add new state alongside the slash-picker state (near lines 229-231):

```tsx
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)

  const mentionTrigger = useMemo(
    () => shouldShowMentionPicker(value, caret),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, caret, caretVersion],
  )
  const mentionState = useMentionSuggestions({
    projectId: projectId ?? null,
    query: mentionTrigger.query,
    enabled: mentionTrigger.open && !mentionDismissed,
  })
  const mentionOpen =
    mentionTrigger.open &&
    !mentionDismissed &&
    !pickerOpen &&
    (mentionState.items.length > 0 || mentionState.loading)

  useEffect(() => {
    if (mentionOpen) setMentionIndex(0)
  }, [mentionOpen, mentionTrigger.query])

  useEffect(() => {
    // Reset dismissed flag when the user edits past the current token
    if (!mentionTrigger.open) setMentionDismissed(false)
  }, [mentionTrigger.open, mentionTrigger.tokenStart])
```

- [ ] **Step 3: Add accept helper**

Add inside `ChatInputInner`, next to `acceptCommand`:

```tsx
  function acceptMention(item: ProjectPath) {
    if (!projectId) {
      setMentionDismissed(true)
      return
    }
    const { value: nextValue, caret: nextCaret } = applyMentionToInput({
      value,
      caret,
      tokenStart: mentionTrigger.tokenStart,
      pickedPath: item.path,
    })
    setValue(nextValue)
    if (chatId) setDraft(chatId, nextValue)

    const relativeForAttachment = item.path.endsWith("/") ? item.path.slice(0, -1) : item.path
    const absolutePath = `${projectId ? "" : ""}` // placeholder; actual absolute path comes from the server-side render via relativePath
    const alreadyMentioned = attachments.some(
      (a) => a.kind === "mention" && a.relativePath === `./${relativeForAttachment}`,
    )
    if (!alreadyMentioned) {
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: "mention",
          displayName: relativeForAttachment,
          absolutePath: "",
          relativePath: `./${relativeForAttachment}`,
          contentUrl: "",
          mimeType: "",
          size: 0,
          status: "uploaded",
        },
      ])
    }
    setMentionDismissed(true)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
    })
  }
```

**Note on `absolutePath`:** The mention attachment is sent to the server with only `relativePath`; the server resolves to absolute via `project.localPath` in a follow-up task if needed. For v1 leave `absolutePath` empty and let the server fill it. If `buildAttachmentHintText` renders an empty `path=""` attribute, the agent gets the `project_path` which is sufficient for Read to work. If you need stricter behavior, extend the agent.ts submit path to fill `absolutePath = path.join(project.localPath, relativePath.slice(2))` before building the hint — see Task 9.5 optional.

- [ ] **Step 4: Intercept mention keys in `handleKeyDown`**

Place this block at the top of `handleKeyDown`, **before** the existing slash-picker `if (pickerOpen)` check:

```tsx
    if (mentionOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setMentionIndex((i) => Math.min(mentionState.items.length - 1, i + 1))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setMentionIndex((i) => Math.max(0, i - 1))
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        const item = mentionState.items[mentionIndex]
        if (item) acceptMention(item)
        return
      }
    }
```

- [ ] **Step 5: Render the picker**

Inside the JSX where `SlashCommandPicker` is rendered (around line 763), add a sibling:

```tsx
            {mentionOpen && (
              <MentionPicker
                items={mentionState.items}
                activeIndex={mentionIndex}
                loading={mentionState.loading}
                onSelect={acceptMention}
                onHoverIndex={setMentionIndex}
              />
            )}
```

Place it as a sibling of `SlashCommandPicker` so both live inside the same relative container and float above the textarea.

- [ ] **Step 6: Write failing ChatInput tests**

Append to `src/client/components/chat-ui/ChatInput.test.ts`:

```ts
describe("mention picker wiring", () => {
  test("shouldShowMentionPicker trigger flows through into pickerOpen selection", () => {
    // Unit test for the composition — pure logic
    const { shouldShowMentionPicker } = require("../../lib/mention-suggestions")
    expect(shouldShowMentionPicker("hello @src", 10)).toEqual({
      open: true,
      query: "src",
      tokenStart: 6,
    })
  })
})
```

This is the minimum assertion that the wiring contract holds. The full integration test (typing `@` → picker appears → enter → attachment added) requires a React render harness; since existing chat-ui tests are mostly pure-function style, defer full integration to manual verification in Task 10. If the existing file already uses `@testing-library/react`, add a render-based test:

```ts
// only add if render harness exists
test("typing @ opens the mention picker", async () => {
  // ... render ChatInput with chatId="c1", projectId="p1"
  // ... mock /api/projects/p1/paths to return [{ path: "src/a.ts", kind: "file" }]
  // ... userEvent.type(textarea, "@")
  // ... expect rendered role="listbox" with that row
})
```

- [ ] **Step 7: Run tests**

Run: `bun test src/client/components/chat-ui/ChatInput.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + build**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/client/components/chat-ui/ChatInput.tsx src/client/components/chat-ui/ChatInput.test.ts
git commit -m "feat(chat-ui): wire @ mention picker into ChatInput"
```

---

## Task 9.5 (Optional) — Server fills `absolutePath` for mention attachments

**Files:**
- Modify: `src/server/agent.ts` (or wherever `ChatAttachment[]` is normalized before `buildAttachmentHintText`)

**When to do this:** Only if manual verification (Task 10) shows that the agent doesn't read mentioned files reliably with `absolutePath=""`.

- [ ] **Step 1: Locate the attachment normalization call site**

Grep for `buildAttachmentHintText(` in `src/server/agent.ts`. You'll find 1-2 call sites in the send path.

- [ ] **Step 2: Add server-side fill**

Before calling `buildAttachmentHintText`, map mentions to have absolute paths:

```ts
const filledAttachments = attachments.map((attachment) => {
  if (attachment.kind !== "mention" || attachment.absolutePath) return attachment
  const relative = attachment.relativePath.startsWith("./")
    ? attachment.relativePath.slice(2)
    : attachment.relativePath
  return {
    ...attachment,
    absolutePath: path.resolve(project.localPath, relative),
  }
})
```

Pass `filledAttachments` into `buildAttachmentHintText` instead of the raw `attachments`.

- [ ] **Step 3: Extend existing agent test**

Add to `src/server/agent.test.ts`:

```ts
test("mention attachments get server-filled absolutePath", () => {
  // Construct a minimal test that passes a mention attachment with empty
  // absolutePath into whichever exported function handles send-path
  // normalization. Assert the rendered prompt contains the resolved path.
})
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/server/agent.test.ts && bun run check`

- [ ] **Step 5: Commit**

```bash
git add src/server/agent.ts src/server/agent.test.ts
git commit -m "feat(agent): resolve absolutePath for mention attachments server-side"
```

---

## Task 10 — Manual verification

- [ ] **Step 1: Start dev server**

```bash
bun run dev
```

- [ ] **Step 2: Verify behaviors**

Open a Kanna chat on a git project:

1. Type `@` at the start — picker opens with top-level entries (files and dirs).
2. Type `@src` — picker fuzzy-filters to entries starting with `src`.
3. `↑` / `↓` navigate, `Enter` accepts — input becomes `@src/agent.ts`, attachment chip appears.
4. `Esc` while picker open — picker closes, input preserved.
5. Type `foo@bar` (mid-word `@`) — picker does NOT open.
6. Type `/` at start — slash picker opens, `@` picker does NOT fight for focus.
7. Send the message. In the transcript, confirm the attachment chip renders. Check server logs (or hydrated prompt) contain `<attachment kind="mention" ... />`.
8. Confirm the agent responds to the referenced file (Claude calls Read on it, or Codex acknowledges the path).
9. Open a Codex chat and repeat step 1-3. Picker should work the same.
10. Open a chat on a non-git directory. Picker still returns paths (readdir walk).

- [ ] **Step 3: If any step fails**

Invoke the `superpowers:systematic-debugging` skill. Do not skip.

- [ ] **Step 4: Stop dev server**

`Ctrl+C`.

---

## Task 11 — Final verification + PR prep

- [ ] **Step 1: Full check + test**

```bash
bun run check
bun test
```

Both: PASS.

- [ ] **Step 2: Commit any incidental formatting**

If any files changed from save-on-format, commit with `chore: format`. Otherwise skip.

- [ ] **Step 3: Push branch**

```bash
git push -u origin feature/at-mention-picker
```

- [ ] **Step 4: Report completion**

Announce: branch `feature/at-mention-picker`, all tasks complete, tests green. Offer to run `superpowers:finishing-a-development-branch` for merge / PR path.

---

## Skills to consult

- `superpowers:test-driven-development` — every task that touches logic.
- `superpowers:systematic-debugging` — if anything misbehaves in Task 10.
- `superpowers:verification-before-completion` — before announcing Task 11 done.
- `superpowers:finishing-a-development-branch` — after Task 11.
