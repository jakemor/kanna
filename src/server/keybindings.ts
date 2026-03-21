import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataRootDir, LOG_PREFIX } from "../shared/branding"
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingsSnapshot } from "../shared/types"

const KEYBINDING_ACTIONS = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]

type KeybindingsFile = Partial<Record<KeybindingAction, unknown>>

export class KeybindingsManager {
  readonly filePath: string
  private watcher: FSWatcher | null = null
  private snapshot: KeybindingsSnapshot = createDefaultSnapshot()
  private readonly listeners = new Set<(snapshot: KeybindingsSnapshot) => void>()

  constructor(filePath = path.join(getDataRootDir(homedir()), "keybindings.json")) {
    this.filePath = filePath
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) {
      await writeFile(this.filePath, `${JSON.stringify(DEFAULT_KEYBINDINGS, null, 2)}\n`, "utf8")
    }
    await this.reload()
    this.startWatching()
  }

  dispose() {
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }

  getSnapshot() {
    return this.snapshot
  }

  onChange(listener: (snapshot: KeybindingsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async reload() {
    const nextSnapshot = await readKeybindingsSnapshot(this.filePath)
    this.setSnapshot(nextSnapshot)
  }

  async write(bindings: Partial<Record<KeybindingAction, string[]>>) {
    const nextSnapshot = normalizeKeybindings(bindings)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(nextSnapshot.bindings, null, 2)}\n`, "utf8")
    this.setSnapshot(nextSnapshot)
    return nextSnapshot
  }

  private setSnapshot(snapshot: KeybindingsSnapshot) {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private startWatching() {
    this.watcher?.close()
    try {
      this.watcher = watch(path.dirname(this.filePath), { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== path.basename(this.filePath)) {
          return
        }
        void this.reload().catch((error: unknown) => {
          console.warn(`${LOG_PREFIX} Failed to reload keybindings:`, error)
        })
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to watch keybindings file:`, error)
      this.watcher = null
    }
  }
}

export async function readKeybindingsSnapshot(filePath: string) {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      return createDefaultSnapshot("Keybindings file was empty. Using defaults.")
    }
    const parsed = JSON.parse(text) as KeybindingsFile
    return normalizeKeybindings(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createDefaultSnapshot()
    }

    if (error instanceof SyntaxError) {
      return createDefaultSnapshot("Keybindings file is invalid JSON. Using defaults.")
    }

    throw error
  }
}

export function normalizeKeybindings(value: KeybindingsFile | null | undefined): KeybindingsSnapshot {
  const warnings: string[] = []
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null

  if (!source) {
    return createDefaultSnapshot("Keybindings file must contain a JSON object. Using defaults.")
  }

  const bindings = {} as Record<KeybindingAction, string[]>
  for (const action of KEYBINDING_ACTIONS) {
    const rawValue = source[action]
    if (!Array.isArray(rawValue)) {
      bindings[action] = [...DEFAULT_KEYBINDINGS[action]]
      if (rawValue !== undefined) {
        warnings.push(`${action} must be an array of shortcut strings`)
      }
      continue
    }

    const normalized = rawValue
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .map((entry) => entry.toLowerCase())
      .filter(Boolean)

    if (normalized.length === 0) {
      bindings[action] = [...DEFAULT_KEYBINDINGS[action]]
      if (rawValue.length > 0 || source[action] !== undefined) {
        warnings.push(`${action} did not contain any valid shortcut strings`)
      }
      continue
    }

    bindings[action] = normalized
  }

  return {
    bindings,
    warning: warnings.length > 0 ? `Some keybindings were reset to defaults: ${warnings.join("; ")}` : null,
  }
}

function createDefaultSnapshot(warning: string | null = null): KeybindingsSnapshot {
  return {
    bindings: {
      toggleEmbeddedTerminal: [...DEFAULT_KEYBINDINGS.toggleEmbeddedTerminal],
      toggleRightSidebar: [...DEFAULT_KEYBINDINGS.toggleRightSidebar],
      openInFinder: [...DEFAULT_KEYBINDINGS.openInFinder],
      openInEditor: [...DEFAULT_KEYBINDINGS.openInEditor],
      addSplitTerminal: [...DEFAULT_KEYBINDINGS.addSplitTerminal],
    },
    warning,
  }
}
