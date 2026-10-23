import path from "node:path"
import { Context, Effect, FileSystem, Latch, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { getKeybindingsFilePath } from "../shared/branding"
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingsSnapshot } from "../shared/types"
import { Machine } from "./platform/machine"

const KEYBINDING_ACTIONS = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]

type KeybindingsFile = Partial<Record<KeybindingAction, unknown>>

export class KeybindingsFileError extends Schema.TaggedError<KeybindingsFileError>()(
  "@kanna/server/keybindings/KeybindingsFileError",
  {
    operation: Schema.Literals(["read", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * The user's keybindings file, read once at start, rewritten from the client
 * and reloaded when the user edits it by hand.
 *
 * `changes` emits each snapshot after the current one, never the current one
 * itself; read that with `snapshot`.
 */
export class Keybindings extends Context.Service<Keybindings, {
  readonly filePath: string
  readonly snapshot: Effect.Effect<KeybindingsSnapshot>
  readonly changes: Stream.Stream<KeybindingsSnapshot>
  readonly reload: Effect.Effect<void, KeybindingsFileError>
  readonly write: (
    bindings: Partial<Record<KeybindingAction, string[]>>,
  ) => Effect.Effect<KeybindingsSnapshot, KeybindingsFileError>
}>()("@kanna/server/Keybindings") {
  /** `filePath` defaults to the machine's keybindings file. */
  static readonly layer = (filePath?: string) =>
    Layer.effect(this, makeKeybindings(filePath))
}

/** The runtime profile's keybindings file under `homeDir` (the machine's home, `Machine.homeDirectory`). */
export const defaultKeybindingsFilePath = (homeDir: string) => getKeybindingsFilePath(homeDir)

const makeKeybindings = Effect.fn("Keybindings.make")(function* (filePathOption: string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const filePath = filePathOption ?? defaultKeybindingsFilePath(machine.homeDirectory)
  yield* Effect.annotateCurrentSpan("filePath", filePath)

  const writeFile = (contents: unknown) =>
    fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(filePath, `${JSON.stringify(contents, null, 2)}\n`)),
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new KeybindingsFileError({ operation: "write", filePath, cause }))),
    )

  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
  if (!exists) yield* writeFile(DEFAULT_KEYBINDINGS)

  const ref = yield* SubscriptionRef.make(yield* readSnapshot(fs, filePath, machine.homeDirectory))

  const reload = Effect.fn("Keybindings.reload")(function* () {
    yield* SubscriptionRef.set(ref, yield* readSnapshot(fs, filePath, machine.homeDirectory))
  })

  const write = Effect.fn("Keybindings.write")(function* (bindings: Partial<Record<KeybindingAction, string[]>>) {
    const next = normalizeKeybindings(bindings, filePath, machine.homeDirectory)
    yield* writeFile(next.bindings)
    yield* SubscriptionRef.set(ref, next)
    return next
  })

  // The directory, not the file: editors save by renaming a new file over the
  // old one, which a watch on the file itself stops seeing. The layer waits
  // for the watcher, so an edit made right after startup is not missed.
  const watching = yield* Latch.make()
  yield* fs.watch(path.dirname(filePath), { onReady: () => Latch.openUnsafe(watching) }).pipe(
    Stream.filter((event) => path.basename(event.path) === path.basename(filePath)),
    Stream.runForEach(() =>
      reload().pipe(
        Effect.catchTag("@kanna/server/keybindings/KeybindingsFileError", (error) =>
          Effect.logWarning("Failed to reload keybindings:", error.cause)),
      )),
    Effect.catchTag("PlatformError", (error) => Effect.logWarning("Failed to watch keybindings file:", error)),
    Effect.ensuring(Latch.open(watching)),
    Effect.forkScoped,
  )
  yield* Latch.await(watching)

  return {
    filePath,
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    reload: reload(),
    write,
  }
})

export const readKeybindingsSnapshot = Effect.fn("Keybindings.readSnapshot")(function* (filePath: string) {
  return yield* readSnapshot(yield* FileSystem.FileSystem, filePath, (yield* Machine).homeDirectory)
})

const readSnapshot = Effect.fn("Keybindings.readSnapshotWith")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  homeDir: string,
) {
  const text = yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new KeybindingsFileError({ operation: "read", filePath, cause }))),
  )
  if (Option.isNone(text)) {
    return createDefaultSnapshot(filePath, homeDir)
  }
  if (!text.value.trim()) {
    return createDefaultSnapshot(filePath, homeDir, "Keybindings file was empty. Using defaults.")
  }
  return yield* decodeJson(text.value).pipe(
    Effect.map((parsed) => normalizeKeybindings(parsed as KeybindingsFile, filePath, homeDir)),
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(createDefaultSnapshot(filePath, homeDir, "Keybindings file is invalid JSON. Using defaults."))),
  )
})

/** `homeDir` is the machine's home, which `filePathDisplay` shortens to `~`. */
export function normalizeKeybindings(value: KeybindingsFile | null | undefined, filePath: string, homeDir: string): KeybindingsSnapshot {
  const warnings: string[] = []
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null

  if (!source) {
    return createDefaultSnapshot(filePath, homeDir, "Keybindings file must contain a JSON object. Using defaults.")
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
    filePathDisplay: formatDisplayPath(filePath, homeDir),
  }
}

function createDefaultSnapshot(filePath: string, homeDir: string, warning: string | null = null): KeybindingsSnapshot {
  return {
    bindings: {
      toggleEmbeddedTerminal: [...DEFAULT_KEYBINDINGS.toggleEmbeddedTerminal],
      toggleRightSidebar: [...DEFAULT_KEYBINDINGS.toggleRightSidebar],
      openInFinder: [...DEFAULT_KEYBINDINGS.openInFinder],
      openInEditor: [...DEFAULT_KEYBINDINGS.openInEditor],
      addSplitTerminal: [...DEFAULT_KEYBINDINGS.addSplitTerminal],
      jumpToSidebarChat: [...DEFAULT_KEYBINDINGS.jumpToSidebarChat],
      createChatInCurrentProject: [...DEFAULT_KEYBINDINGS.createChatInCurrentProject],
      openAddProject: [...DEFAULT_KEYBINDINGS.openAddProject],
      openCommandPalette: [...DEFAULT_KEYBINDINGS.openCommandPalette],
      toggleFocusMode: [...DEFAULT_KEYBINDINGS.toggleFocusMode],
    },
    warning,
    filePathDisplay: formatDisplayPath(filePath, homeDir),
  }
}

function formatDisplayPath(filePath: string, homePath: string) {
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}
