import { Effect, Option, Schema } from "effect"
import type { EventStore } from "./event-store"
import type { ChatRecord, TouchedFile } from "./events"
import { git, resolveLocation, treeBlobs } from "./worktree-git"

/**
 * One-time repair of claims recorded before base blobs existed.
 *
 * A chat that touched a file before this tracking has a path and nothing else,
 * which the sidebar reads as "no commit can settle this" — the old rule, kept
 * for those records so upgrading couldn't silently hide uncommitted work. Left
 * alone they never expire: the chat keeps returning to Relevant every time
 * anyone else dirties a file it once edited, which is the exact behaviour base
 * blobs exist to end.
 *
 * The missing base is recoverable. A chat's claim was made on top of whatever
 * `HEAD` held for that path when the chat last ran, so one `rev-list --before`
 * finds the commit the repo was at then, and one `ls-tree` reads every path off
 * it. Two git calls per chat, once, at boot.
 *
 * Approximate by construction — it reads the chat's *last* activity rather than
 * the turn that touched each path, and it can't know the chat was on another
 * branch. Both approximations fail toward a base that no longer matches, i.e.
 * toward retiring a claim; anything it can't resolve at all is left unknown,
 * which keeps today's behaviour rather than guessing.
 */

/** The store could not record a chat's dated claims. */
export class TouchedFileBackfillError extends Schema.TaggedError<TouchedFileBackfillError>()(
  "@kanna/server/touched-file-backfill/TouchedFileBackfillError",
  {
    chatId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Where a chat was in time, for reconstructing what it edited from. */
function chatActivityAt(chat: ChatRecord): number | null {
  return chat.lastTurnEndedAt ?? chat.lastMessageAt ?? chat.updatedAt ?? null
}

function legacyPaths(chat: ChatRecord): string[] {
  return (chat.touchedFiles ?? [])
    .filter((file) => file.baseBlob === undefined)
    .map((file) => file.path)
}

/**
 * The commit the repo was at when the chat last ran: some commit, none when
 * nothing was committed by then (every path's base is genuinely "not
 * committed"), or `undefined` when the question couldn't be answered and the
 * claim should stay unknown.
 */
const commitAsOf = Effect.fnUntraced(function* (repoRoot: string, atMs: number) {
  const listed = yield* git(["rev-list", "-1", `--before=${new Date(atMs).toISOString()}`, "HEAD"], repoRoot)
  if (listed.exitCode !== 0) return undefined
  return Option.fromNullOr(listed.stdout.trim() || null)
})

export interface TouchedFileBackfillResult {
  /** Chats whose claims were stamped with a base. */
  chats: number
  /** Individual paths given a base. */
  files: number
}

/**
 * Stamps every legacy claim it can resolve, in place, through the store's
 * normal `chat_files_touched` path — so the repair is an event like any other
 * and survives restart without a second pass.
 */
export const backfillTouchedFileBases = Effect.fn("TouchedFileBackfill.run")(function* (
  store: Pick<EventStore["Service"], "state" | "recordFilesTouched">,
) {
  const pending = new Map<string, ChatRecord[]>()
  for (const chat of store.state.chatsById.values()) {
    if (chat.deletedAt || legacyPaths(chat).length === 0) continue
    const project = store.state.projectsById.get(chat.projectId)
    if (!project || project.deletedAt) continue
    const forProject = pending.get(chat.projectId)
    if (forProject) forProject.push(chat)
    else pending.set(chat.projectId, [chat])
  }
  const result: TouchedFileBackfillResult = { chats: 0, files: 0 }
  if (pending.size === 0) return result

  /** Dates one chat's claims; whether it recorded any. */
  const backfillChat = Effect.fnUntraced(function* (repoRoot: string, chat: ChatRecord) {
    const paths = legacyPaths(chat)
    const activityAt = chatActivityAt(chat)
    if (paths.length === 0 || activityAt == null) return

    const commit = yield* commitAsOf(repoRoot, activityAt)
    if (commit === undefined) return
    // Nothing was committed when this chat ran, so "not in HEAD" is the
    // honest base — and whatever commit first added the path retires it.
    const blobs = Option.isNone(commit)
      ? Option.some(new Map(paths.map((filePath) => [filePath, null] as const)))
      : yield* treeBlobs(repoRoot, commit.value, paths)
    if (Option.isNone(blobs)) return

    const files: TouchedFile[] = paths.map((filePath) => ({
      path: filePath,
      baseBlob: blobs.value.get(filePath) ?? null,
    }))
    yield* store.recordFilesTouched(chat.id, files).pipe(
      Effect.catchTag("@kanna/server/event-store/EventStoreFileError", (cause) =>
        Effect.fail(new TouchedFileBackfillError({ chatId: chat.id, cause }))),
    )
    result.chats += 1
    result.files += files.length
  })

  yield* Effect.forEach(pending, Effect.fnUntraced(function* ([projectId, chats]) {
    const project = store.state.projectsById.get(projectId)
    if (!project) return
    const location = yield* resolveLocation(project.localPath)
    // Not a repo (any more): nothing to read a base from, and nothing can be
    // dirty either, so the stale claims are harmless where they are.
    if (Option.isNone(location)) return
    yield* Effect.forEach(chats, (chat) => backfillChat(location.value.repoRoot, chat), { discard: true })
  }), { discard: true })

  if (result.chats > 0) {
    yield* Effect.logInfo(
      `dated ${result.files} touched file(s) across ${result.chats} chat(s) recorded before commit tracking`,
    )
  }
  return result
})
