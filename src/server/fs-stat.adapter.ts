import { stat } from "node:fs/promises"
import type { Stats } from "node:fs"

export type PathInfo = Stats

export async function statPathOrNull(p: string): Promise<PathInfo | null> {
  return await stat(p).catch(() => null)
}
