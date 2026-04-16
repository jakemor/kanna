# Feature Plan: Integrate the Git Diff Analyzer

## Goal

Bring the `ui-test` Git Diff Analyzer into the main Kanna app so the right sidebar can show real AI-ordered, hunk-level diff notes instead of the current prototype ordering.

The integrated feature should:

- Analyze the active project's current git changes from the existing right sidebar workflow.
- Split unified diffs into smaller change blocks with compact model context and expandable viewer context.
- Ask Codex to order those blocks by data flow and write one-sentence notes plus an overall summary.
- Stream progress/status into the existing React UI.
- Preserve the friend UI direction already present in `src/client/components/chat-ui/RightSidebar.tsx`: `Raw`, `Reordered`, `Natural Language`, and `Summary` panes.

## What Exists Now

### `ui-test`

The standalone proof of work contains the real feature behavior:

- `ui-test/shared/diffHunks.js` splits unified diffs into numbered blocks like `H001`, with:
  - a compact `diff` sent to the model,
  - `contextBefore` and `contextAfter` kept for UI expansion,
  - stable titles like `H001 src/file.ts block 1`.
- `ui-test/shared/diffStats.js` computes files, hunks, additions, deletions.
- `ui-test/shared/parseAgentResponse.js` parses streamed Codex output using `--- CHANGE NOTE ---` and `--- SUMMARY ---` markers.
- `ui-test/shared/command.js` validates git diff commands and can force `--unified=N`.
- `ui-test/server.js` starts `codex app-server`, runs git diff, prompts Codex, listens to plan/message notifications, and pushes state to the browser through SSE.
- `ui-test/public/app.js` renders live status, plan updates, the total summary, ordered hunk cards, and show/hide context buttons.

### Main App

The production app already has most of the infrastructure, but at file granularity:

- `src/server/diff-store.ts` owns git state for the active project:
  - current dirty files,
  - per-file patch loading through `readPatch`,
  - branch metadata/history,
  - commit, push, discard, ignore flows.
- `src/shared/protocol.ts` has websocket subscriptions and commands:
  - `project-git` snapshot for `ChatDiffSnapshot`,
  - `project.readDiffPatch`,
  - `chat.refreshDiffs`,
  - commit and branch commands.
- `src/server/ws-router.ts` routes websocket commands to `DiffStore`.
- `src/server/codex-app-server.ts` already wraps `codex app-server` for chat and quick structured responses, but it currently does not expose `item/agentMessage/delta` to callers.
- `src/client/app/useKannaState.ts` subscribes to `project-git`.
- `src/client/app/ChatPage/useChatPageSidebarActions.ts` owns right-sidebar actions such as patch loading, refresh, discard, commit, branch switching.
- `src/client/components/chat-ui/RightSidebar.tsx` already contains the friend's intended UI structure:
  - `Raw Diff` panel,
  - `AI Order` panel,
  - `Summary` panel,
  - panel toggles,
  - commit controls.

The current `RightSidebar` AI behavior is fake:

- `buildPrototypeAiOrderedDiff()` hashes file paths to produce deterministic but meaningless ordering.
- `buildPrototypeDiffSummary()` generates generic file-level summaries.
- Tests explicitly call this "fake AI ordering".

This is the main replacement point.

## Integration Direction

Do not bring over the standalone HTTP/SSE app from `ui-test`.

Instead:

- Port the reusable diff-analysis logic into TypeScript under `src/shared` and `src/server`.
- Use the existing websocket protocol rather than SSE.
- Use the existing active project/chat context rather than a free-form project path input.
- Keep `DiffStore` as the owner of git patch retrieval.
- Add a small per-project diff analysis state manager for transient AI analysis runs.
- Replace only the fake AI data path in the right sidebar. Keep the friend's panel layout.

## Product Scope

Initial production scope should include current worktree changes and a separate current-branch-vs-default-branch comparison.

The `ui-test` presets (`lastCommit`, `working`, `staged`, `mainBranch`, `custom`) are useful for the prototype, but the production sidebar is centered on current uncommitted project changes. Add range selection later if needed.

Recommended first behavior:

- `Analyze` runs on the currently selected files in the Changes sidebar.
- If no files are selected, disable the action.
- If all files are selected, the analysis is effectively for the full current diff.
- Invalidate or mark the analysis stale when any analyzed file's `patchDigest` changes.
- Add a compare mode control for:
  - local worktree changes, which keeps the existing commit/discard/ignore behavior;
  - current branch against the default branch, labeled from the repository default branch when available and falling back to `main`.
- Branch comparison should diff `HEAD` against the merge base with the default branch and should not expose worktree-only actions such as discard, ignore, or commit.
- Analysis, raw patch loading, selected paths, and staleness keys must all be scoped to the active compare mode so a local-worktree analysis is not reused for the branch-vs-main view.

## Requested UX Revision

The integrated sidebar should now use tab-first diff navigation instead of treating every panel as an independent toggle.

### Diff View Tabs

Replace the existing `Raw`, `AI`, and `Summary` independent toggles with tabs:

- `Raw`
- `Reordered`
- `Natural Language`
- `Summary`

Default behavior:

- Only one tab is visible at a time.
- Clicking a tab switches to that tab and hides the others.
- Keep a simple `Multi` toggle beside the tabs for side-by-side review.
- Add spacing after `Multi` so it reads as a separate mode switch, not another diff tab.
- When `Multi` is off, selecting a tab collapses back to a single visible panel.
- When `Multi` is on, tab buttons can toggle multiple visible panels, but at least one panel should remain visible.
- When `Multi` is on, each visible panel should own its own vertical scroll container.
- When `Multi` is off, keep the current single scroll container behavior so sticky raw diff headers and the overall pane feel unchanged.

### Split AI Output

The old `AI` panel should become two separate views:

- `Reordered`: show only the diff hunk cards in Codex's reordered sequence. Do not show natural-language descriptions in this view.
- `Natural Language`: show the one-sentence description for each hunk, in the same reordered sequence. Do not repeat the diff content here.

`Summary` should focus on the overall generated summary instead of duplicating the per-hunk descriptions.

Do not call reordered hunks `steps` or `hunks` in the UI. Label them as `Block 1`, `Block 2`, etc., and avoid repeating the generated trailing `block N` suffix in each source title.

### Analysis Triggering And Staleness

Remove the per-panel `Analyze` buttons from the reordered, natural-language, and summary views.

New behavior:

- When the user enters the Changes/diff view with selected files and no analysis for the current request key, start analysis automatically.
- The one analysis run generates all derived views: reordered hunks, natural-language descriptions, and summary.
- If selected files or their patch digests change after analysis, mark the generated result as stale instead of auto-rerunning.
- Show one yellow `Stale` button in the diff toolbar for stale results.
- On hover, the stale button should read `Analyze`; clicking it reruns analysis for the current selected files.
- While analysis is running, show a compact global running/cancel affordance in the toolbar rather than panel-level analyze buttons.

### Commit Form Placement

The commit message and description inputs should be pinned to the bottom of the right sidebar, outside the scrollable diff content.

Requirements:

- The diff panels should scroll independently above the commit form.
- The commit form should no longer float in the middle of the pane with a gradient overlay.
- Keep the existing generate/commit behavior and context-menu `Commit Only` fallback.
- Hide the commit form when viewing the current-branch-vs-default-branch comparison because that view can include already-committed branch changes.

## Data Model

Add shared types in a new file, likely `src/shared/diff-analysis.ts`.

Recommended shapes:

```ts
export type DiffAnalysisStatus =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "interrupted"

export interface DiffAnalysisStats {
  files: number
  hunks: number
  additions: number
  deletions: number
  lines: number
}

export interface DiffAnalysisSourceBlock {
  id: string
  file: string
  oldFile: string
  newFile: string
  title: string
  diff: string
  contextBefore: string[]
  contextAfter: string[]
}

export interface DiffAnalysisNote {
  id: string
  diff: string
  description: string
}

export interface ParsedDiffAnalysis {
  hunks: DiffAnalysisNote[]
  summary: string
  partial: string
  isComplete: boolean
}

export interface DiffAnalysisSnapshot {
  projectId: string
  status: DiffAnalysisStatus
  statusText: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  selectedPaths: string[]
  requestKey: string | null
  diffStats: DiffAnalysisStats | null
  sourceBlocks: DiffAnalysisSourceBlock[]
  parsed: ParsedDiffAnalysis
  plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>
}
```

`requestKey` should be derived from selected paths plus current patch digests, so the client can tell whether a completed analysis still matches the visible diff.

## Shared Code To Port

Port these files from `ui-test/shared` to TypeScript:

- `diffHunks.js` -> `src/shared/diff-analysis-hunks.ts`
- `diffStats.js` -> `src/shared/diff-analysis-stats.ts`
- `parseAgentResponse.js` -> `src/shared/diff-analysis-parser.ts`

Keep the marker format from `ui-test` for the first integration because it supports useful partial parsing while the model streams.

Important changes during the port:

- Add TypeScript interfaces and tests.
- Keep hunk IDs as `H001`, `H002`, etc.
- Keep model context at 2 lines and expandable UI context at 10 lines initially.
- Make parser tolerant of partial output, duplicate notes, and unknown IDs.
- Avoid including full raw model output in websocket snapshots unless needed for debugging.

## Server Plan

### 1. Extend Patch Retrieval

`src/server/diff-store.ts` currently has `readPatch()` for one path and uses `createPatch()` with `--unified=3`.

Add server helpers for analysis:

- `readPatchesForAnalysis({ projectPath, paths, contextLines })`
- or `readCombinedPatch({ projectPath, paths, contextLines })`

Requirements:

- Validate every path with `normalizeRepoRelativePath`.
- Confirm every path is still dirty.
- Support tracked, untracked, added, deleted, and renamed files.
- Allow the caller to request larger context, e.g. 12 lines, so the hunk splitter can keep 2 model lines plus 10 expandable viewer lines.
- Reuse `createPatch()` where possible, but make it accept a `contextLines` argument.
- Skip or clearly report binary/unreadable files; do not send binary blobs to Codex.

### 2. Add Diff Analysis Manager

Create a new server module, likely `src/server/diff-analysis-store.ts`.

Responsibilities:

- Maintain in-memory `DiffAnalysisSnapshot` by `projectId`.
- Start one analysis at a time per project.
- Cancel/interrupt an active analysis.
- Reset analysis when project diffs are refreshed and patch digests no longer match.
- Expose `getProjectSnapshot(projectId)`.
- Expose an `onChange(projectId)` callback or integrate with router broadcasts.

The manager should not replace `DiffStore`; it should call into `DiffStore` for patches and git state.

### 3. Use Existing WebSocket Routing

Extend `src/shared/protocol.ts`:

- Add subscription:

```ts
| { type: "project-diff-analysis"; projectId: string }
```

- Add commands:

```ts
| { type: "chat.analyzeDiff"; chatId: string; paths: string[] }
| { type: "chat.cancelDiffAnalysis"; chatId: string }
```

- Add snapshot:

```ts
| { type: "project-diff-analysis"; data: DiffAnalysisSnapshot | null }
```

Then update `src/server/ws-router.ts`:

- Include `projectDiffAnalysis` in subscription counting and filtered broadcast logic.
- Return analysis snapshots from `createEnvelope`.
- Route `chat.analyzeDiff` and `chat.cancelDiffAnalysis`.
- Broadcast only the affected project's analysis snapshot during analysis updates.

### 4. Codex Integration

The `ui-test` server listens to raw app-server notifications including:

- `turn/plan/updated`
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `turn/completed`

The production `src/server/codex-app-server.ts` currently maps app-server output into chat transcript events and does not expose agent-message deltas.

There are two viable implementation paths:

1. Preferred full-parity path:
   - Extend `src/server/codex-app-server-protocol.ts` with `item/agentMessage/delta`.
   - Extend `CodexAppServerManager` with a purpose-built `startAnalysisTurn()` or callback-based API that emits plan updates, deltas, completion, and errors without writing to chat transcripts.
   - Let `DiffAnalysisStore` update its parsed snapshot as deltas arrive.

2. Faster MVP path:
   - Use `QuickResponseAdapter` or `CodexAppServerManager.generateStructured()` for a non-streaming result.
   - Populate the AI and Summary panels after completion only.
   - Add streaming later by exposing deltas.

The recommended path is full parity because the proof of work's main UX value is live progress and partial hunk notes.

### 5. Prompt

Move `buildAnalysisPrompt()` from `ui-test/server.js` into the new analysis server module.

Keep the core instructions:

- The model receives numbered change blocks.
- It must order by data flow or dependency order.
- It must write one sentence per block.
- It must write a concise 3-5 sentence total summary.
- It must not repeat diff content.
- It must output only marker blocks.

Add production-specific constraints:

- If a source block is unimportant boilerplate, still include it with a concise note.
- Do not invent files or IDs.
- Include every source block exactly once.

## Client Plan

### 1. Subscribe To Analysis State

Update `src/client/app/useKannaState.ts`:

- Subscribe to `{ type: "project-diff-analysis", projectId: activeProjectId }`.
- Store the latest `diffAnalysisSnapshot`.
- Pass it into `ChatPage`.

### 2. Add Sidebar Actions

Update `src/client/app/ChatPage/useChatPageSidebarActions.ts`:

- Add `handleAnalyzeDiff(paths: string[])`.
- Add `handleCancelDiffAnalysis()`.
- Optionally refresh diffs before analysis to reduce stale patch risk.
- Reuse the active chat ID for routing, like commit and branch commands.

### 3. Replace Prototype AI Data

Update `src/client/components/chat-ui/RightSidebar.tsx`:

- Remove `PrototypeAiOrderedDiffEntry`.
- Remove `hashDiffPath()`.
- Remove `buildPrototypeDiffSummary()`.
- Remove or replace `buildPrototypeAiOrderedDiff()`.
- Add props for:
  - `diffAnalysis`,
  - `onAnalyzeDiff`,
  - `onCancelDiffAnalysis`.

The `Raw Diff` panel should keep using existing `DiffFileCard`.

The `AI Order` panel should render ordered hunk-level entries:

- Match `parsed.hunks[*].id` to `sourceBlocks`.
- Render the block title/file.
- Render the one-sentence description.
- Render the block diff.
- Offer `Show 10 lines before` / `Show 10 lines after` buttons using `contextBefore` and `contextAfter`.
- Show status states:
  - no analysis yet,
  - starting,
  - running/streaming,
  - completed,
  - failed,
  - stale.

The `Summary` panel should render:

- Overall summary from `parsed.summary`.
- Ordered one-line notes from `parsed.hunks`.
- A placeholder/CTA when no analysis has run.
- A stale warning when current selected files no longer match the analysis `requestKey`.

### 4. Fit The Existing UI

Keep the friend's layout choices:

- Keep the `Raw`, `AI`, and `Summary` panel toggles.
- Keep the branch toolbar and commit controls.
- Keep the commit checkbox flow.
- Add analysis controls inside the `AI Order` and `Summary` panel headers, not as a separate top-level page.

Recommended controls:

- `Analyze` when idle or stale.
- `Refresh` when completed and still valid.
- `Cancel` while running.
- Small status text: `Analyzing 12 change blocks`, `Streaming notes`, `Analysis complete`, or error message.

### 5. Rendering Strategy

Create a small component rather than bloating `RightSidebar.tsx` further:

- `src/client/components/chat-ui/DiffAnalysisPanel.tsx`
- or `src/client/components/chat-ui/DiffAnalysisCard.tsx`

This component should own:

- context expansion local state,
- matching parsed notes to source blocks,
- hunk-level diff rendering.

Reuse `PatchDiff` if it renders partial hunk patches correctly. If it struggles with split blocks or inserted context, port the simple custom renderer from `ui-test/public/app.js` because it is predictable and small.

## Testing Plan

### Shared Logic

Add or port tests for:

- `parseUnifiedDiffHunks`
- `computeDiffStats`
- `parseAgentResponse`

Use the existing `ui-test/test/*.test.js` cases as the source.

Target files:

- `src/shared/diff-analysis-hunks.test.ts`
- `src/shared/diff-analysis-stats.test.ts`
- `src/shared/diff-analysis-parser.test.ts`

### Server

Add tests around `DiffStore`:

- combined patch generation for multiple selected files,
- larger context line handling,
- untracked files,
- renamed files,
- invalid paths rejected.

Add websocket router tests:

- `project-diff-analysis` subscription returns a snapshot,
- `chat.analyzeDiff` routes to the analysis manager,
- `chat.cancelDiffAnalysis` routes cancellation,
- analysis broadcasts only affect the matching project subscription.

Mock Codex/app-server for:

- plan update,
- agent delta,
- completed message,
- failed turn,
- interrupted turn.

### Client

Update `RightSidebar.test.tsx`:

- Remove expectations for fake prototype summaries.
- Assert `AI Order` renders real analysis notes from a supplied snapshot.
- Assert no-analysis, running, failed, completed, and stale states.
- Assert `Analyze` is disabled with zero selected files.
- Assert `Cancel` appears while running.

Add focused tests for the new analysis panel component if it is split out.

## Implementation Sequence

1. Port shared parser/splitter/stats from `ui-test` into TypeScript and get tests passing.
2. Add analysis-specific patch retrieval to `DiffStore`.
3. Add `DiffAnalysisStore` with in-memory snapshots and a mocked runner.
4. Extend websocket protocol and router for analysis subscription and commands.
5. Wire `DiffAnalysisStore` into `startKannaServer()`.
6. Add Codex runner support:
   - first with mocked tests,
   - then with actual app-server plan/delta/completion handling.
7. Subscribe in `useKannaState` and pass state/actions through `ChatPage`.
8. Replace `RightSidebar` fake AI ordering with real analysis snapshot rendering.
9. Update/remove tests that assert fake summaries.
10. Run:
    - `bun test`
    - `bun run check`
    - a manual local analysis on a repo with multi-file changes.

## Cleanup After Integration

After the production feature works:

- Keep `ui-test` temporarily until parity is verified.
- Then either remove it or move only its fixtures into production tests.
- Remove fake prototype helpers from `RightSidebar.tsx`.
- Remove tests that mention "fake AI ordering".

## Risks And Mitigations

- Large diffs can exceed context limits.
  - Mitigation: selected-file analysis, stats before send, max block/file count guard, clear error asking user to narrow selection.
- Streaming support is not yet exposed by production `CodexAppServerManager`.
  - Mitigation: add the missing `item/agentMessage/delta` protocol first, or ship a non-streaming MVP if time is tight.
- Analysis can go stale while the user edits files.
  - Mitigation: request keys from paths plus patch digests, and show a stale state instead of silently reusing old notes.
- File-level right-sidebar state does not map one-to-one to hunk-level analysis.
  - Mitigation: keep raw file cards unchanged and make AI/Summary explicitly hunk-level.
- Binary or very large generated files may be present in the diff.
  - Mitigation: skip unsupported files with a visible warning, and never send binary contents to the model.
