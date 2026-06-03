# Auto-surface Created Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent creates a deliverable artifact file via the `Write` tool, the chat automatically shows a clickable inline preview/download card — no user prompt or model `offer_download` call needed.

**Architecture:** Pure client-side rendering in the transcript. A new artifact predicate + client MIME inference decide whether a successful `write_file` tool result renders an `InlinePreviewCard` (reusing the existing preview infra). `projectId` is threaded from `ChatPage` to `ToolCallMessage` to build the file content URL. No server or model changes.

**Tech Stack:** React 19, TypeScript, Zustand, Bun test, Tailwind. Repo: `cuongtranba/kanna` (fork). PR base `main`.

---

## File Structure

- `src/client/components/messages/attachmentPreview.ts` — add two pure helpers: `inferMimeFromFileName(fileName)` and `isArtifactWrite(fileName, mimeType?)`. Colocated test file.
- `src/client/components/messages/ToolCallMessage.tsx` — accept a `projectId` prop; on successful in-root artifact `write_file`, render an `InlinePreviewCard` + `FilePreviewSheet` under the tool row.
- `src/client/app/KannaTranscript.tsx` — thread `projectId` through the row renderers to `ToolCallMessage` (mirror every existing `localPath` occurrence).
- `src/client/app/ChatPage/ChatTranscriptViewport.tsx` — add `projectId` prop + carry it in the render-data memo (mirror `localPath`).
- `src/client/app/ChatPage/index.tsx` — pass `state.activeProjectId` into `ChatTranscriptViewport`.

---

## Task 0: Worktree + C3 ADR (prep)

**Files:** none (setup only)

- [ ] **Step 1: Create the worktree** (user chose git worktree)

Use the `superpowers:using-git-worktrees` skill, branch name `feat/auto-surface-artifacts`. All subsequent file paths are relative to the worktree root.

- [ ] **Step 2: Open a C3 ADR for the change**

Run (from worktree root):
```bash
C3X_MODE=agent bash ~/.claude/skills/c3/bin/c3x.sh schema adr
```
Then `c3x add adr auto-surface-artifacts` with a body covering the design (see `docs/superpowers/specs/2026-06-03-auto-surface-created-artifacts-design.md`). Mark Parent Delta for component `c3-115` (chat-ui) / the messages component that owns `ToolCallMessage`. Set `status: accepted` before implementation.

---

## Task 1: `inferMimeFromFileName` helper

**Files:**
- Modify: `src/client/components/messages/attachmentPreview.ts`
- Test: `src/client/components/messages/attachmentPreview.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `attachmentPreview.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { inferMimeFromFileName } from "./attachmentPreview"

describe("inferMimeFromFileName", () => {
  it("maps image extensions", () => {
    expect(inferMimeFromFileName("a.png")).toBe("image/png")
    expect(inferMimeFromFileName("a.JPG")).toBe("image/jpeg")
    expect(inferMimeFromFileName("a.svg")).toBe("image/svg+xml")
    expect(inferMimeFromFileName("a.webp")).toBe("image/webp")
  })
  it("maps doc + data extensions", () => {
    expect(inferMimeFromFileName("a.pdf")).toBe("application/pdf")
    expect(inferMimeFromFileName("a.csv")).toBe("text/csv")
    expect(inferMimeFromFileName("a.tsv")).toBe("text/tab-separated-values")
    expect(inferMimeFromFileName("a.html")).toBe("text/html")
  })
  it("maps archives + media", () => {
    expect(inferMimeFromFileName("a.zip")).toBe("application/zip")
    expect(inferMimeFromFileName("a.mp4")).toBe("video/mp4")
    expect(inferMimeFromFileName("a.mp3")).toBe("audio/mpeg")
  })
  it("falls back to octet-stream for unknown", () => {
    expect(inferMimeFromFileName("a.unknownext")).toBe("application/octet-stream")
    expect(inferMimeFromFileName("noext")).toBe("application/octet-stream")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/client/components/messages/attachmentPreview.test.ts`
Expected: FAIL — `inferMimeFromFileName` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `attachmentPreview.ts` (uses the existing private `getFileExtension`):
```ts
const MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".tgz", "application/gzip"],
  [".tar", "application/x-tar"],
  [".7z", "application/x-7z-compressed"],
  [".rar", "application/vnd.rar"],
  [".bz2", "application/x-bzip2"],
  [".xz", "application/x-xz"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".aac", "audio/aac"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
])

export function inferMimeFromFileName(fileName: string): string {
  const extension = getFileExtension(fileName)
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/client/components/messages/attachmentPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/messages/attachmentPreview.ts src/client/components/messages/attachmentPreview.test.ts
git commit -m "feat(messages): add inferMimeFromFileName helper"
```

---

## Task 2: `isArtifactWrite` predicate

**Files:**
- Modify: `src/client/components/messages/attachmentPreview.ts`
- Test: `src/client/components/messages/attachmentPreview.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `attachmentPreview.test.ts`:
```ts
import { isArtifactWrite } from "./attachmentPreview"

describe("isArtifactWrite", () => {
  it("treats deliverable types as artifacts", () => {
    for (const name of ["chart.png", "out.svg", "report.pdf", "data.csv", "rows.tsv", "mock.html", "bundle.zip", "demo.mp4", "voice.mp3", "sheet.xlsx"]) {
      expect(isArtifactWrite(name)).toBe(true)
    }
  })
  it("treats source/config/docs as non-artifacts", () => {
    for (const name of ["index.ts", "App.tsx", "main.go", "style.css", "config.yaml", "notes.md", "data.json", "log.txt"]) {
      expect(isArtifactWrite(name)).toBe(false)
    }
  })
  it("treats unknown binary as artifact", () => {
    expect(isArtifactWrite("model.bin")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/client/components/messages/attachmentPreview.test.ts`
Expected: FAIL — `isArtifactWrite` not exported.

- [ ] **Step 3: Implement the predicate**

Add to `attachmentPreview.ts`. The rule: artifact = any file whose inferred MIME is non-text deliverable OR whose extension is an explicit artifact override (`.html`/`.svg`), EXCLUDING source/config/markdown/json/txt. Implemented as an explicit non-artifact denylist plus the artifact MIME check, so unknown binaries default to artifact:
```ts
const NON_ARTIFACT_EXTENSIONS = new Set<string>([
  ...CODE_OR_CONFIG_EXTENSIONS, // .ts/.tsx/.go/.css/.html/... (note: .html overridden below)
  ".md", ".json", ".jsonc",
])

// Extensions that are code-ish by classification but are deliverables in practice.
const ARTIFACT_EXTENSION_OVERRIDES = new Set<string>([".html", ".htm", ".svg"])

export function isArtifactWrite(fileName: string, mimeType?: string): boolean {
  const extension = getFileExtension(fileName)
  if (ARTIFACT_EXTENSION_OVERRIDES.has(extension)) return true
  if (NON_ARTIFACT_EXTENSIONS.has(extension)) return false

  const mime = (mimeType ?? inferMimeFromFileName(fileName)).toLowerCase()
  if (mime.startsWith("image/")) return true
  if (mime.startsWith("audio/")) return true
  if (mime.startsWith("video/")) return true
  if (mime === "application/pdf") return true
  if (mime === "text/csv" || mime === "text/tab-separated-values") return true
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("compressed") || mime === "application/gzip" || mime === "application/x-xz" || mime === "application/x-bzip2" || mime === "application/vnd.rar") return true
  if (mime.startsWith("application/vnd.openxmlformats-officedocument")) return true
  if (mime === "application/octet-stream") return true // unknown binary -> downloadable artifact

  return false
}
```
Note: `.html`/`.svg` are removed from the effective non-artifact set by the override check running first. `.txt` is in `CODE_OR_CONFIG_EXTENSIONS` → non-artifact. Keep `inferMimeFromFileName` defined above this function in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/client/components/messages/attachmentPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/messages/attachmentPreview.ts src/client/components/messages/attachmentPreview.test.ts
git commit -m "feat(messages): add isArtifactWrite predicate"
```

---

## Task 3: Thread `projectId` to `ToolCallMessage` (no behavior yet)

**Files:**
- Modify: `src/client/app/ChatPage/index.tsx`
- Modify: `src/client/app/ChatPage/ChatTranscriptViewport.tsx`
- Modify: `src/client/app/KannaTranscript.tsx`
- Modify: `src/client/components/messages/ToolCallMessage.tsx`

This task is mechanical prop-threading. The rule: **mirror every existing `localPath` occurrence with a sibling `projectId: string | null`** in these files — same prop interfaces, same memo dependency arrays, same memo equality comparisons, same pass-through call sites. Default `projectId` to `null`.

- [ ] **Step 1: `ToolCallMessage` accepts the prop**

In `ToolCallMessage.tsx`, extend `Props`:
```ts
interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
  projectId?: string | null
}
```
And destructure it in the signature:
```ts
export function ToolCallMessage({ message, isLoading = false, localPath, projectId = null }: Props) {
```
(No use yet — referenced in Task 4. To avoid an unused-var lint error in this intermediate commit, complete Task 4 before running lint, OR fold Tasks 3+4 into one commit. Recommended: commit Tasks 3 and 4 together.)

- [ ] **Step 2: Thread through `KannaTranscript.tsx`**

For every `localPath` occurrence (props interfaces, `memo` equality functions, render-data, and the two `<ToolCallMessage ... localPath={localPath} />` sites at the SDK + fallback branches), add a parallel `projectId`. The two `ToolCallMessage` render sites become:
```tsx
<ToolCallMessage key={message.id} message={message} isLoading={isLoading} localPath={localPath} projectId={projectId} />
```
Add `projectId?: string | null` to each Props/interface that already declares `localPath?: string`, include it in `memo` comparator equality (`prev.projectId === next.projectId`), and in any `useMemo` dependency array that lists `localPath`.

- [ ] **Step 3: Thread through `ChatTranscriptViewport.tsx`**

Add `projectId: string | null` to `ChatTranscriptViewportProps`, destructure it, add it to the render-data `useMemo` (alongside `localPath`) and its dependency array, and pass it down wherever `localPath` is passed to the row renderers.

- [ ] **Step 4: Pass `activeProjectId` from `ChatPage/index.tsx`**

At the `<ChatTranscriptViewport ... />` render site, add `projectId={projectId}` (the local `const projectId = state.activeProjectId`).

- [ ] **Step 5: Type-check + lint**

Run: `bun run lint`
Expected: no errors (provided Task 4 is in the same commit so `projectId` is used).

- [ ] **Step 6: (defer commit to Task 4 — combined)**

---

## Task 4: Render the artifact card in `ToolCallMessage`

**Files:**
- Modify: `src/client/components/messages/ToolCallMessage.tsx`
- Test: `src/client/components/messages/ToolCallMessage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add cases to `ToolCallMessage.test.tsx` (follow the existing render harness in that file). Build a `ProcessedToolCall` for `write_file`:

```tsx
import { render, screen } from "@testing-library/react"
import { ToolCallMessage } from "./ToolCallMessage"

function writeCall(filePath: string, isError = false) {
  return {
    // shape per ProcessedToolCall; mirror an existing write_file fixture in this test file
    id: "t1",
    toolId: "t1",
    toolName: "Write",
    toolKind: "write_file",
    input: { filePath, content: "x" },
    result: isError ? undefined : { content: `File created successfully at: ${filePath}` },
    isError,
  } as unknown as Parameters<typeof ToolCallMessage>[0]["message"]
}

const ROOT = "/Users/dev/proj"

it("renders an artifact card for an in-root png write", () => {
  render(<ToolCallMessage message={writeCall(`${ROOT}/out/chart.png`)} localPath={ROOT} projectId="p1" />)
  expect(screen.getByTestId("artifact-write-card")).toBeTruthy()
})

it("renders an artifact card for an in-root html write", () => {
  render(<ToolCallMessage message={writeCall(`${ROOT}/mock.html`)} localPath={ROOT} projectId="p1" />)
  expect(screen.getByTestId("artifact-write-card")).toBeTruthy()
})

it("does NOT render a card for a source .ts write", () => {
  render(<ToolCallMessage message={writeCall(`${ROOT}/src/index.ts`)} localPath={ROOT} projectId="p1" />)
  expect(screen.queryByTestId("artifact-write-card")).toBeNull()
})

it("does NOT render a card for an out-of-root path", () => {
  render(<ToolCallMessage message={writeCall(`/tmp/chart.png`)} localPath={ROOT} projectId="p1" />)
  expect(screen.queryByTestId("artifact-write-card")).toBeNull()
})

it("does NOT render a card when projectId is missing", () => {
  render(<ToolCallMessage message={writeCall(`${ROOT}/out/chart.png`)} localPath={ROOT} projectId={null} />)
  expect(screen.queryByTestId("artifact-write-card")).toBeNull()
})

it("does NOT render a card for a failed write", () => {
  render(<ToolCallMessage message={writeCall(`${ROOT}/out/chart.png`, true)} localPath={ROOT} projectId="p1" />)
  expect(screen.queryByTestId("artifact-write-card")).toBeNull()
})
```
If the existing test file already has a `write_file` fixture factory, reuse it instead of redefining `writeCall`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/client/components/messages/ToolCallMessage.test.tsx`
Expected: FAIL — no element with testid `artifact-write-card`.

- [ ] **Step 3: Implement the card**

In `ToolCallMessage.tsx`:

Imports:
```ts
import { useState } from "react"
import { isArtifactWrite, inferMimeFromFileName } from "./attachmentPreview"
import { buildProjectFileContentUrl } from "../../../shared/projectFileUrl"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { InlinePreviewCard } from "./file-preview/InlinePreviewCard"
import { FilePreviewSheet } from "./file-preview/FilePreviewSheet"
import type { PreviewSource } from "./file-preview/types"
```
(`stripWorkspacePath` is already imported; do not duplicate.)

Add a small pure helper near the top of the module (module scope, stable reference):
```ts
function buildArtifactPreviewSource(
  filePath: string,
  localPath: string | null | undefined,
  projectId: string | null,
): PreviewSource | null {
  if (!projectId || !filePath) return null
  const relativePath = stripWorkspacePath(filePath, localPath)
  // stripWorkspacePath returns an absolute path (leading "/") when filePath is
  // outside the project root, and "" when it equals the root.
  if (!relativePath || relativePath.startsWith("/")) return null
  const fileName = relativePath.split("/").pop() || relativePath
  if (!isArtifactWrite(fileName)) return null
  const contentUrl = buildProjectFileContentUrl(projectId, relativePath)
  if (!contentUrl) return null
  return {
    id: `artifact-write-${projectId}-${relativePath}`,
    contentUrl,
    displayName: fileName,
    fileName,
    relativePath,
    mimeType: inferMimeFromFileName(fileName),
    origin: "local_file_link",
  }
}
```

Inside the component, after `const isWriteTool = ...` and before the return, compute the source and preview state:
```ts
const artifactSource = useMemo(
  () =>
    isWriteTool && !message.isError
      ? buildArtifactPreviewSource(message.input.filePath, localPath, projectId)
      : null,
  [isWriteTool, message.isError, message.input, localPath, projectId],
)
const [artifactPreviewOpen, setArtifactPreviewOpen] = useState(false)
```

Render the card after the `</ExpandableRow>`/`</MetaRow>` wrapper — wrap the existing return in a fragment so the card sits directly under the tool row:
```tsx
return (
  <>
    <MetaRow className="w-full">
      {/* ...existing ExpandableRow unchanged... */}
    </MetaRow>
    {artifactSource ? (
      <div className="mt-1 pl-7" data-testid="artifact-write-card">
        <InlinePreviewCard
          source={artifactSource}
          variant="compact"
          onOpen={() => setArtifactPreviewOpen(true)}
        />
        <FilePreviewSheet
          source={artifactPreviewOpen ? artifactSource : null}
          open={artifactPreviewOpen}
          onOpenChange={setArtifactPreviewOpen}
        />
      </div>
    ) : null}
  </>
)
```
Keep the existing `MetaRow`/`ExpandableRow` block exactly as-is inside the fragment.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/client/components/messages/ToolCallMessage.test.tsx`
Expected: PASS (all six cases).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors, no new warnings (cap unchanged).

- [ ] **Step 6: Commit (Tasks 3 + 4 together)**

```bash
git add src/client/app/ChatPage/index.tsx src/client/app/ChatPage/ChatTranscriptViewport.tsx src/client/app/KannaTranscript.tsx src/client/components/messages/ToolCallMessage.tsx src/client/components/messages/ToolCallMessage.test.tsx
git commit -m "feat(messages): auto-surface inline card for created artifacts"
```

---

## Task 5: Render-loop regression check

**Files:**
- Test: `src/client/components/messages/ToolCallMessage.loop.test.tsx` (create)

- [ ] **Step 1: Write the loop test**

Use `renderForLoopCheck` from `src/client/lib/testing/`:
```tsx
import { renderForLoopCheck } from "../../lib/testing"
import { ToolCallMessage } from "./ToolCallMessage"

it("does not trigger a render loop for an artifact write", () => {
  const { loopDetected } = renderForLoopCheck(
    <ToolCallMessage
      message={/* in-root png write fixture, see ToolCallMessage.test.tsx */}
      localPath="/Users/dev/proj"
      projectId="p1"
    />,
  )
  expect(loopDetected).toBe(false)
})
```
Import the exact `renderForLoopCheck` signature from the testing lib (check `src/client/lib/testing/` for the actual export + return shape; adapt the assertion to it).

- [ ] **Step 2: Run + verify pass**

Run: `bun test src/client/components/messages/ToolCallMessage.loop.test.tsx`
Expected: PASS, no React error #185 warnings.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/messages/ToolCallMessage.loop.test.tsx
git commit -m "test(messages): render-loop check for artifact write card"
```

---

## Task 6: Visual polish (impeccable)

**Files:**
- Modify: `src/client/components/messages/ToolCallMessage.tsx` (card wrapper styles only)

- [ ] **Step 1: Run the impeccable skill** on the artifact card region — verify spacing/indent aligns with sibling message cards (`OfferDownloadMessage`, attachment cards), consistent border-radius, hover affordance, and dark-mode tokens. Apply only token/spacing tweaks; no logic change.

- [ ] **Step 2: Re-run lint + the ToolCallMessage tests**

Run: `bun run lint && bun test src/client/components/messages/ToolCallMessage.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/messages/ToolCallMessage.tsx
git commit -m "style(messages): polish artifact write card"
```

---

## Task 7: C3 doc sync + full verification + PR

**Files:** `.c3/` (via c3x only), no source change unless `c3x check` flags drift.

- [ ] **Step 1: C3 change/check**

Run:
```bash
C3X_MODE=agent bash ~/.claude/skills/c3/bin/c3x.sh check
```
Resolve any drift; transition the Task 0 ADR to `status: implemented`. Record the Parent Delta for the messages component.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all pass (CI blocks on failure).

- [ ] **Step 3: Lint gate**

Run: `bun run lint`
Expected: 0 errors, warnings ≤ cap.

- [ ] **Step 4: Manual verification**

Use the `verify` or `run` skill: launch Kanna, have the agent write a `.png` and a `.html` into the project root, confirm the inline card appears under the Write row and opens the preview sheet on click; confirm a `.ts` write shows no card.

- [ ] **Step 5: Open PR**

```bash
git push -u origin feat/auto-surface-artifacts
gh pr create --repo cuongtranba/kanna --base main --head feat/auto-surface-artifacts \
  --title "feat: auto-surface created artifacts in chat" \
  --body "Auto-renders an inline preview/download card under the Write tool row when the agent creates a deliverable artifact (image/pdf/csv/html/svg/archive/office/media) inside the project root. Source-code writes are unchanged. Fixes the dead-end UX from session 41ac9f27. Spec: docs/superpowers/specs/2026-06-03-auto-surface-created-artifacts-design.md"
```

---

## Self-Review notes

- **Spec coverage:** isArtifactWrite (Task 2) ✓; inline card + in-root + projectId guards (Task 4) ✓; projectId threading (Task 3) ✓; out-of-scope Gap B not implemented (intentional) ✓; tests incl. render-loop (Tasks 1,2,4,5) ✓.
- **Type consistency:** `isArtifactWrite(fileName, mimeType?)`, `inferMimeFromFileName(fileName)`, `buildArtifactPreviewSource(filePath, localPath, projectId)`, `PreviewSource` shape, `InlinePreviewCard` props (`source`, `onOpen`, `variant`) all match definitions used in Task 4.
- **Open verification for executor:** confirm the exact `ProcessedToolCall` write_file fixture shape from the existing `ToolCallMessage.test.tsx`, and the `renderForLoopCheck` export signature — adapt the two test stubs to the real shapes (they are stubs, not invented APIs).
