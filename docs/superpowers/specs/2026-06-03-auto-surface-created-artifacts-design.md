# Auto-surface created artifacts in chat

**Date:** 2026-06-03
**Status:** Approved (design)
**Source bug:** Kanna session `41ac9f27-e88d-4f7b-ba08-88d4f45ed370`

## Problem

When the agent creates a file via the `Write` tool, the chat UI surfaces
nothing actionable — the write renders only as a collapsed
`Write <path>` tool row. The user cannot view or download the created
file without explicitly asking for it.

Observed in session `41ac9f27` transcript:

- idx 154 — agent `Write` creates `token-usage-mock.html` (an HTML
  mockup deliverable). UI shows only the collapsed tool row.
- idx 165 — user must ask: *"give me that file"*.
- idx 167–178 — agent then copies the file into project root and calls
  `mcp__kanna__offer_download` to produce a download chip.
- idx 180 — user still says *"i dont see that file"*.

File creation is a dead-end: the user has to notice the buried tool row,
realize a file exists, and ask for it. Bad workflow.

## Goal

When the agent creates a **deliverable artifact**, the chat
automatically shows a clickable preview/download card inline — no user
prompt, no model `offer_download` call required.

## Decisions (confirmed with user)

1. **Trigger scope — artifacts only.** Auto-surfacing every successful
   `Write` would spam the chat during normal coding (the agent writes
   many source files per turn). Only non-source deliverable files
   surface a card. Source code stays as the normal collapsed tool row.
2. **Affordance — inline card.** Render a clickable card directly under
   the tool row. Image artifacts show an inline thumbnail; other types
   show a file card. Click opens the existing `FilePreviewSheet`. No
   auto-popup modal — non-intrusive, always visible.

## Approach

Fully deterministic client-side rendering. Zero model involvement, zero
token cost. Reuses existing preview infrastructure
(`InlinePreviewCard`, `FilePreviewSheet`, `buildProjectFileContentUrl`).

### Component 1 — `isArtifactWrite(fileName, mimeType)` predicate

A new pure helper that classifies whether a written file is a deliverable
artifact worth surfacing.

- **What it does:** returns `true` for files whose primary value is to be
  viewed or downloaded as output, `false` for source/config that is
  edited as code.
- **How to use it:** `isArtifactWrite(displayName, mimeType)` → `boolean`.
- **Depends on:** file extension + MIME string only. Pure, no IO.

**TRUE (artifact):**
- `image/*`
- `application/pdf` / `.pdf`
- `text/csv`, `text/tab-separated-values` / `.csv`, `.tsv`
- archives (`.zip`, `.tar`, `.gz`, `.tgz`, `.7z`, `.rar`, `.bz2`, `.xz`)
- `audio/*`, `video/*`
- `.html`, `.svg`
- office docs (`.docx`, `.xlsx`, `.pptx`)
- unknown binary (the existing `classifyAttachmentPreview` "external"
  bucket)

**FALSE (stays collapsed):**
- source/config: `.ts`, `.tsx`, `.go`, `.py`, `.css`, `.scss`, `.yaml`,
  `.toml`, etc.
- `.txt`, `.md`, `.json`

**Note on `.html` / `.svg`:** these live in the existing
`CODE_OR_CONFIG_EXTENSIONS` set in `attachmentPreview.ts`, so
`classifyAttachmentIcon` buckets them as `code`. The artifact predicate
is a **separate allowlist that overrides** that classification — the
session's `token-usage-mock.html` is exactly the kind of deliverable the
user wants surfaced. This is why we do NOT reuse the icon classifier as
the trigger.

**Location:** colocate in
`src/client/components/messages/attachmentPreview.ts` next to the sibling
classifiers, with a colocated unit test.

### Component 2 — artifact card in `ToolCallMessage`

In `src/client/components/messages/ToolCallMessage.tsx`, when ALL hold:

- `message.toolKind === "write_file"`
- `!message.isError` (write succeeded)
- `isArtifactWrite(fileName, mimeType)` is true
- the written absolute path resolves **inside the project root**

…render an `InlinePreviewCard` under the existing tool row:

- Compute the project-relative path from `message.input.filePath` and
  `localPath`.
- Build the content URL with
  `buildProjectFileContentUrl(projectId, relativePath)`.
- Construct a `PreviewSource` and render `InlinePreviewCard`
  (`variant="compact"`); click opens `FilePreviewSheet` via local
  `previewOpen` state, mirroring `OfferDownloadMessage`.

**Skip the card (unchanged collapsed row) when:**

- write failed,
- not an artifact,
- the absolute path is **outside** the project root (e.g. `/tmp`) — the
  file-serving route only serves in-root project files, so no servable
  URL exists,
- `projectId` is unavailable.

MIME is inferred client-side from the file extension (no MIME on the
write input); reuse / extend the existing extension→MIME mapping already
behind `classifyAttachment*`.

### Component 3 — thread `projectId` to the render site

`ToolCallMessage` currently receives `localPath` but not `projectId`.
`projectId` is available as `state.activeProjectId` in `ChatPage`.

Thread it the same way `localPath` already flows:

`ChatPage` → `ChatTranscriptViewport` → `KannaTranscript` →
(row renderers) → `ToolCallMessage`.

`projectId` is optional (`string | null`); when null, no card renders.

## Data flow

```
write_file tool_result (success)
  └─ ToolCallMessage
       ├─ isArtifactWrite(name, mime)? ──no──> collapsed row (unchanged)
       └─ yes
            ├─ path inside project root? ──no──> collapsed row (unchanged)
            └─ yes
                 ├─ rel = relative(localPath, filePath)
                 ├─ url = buildProjectFileContentUrl(projectId, rel)
                 ├─ InlinePreviewCard(source)         // thumbnail / card
                 └─ onClick -> FilePreviewSheet(source) // existing sheet
```

## Error handling / edge cases

- **Outside-root path** → no card (cannot be served). Collapsed row only.
- **Missing `projectId`** → no card.
- **File deleted before click** → `FilePreviewSheet` /
  `InlinePreviewCard` already handle fetch failure (HEAD probe →
  "missing" / disabled state) as in `OfferDownloadMessage`.
- **Render-loop safety** → any derived collections / empty fallbacks use
  stable references (module-level `EMPTY`) per the project's
  render-loop regression rule.

## Out of scope

- **Gap B — `offer_download` chip visibility** (user said "i dont see
  that file" even after the offer). Naturally mitigated: auto-surface
  removes the need to call `offer_download` for in-root artifacts, and
  the card reuses the same visible `FilePreviewSheet` component. Not
  addressed directly here.
- **Edit tool surfacing** — only `Write` (file creation) triggers the
  card. Edits stay collapsed.
- **Auto-opening the preview sheet** — explicitly rejected; card is
  click-to-open only.

## Testing

- **`isArtifactWrite` unit test** — table of names/mimes asserting
  artifact vs not: `.png`/`.html`/`.svg`/`.csv`/`.pdf`/`.zip` → true;
  `.ts`/`.tsx`/`.md`/`.json`/`.txt`/`.go` → false.
- **`ToolCallMessage` test** —
  - card renders for a successful `.png` artifact write inside root,
  - card renders for a `.html` artifact write inside root,
  - card absent for a `.ts` write,
  - card absent for an out-of-root path (`/tmp/...`),
  - card absent for a failed write.
- **Render-loop check** — mount via `renderForLoopCheck`, assert no
  React error #185 loop warnings.

## Affected files

- `src/client/components/messages/attachmentPreview.ts` — add
  `isArtifactWrite` (+ test).
- `src/client/components/messages/ToolCallMessage.tsx` — render artifact
  card; accept `projectId` prop (+ test).
- `src/client/app/KannaTranscript.tsx` — thread `projectId` through row
  renderers to `ToolCallMessage`.
- `src/client/app/ChatPage/*` — pass `state.activeProjectId` into the
  transcript.

## C3 / docs

- Add an ADR before implementation (`c3-skill:c3` change op).
- Run `c3x check` after code if component boundaries / refs change.
- Run `impeccable` for the card's visual polish (project rule 3).
