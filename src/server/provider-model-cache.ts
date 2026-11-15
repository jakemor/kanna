import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  applyClaudeSdkModels,
  applyCodexModels,
  applyCursorModels,
  applyGrokModels,
  type ClaudeSdkModelInfo,
  type CodexAppServerModelInfo,
  type CursorCliModelInfo,
  type GrokCliModelInfo,
} from "./provider-catalog"

/**
 * The last model list each harness reported, as it reported it. The live
 * lists only arrive once a probe or a turn has asked the harness, which takes
 * seconds for Codex, Cursor and Grok and, for Claude, a Claude process. Until
 * then the picker would show the static catalog. The cache lets a fresh boot
 * show the last known list right away, and the probes refresh it behind.
 *
 * Raw rows are kept, not the built picker entries, so a boot re-runs them
 * through the current apply functions: a mapping fixed in a later Kanna (the
 * Mythos full id) applies to cached lists too. Pi has no entry: its list is
 * the user's fave models, read from settings at boot.
 */
export interface ProviderModelLists {
  claude?: ClaudeSdkModelInfo[]
  codex?: CodexAppServerModelInfo[]
  cursor?: CursorCliModelInfo[]
  grok?: GrokCliModelInfo[]
}

type CachedProvider = keyof ProviderModelLists

const APPLY: { [K in CachedProvider]-?: (models: NonNullable<ProviderModelLists[K]>) => boolean } = {
  claude: applyClaudeSdkModels,
  codex: applyCodexModels,
  cursor: applyCursorModels,
  grok: applyGrokModels,
}

export class ProviderModelCache {
  private lists: ProviderModelLists = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  /**
   * Read the file and apply every cached list to the catalog. Returns true
   * when the catalog changed. A missing or unreadable file is an empty cache.
   */
  async load(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown
      if (parsed && typeof parsed === "object") this.lists = parsed as ProviderModelLists
    } catch {
      return false
    }
    let changed = false
    for (const provider of Object.keys(APPLY) as CachedProvider[]) {
      const models = this.lists[provider]
      if (!Array.isArray(models) || models.length === 0) continue
      try {
        if ((APPLY[provider] as (rows: typeof models) => boolean)(models)) changed = true
      } catch {
        // A row shape from an older Kanna that no longer applies: drop it,
        // the next probe writes a fresh one.
        delete this.lists[provider]
      }
    }
    return changed
  }

  /** Keep a list a harness just reported. Writes only when it changed. */
  record<K extends CachedProvider>(provider: K, models: NonNullable<ProviderModelLists[K]>): Promise<void> {
    if (models.length === 0) return this.writing
    if (JSON.stringify(this.lists[provider]) === JSON.stringify(models)) return this.writing
    this.lists = { ...this.lists, [provider]: models }
    const snapshot = `${JSON.stringify(this.lists, null, 2)}\n`
    // Chained, so two lists landing together can't interleave their writes.
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${process.pid}.tmp`
        await writeFile(temp, snapshot, "utf8")
        await rename(temp, this.filePath)
      } catch {
        // The cache only speeds up the next boot; the live list still applies.
      }
    })
    return this.writing
  }
}
