import { randomUUID } from "node:crypto"
import type { TranscriptEntry } from "../shared/types"

/** Stamp a transcript entry with a generated id and creation time. */
export function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}
