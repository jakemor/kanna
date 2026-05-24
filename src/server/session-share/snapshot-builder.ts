import {
  CHAT_SNAPSHOT_VERSION,
  type AttachmentManifestEntry,
  type ChatMeta,
  type ChatSnapshot,
  type ChatSnapshotMessage,
} from "../../shared/session-share/types"

export interface SnapshotSources {
  getChatMeta(chatId: string): ChatMeta | null
  getTranscript(chatId: string): ChatSnapshotMessage[]
  getAttachments(chatId: string): AttachmentManifestEntry[]
}

export interface BuildOptions {
  stripLargeBodies?: boolean
}

export function buildChatSnapshot(
  sources: SnapshotSources,
  chatId: string,
  opts: BuildOptions = {},
): ChatSnapshot {
  const meta = sources.getChatMeta(chatId)
  if (!meta) {
    throw new Error(`chat_not_found:${chatId}`)
  }
  const transcript = sources.getTranscript(chatId)
  const messages = opts.stripLargeBodies
    ? transcript.map<ChatSnapshotMessage>((m) =>
        m.kind === "diff" || m.kind === "terminal_chunk"
          ? { kind: "omitted", id: m.id, createdAt: m.createdAt, reason: "too_large" }
          : m,
      )
    : transcript
  return {
    version: CHAT_SNAPSHOT_VERSION,
    chatMeta: meta,
    messages,
    attachmentsManifest: sources.getAttachments(chatId),
  }
}
