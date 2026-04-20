# Import Claude Code Sessions — Design

**Date:** 2026-04-20
**Status:** Approved, ready for implementation

## Goal

Bulk-import existing Claude Code CLI sessions from `~/.claude/projects/` into Kanna as native chats, preserving full transcript history and enabling seamless resume through the Claude Agent SDK.

## Scope

**In:**
- Sidebar "Import" button beside existing "Add Project" button
- One-shot scan of all `~/.claude/projects/*/*.jsonl` session files
- Full transcript preload into Kanna chat (not stub/lazy)
- Auto-create Kanna project if session's cwd is not yet tracked
- Deduplication by `claudeSessionId`
- Resume via session ID on next user turn (no forking)

**Out (YAGNI):**
- Running-process detection (`ps` scan)
- Live session tailing
- Separate sidebar section for un-imported CLI sessions
- Codex session import
- Bulk undo/delete for imported chats (existing per-chat delete suffices)

## UI

**Entry point:** new Import icon-button in sidebar header, sibling of Add Project.

**Flow:**
1. Click → confirmation modal: "Scan `~/.claude/projects/` and import sessions into Kanna?"
2. Progress toast: "Scanning X sessions..." → streams count updates via WS
3. Final toast: "Imported Y new, skipped Z existing, failed W"
4. Sidebar refreshes with new projects and chats appearing under their groups

## Architecture

### New server module

`src/server/import-claude-sessions.ts` — orchestrates scan, parse, dedup, write.

### Scan phase

- Walk `~/.claude/projects/*/` directories
- List `*.jsonl` files per subdir (exclude snapshots/compacted files)
- Decode folder name → cwd path via existing `resolveEncodedClaudePath` (discovery.ts:22)
- Skip if cwd no longer exists on disk

### Parse phase (per session file)

- Read JSONL line-by-line, JSON.parse each
- Extract `sessionId` from first record
- Skip if `sessionId` already present in Kanna `chats.jsonl` (dedup)
- Map each record → Kanna message event:
  - user prompt → `message_appended { role: "user", ... }`
  - assistant text → `message_appended { role: "assistant", ... }`
  - tool_use / tool_result → normalized via `src/shared/tools.ts`
- Emit `turn_finished` at assistant-response boundaries
- Skip empty sessions (0 messages)
- On malformed line: log + skip line, continue file (don't abort)

### Write phase

- Append `chat_created` event to `chats.jsonl`:
  - `provider: "claude"`
  - `claudeSessionId: <sessionId>`
  - `status: "idle"`
  - `projectId: <resolved or newly-created>`
- Append all `message_appended` + `turn_finished` events to `messages.jsonl` / `turns.jsonl`
- Trigger async title generation (existing Haiku pipeline) for untitled chats

### Auto-create project

If session cwd doesn't map to any existing Kanna project, emit `project_opened` event using same flow as Add Project modal.

### Transport

New WS command: `importClaudeSessions`
Response shape: `{ imported: number, skipped: number, failed: number, newProjects: number }`
Progress events streamed: `{ type: "importProgress", scanned, imported }`

## Resume behavior

- Kanna chat stores `claudeSessionId`
- Next user turn: `AgentCoordinator` passes `resume: <sessionId>` option to Claude Agent SDK
- SDK continues same session → appends to original `~/.claude/projects/*.jsonl`
- No fork, no duplicate session ID

## Edge cases

| Case | Behavior |
|---|---|
| Malformed JSONL line | Log + skip line, continue file |
| Empty session (0 messages) | Skip, no chat created |
| Session file still being written (CLI active) | Import current snapshot; resume continues normally |
| Project dir deleted on disk | Skip session, count as failed |
| Re-import of existing session | Dedup by `claudeSessionId`, skip |
| Very large session (>10k messages) | Stream events; single progress update per 100 entries |

## Testing

### Unit

`src/server/import-claude-sessions.test.ts`:
- Fixture valid session → produces correct chat + message events
- Fixture malformed JSONL → skips bad lines, imports rest
- Fixture empty session → skipped
- Fixture with tool_use/tool_result → normalized via shared/tools
- Dedup: re-import produces 0 new
- Missing project dir → failed count
- Auto-create project when cwd new

### Integration

Full pipeline: WS `importClaudeSessions` → event store → read models → sidebar snapshot.

## Files to touch

**New:**
- `src/server/import-claude-sessions.ts`
- `src/server/import-claude-sessions.test.ts`
- `src/client/components/ImportSessionsButton.tsx` (or inline in sidebar header)

**Modified:**
- `src/server/ws-router.ts` — add `importClaudeSessions` command handler
- `src/shared/protocol.ts` — add command + progress event types
- `src/server/events.ts` — reuse existing events; no new types needed
- `src/client/app/KannaSidebar.tsx` — render Import button next to Add Project
- `src/client/app/useKannaState.ts` — wire WS command + toast feedback
- `src/server/agent.ts` — verify `resume: claudeSessionId` is passed (likely already supported)

## Open questions

None blocking. Implementation can proceed.
