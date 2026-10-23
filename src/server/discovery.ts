import path from "node:path"
import { Context, Deferred, Effect, FileSystem, Layer, Option, Predicate, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"
import { Machine } from "./platform/machine"

/**
 * Read only the first few KB of a file. Codex session logs run to many MB and
 * only their first line (session_meta) matters here — reading whole files made
 * discovery block the event loop for seconds on large Codex histories.
 */
const FILE_HEAD_BYTES = 64 * 1024

/**
 * Upper bound on file handles one scan holds open at once. A Codex history
 * has thousands of session files; opening them all together would hit EMFILE.
 */
const SCAN_CONCURRENCY = 32

/** A provider's history could not be listed, so discovery could not finish. */
export class ProjectDiscoveryError extends Schema.TaggedError<ProjectDiscoveryError>()(
  "@kanna/server/discovery/ProjectDiscoveryError",
  {
    provider: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface DiscoveredProject {
  localPath: string
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface ProjectDiscoveryAdapter {
  readonly provider: AgentProvider
  readonly scan: (homeDir: string) => Effect.Effect<ProviderDiscoveredProject[], ProjectDiscoveryError>
}

const discoveryError = (provider: AgentProvider, filePath: string) => (cause: PlatformError) =>
  Effect.fail(new ProjectDiscoveryError({ provider, path: filePath, message: cause.message, cause }))

/** Stat, or none when the path is gone or unreadable. */
const statOption = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.stat(filePath).pipe(Effect.option)

const pathExists = (fs: FileSystem.FileSystem, filePath: string) =>
  statOption(fs, filePath).pipe(Effect.map(Option.isSome))

function mtimeMs(info: FileSystem.File.Info) {
  return Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })
}

const resolveLocalPathOption = Option.liftThrowable(resolveLocalPath)

/** The path as Kanna stores it (`~` against the machine's home), if it is a directory that exists. */
const normalizeExistingDirectory = (fs: FileSystem.FileSystem, machine: Machine["Service"], localPath: string) =>
  Effect.gen(function* () {
    const normalized = resolveLocalPathOption(localPath, machine.homeDirectory)
    if (Option.isNone(normalized)) return Option.none<string>()
    const info = yield* statOption(fs, normalized.value)
    return Option.isSome(info) && info.value.type === "Directory" ? normalized : Option.none<string>()
  })

const resolveEncodedClaudePath = (fs: FileSystem.FileSystem, folderName: string) =>
  Effect.gen(function* () {
    const segments = folderName.replace(/^-/, "").split("-").filter(Boolean)
    let currentPath = ""
    let remainingSegments = [...segments]

    while (remainingSegments.length > 0) {
      let found = false

      for (let index = remainingSegments.length; index >= 1; index -= 1) {
        const segment = remainingSegments.slice(0, index).join("-")
        const candidate = `${currentPath}/${segment}`

        if (yield* pathExists(fs, candidate)) {
          currentPath = candidate
          remainingSegments = remainingSegments.slice(index)
          found = true
          break
        }
      }

      if (!found) {
        const [head, ...tail] = remainingSegments
        currentPath = `${currentPath}/${head}`
        remainingSegments = tail
      }
    }

    return currentPath || "/"
  })

function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.localPath)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.localPath, {
        localPath: project.localPath,
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

function asProviderProjects(provider: AgentProvider, projects: Iterable<DiscoveredProject>): ProviderDiscoveredProject[] {
  return mergeDiscoveredProjects(projects).map((project) => ({ provider, ...project }))
}

function isPresent<A>(value: A | null): value is A {
  return value !== null
}

/** Claude: one folder per project under ~/.claude/projects, named for its path. */
export const makeClaudeDiscoveryAdapter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const provider = "claude" as const

  const scan = Effect.fn("ProjectDiscovery.scanClaude")(function* (homeDir: string) {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!(yield* pathExists(fs, projectsDir))) {
      return []
    }

    const entries = yield* fs.readDirectory(projectsDir).pipe(Effect.catchTag("PlatformError", discoveryError(provider, projectsDir)))
    const scanned = yield* Effect.forEach(entries, (name) => Effect.gen(function* () {
      const markerPath = path.join(projectsDir, name)
      const stats = yield* fs.stat(markerPath).pipe(Effect.catchTag("PlatformError", discoveryError(provider, markerPath)))
      if (stats.type !== "Directory") return null

      const resolvedPath = yield* resolveEncodedClaudePath(fs, name)
      const normalizedPath = yield* normalizeExistingDirectory(fs, machine, resolvedPath)
      if (Option.isNone(normalizedPath)) {
        return null
      }

      const project: ProviderDiscoveredProject = {
        provider,
        localPath: normalizedPath.value,
        title: path.basename(normalizedPath.value) || normalizedPath.value,
        modifiedAt: mtimeMs(stats),
      }
      return project
    }), { concurrency: SCAN_CONCURRENCY })

    return asProviderProjects(provider, scanned.filter(isPresent))
  })

  const adapter: ProjectDiscoveryAdapter = { provider, scan }
  return adapter
})

const CodexSessionIndexLine = Schema.Struct({
  id: Schema.NonEmptyString,
  updated_at: Schema.String,
})
const decodeCodexSessionIndexLine = Schema.decodeUnknownOption(Schema.fromJsonString(CodexSessionIndexLine))

/** session_meta, the first line of a Codex session file. Timestamps are read only when they are strings. */
const CodexSessionMeta = Schema.Struct({
  type: Schema.Literal("session_meta"),
  timestamp: Schema.optionalKey(Schema.Unknown),
  payload: Schema.Struct({
    id: Schema.NonEmptyString,
    cwd: Schema.NonEmptyString,
    timestamp: Schema.optionalKey(Schema.Unknown),
  }),
})
const decodeCodexSessionMeta = Schema.decodeUnknownOption(Schema.fromJsonString(CodexSessionMeta))

const parseTimestamp = (value: unknown) => Predicate.isString(value) ? Date.parse(value) : Number.NaN

interface CodexSessionMetadata {
  sessionId: string
  cwd: string
  modifiedAt: number
}

function parseCodexSessionHead(head: string, mtime: number): CodexSessionMetadata | null {
  const firstLine = head.split("\n", 1)[0]
  if (!firstLine?.trim()) return null

  const record = decodeCodexSessionMeta(firstLine)
  if (Option.isNone(record)) return null

  const { payload } = record.value
  const recordTimestamp = parseTimestamp(record.value.timestamp)
  const payloadTimestamp = parseTimestamp(payload.timestamp)
  const modifiedAt = [recordTimestamp, payloadTimestamp, mtime].find((value) => !Number.isNaN(value)) ?? mtime

  return { sessionId: payload.id, cwd: payload.cwd, modifiedAt }
}

interface CachedCodexSession {
  mtimeMs: number
  size: bigint
  metadata: CodexSessionMetadata | null
}

export interface CodexProjectDiscoveryOptions {
  /** Injectable for tests that count how often a session file is opened. */
  readFileHead?: (filePath: string) => Effect.Effect<string, PlatformError>
}

/**
 * Codex: the cwd each session recorded, plus the projects config.toml
 * trusts. Session timestamps come from session_index.jsonl when it has them.
 */
export const makeCodexDiscoveryAdapter = Effect.fn("ProjectDiscovery.makeCodex")(function* (
  options: CodexProjectDiscoveryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const provider = "codex" as const

  const readHead = options.readFileHead ?? ((filePath: string) =>
    fs.open(filePath, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(FILE_HEAD_BYTES)),
      Effect.map(Option.match({ onNone: () => "", onSome: (bytes) => new TextDecoder().decode(bytes) })),
      Effect.scoped,
    ))

  /**
   * Parsed session_meta per session file, keyed by sessions dir then file path.
   * Discovery reruns on every local-projects subscribe, so each WebSocket
   * reconnect used to reopen and parse every Codex session file on the main
   * thread (~0.5 s per run on a real history). Codex appends to a session file
   * but never rewrites its first line, so an unchanged mtime + size means the
   * cached parse still holds.
   */
  const sessionCache = new Map<string, Map<string, CachedCodexSession>>()

  const readSessionIndex = Effect.fn("ProjectDiscovery.readCodexSessionIndex")(function* (indexPath: string) {
    const updatedAtById = new Map<string, number>()
    if (!(yield* pathExists(fs, indexPath))) {
      return updatedAtById
    }

    const text = yield* fs.readFileString(indexPath).pipe(Effect.catchTag("PlatformError", discoveryError(provider, indexPath)))
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      const record = decodeCodexSessionIndexLine(line)
      if (Option.isNone(record)) continue

      const updatedAt = Date.parse(record.value.updated_at)
      if (Number.isNaN(updatedAt)) continue

      const existing = updatedAtById.get(record.value.id)
      if (existing === undefined || updatedAt > existing) {
        updatedAtById.set(record.value.id, updatedAt)
      }
    }

    return updatedAtById
  })

  /**
   * Every *.jsonl under the sessions dir, with its stat. Subdirectories are
   * walked in parallel but flattened in listing order, so the file list (and
   * which duplicate session id wins) matches a serial walk. An entry that
   * vanishes mid-walk is skipped.
   */
  const collectSessionFiles = (directory: string): Effect.Effect<Array<{ filePath: string; info: FileSystem.File.Info }>, ProjectDiscoveryError> =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory).pipe(Effect.catchTag("PlatformError", discoveryError(provider, directory)))
      const nested = yield* Effect.forEach(names, (name) => Effect.gen(function* () {
        const filePath = path.join(directory, name)
        const info = yield* statOption(fs, filePath)
        if (Option.isNone(info)) return []
        if (info.value.type === "Directory") return yield* collectSessionFiles(filePath)
        if (info.value.type === "File" && name.endsWith(".jsonl")) return [{ filePath, info: info.value }]
        return []
      }), { concurrency: "unbounded" })
      return nested.flat()
    })

  const readSessionMetadata = Effect.fn("ProjectDiscovery.readCodexSessionMetadata")(function* (sessionsDir: string) {
    const metadataById = new Map<string, { cwd: string; modifiedAt: number }>()
    if (!(yield* pathExists(fs, sessionsDir))) {
      sessionCache.set(sessionsDir, new Map())
      return metadataById
    }

    const previous = sessionCache.get(sessionsDir)
    // Rebuilt from scratch each scan, so files that disappeared fall out.
    const next = new Map<string, CachedCodexSession>()
    const sessionFiles = yield* collectSessionFiles(sessionsDir)

    const results = yield* Effect.forEach(sessionFiles, ({ filePath, info }) => {
      const fileMtime = mtimeMs(info)
      const cached = previous?.get(filePath)
      if (cached && cached.mtimeMs === fileMtime && cached.size === info.size) {
        next.set(filePath, cached)
        return Effect.succeed(cached.metadata)
      }
      return readHead(filePath).pipe(
        Effect.map((head) => {
          const metadata = parseCodexSessionHead(head, fileMtime)
          next.set(filePath, { mtimeMs: fileMtime, size: info.size, metadata })
          return metadata
        }),
        // Codex can delete or rotate a session between listing and opening;
        // skip it rather than fail the whole discovery.
        Effect.catchTag("PlatformError", () => Effect.succeed(null)),
      )
    }, { concurrency: SCAN_CONCURRENCY })
    sessionCache.set(sessionsDir, next)

    for (const metadata of results) {
      if (!metadata) continue
      metadataById.set(metadata.sessionId, { cwd: metadata.cwd, modifiedAt: metadata.modifiedAt })
    }
    return metadataById
  })

  const readConfiguredProjects = Effect.fn("ProjectDiscovery.readCodexConfiguredProjects")(function* (configPath: string) {
    const projects = new Map<string, number>()
    const configStat = yield* statOption(fs, configPath)
    if (Option.isNone(configStat)) {
      return projects
    }

    const configMtime = mtimeMs(configStat.value)
    const text = yield* fs.readFileString(configPath).pipe(Effect.catchTag("PlatformError", discoveryError(provider, configPath)))
    for (const line of text.split("\n")) {
      const match = line.match(/^\[projects\."(.+)"\]$/)
      if (!match?.[1]) continue
      projects.set(match[1], configMtime)
    }

    return projects
  })

  const projectAt = (localPath: string, modifiedAt: number) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(localPath)) return null
      const normalizedPath = yield* normalizeExistingDirectory(fs, machine, localPath)
      if (Option.isNone(normalizedPath)) return null
      const project: ProviderDiscoveredProject = {
        provider,
        localPath: normalizedPath.value,
        title: path.basename(normalizedPath.value) || normalizedPath.value,
        modifiedAt,
      }
      return project
    })

  const scan = Effect.fn("ProjectDiscovery.scanCodex")(function* (homeDir: string) {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const [updatedAtById, metadataById, configuredProjects] = yield* Effect.all([
      readSessionIndex(indexPath),
      readSessionMetadata(sessionsDir),
      readConfiguredProjects(configPath),
    ], { concurrency: "unbounded" })

    const sessionProjects = yield* Effect.forEach(
      metadataById.entries(),
      ([sessionId, metadata]) => projectAt(metadata.cwd, updatedAtById.get(sessionId) ?? metadata.modifiedAt),
      { concurrency: SCAN_CONCURRENCY },
    )
    const configProjects = yield* Effect.forEach(
      configuredProjects.entries(),
      ([configuredPath, modifiedAt]) => projectAt(configuredPath, modifiedAt),
      { concurrency: SCAN_CONCURRENCY },
    )

    return asProviderProjects(provider, [...sessionProjects, ...configProjects].filter(isPresent))
  })

  const adapter: ProjectDiscoveryAdapter = { provider, scan }
  return adapter
})

const decodeUriComponentOption = Option.liftThrowable(decodeURIComponent)

/** Grok: one folder per working directory under ~/.grok/sessions, named for it URI-encoded. */
export const makeGrokDiscoveryAdapter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const provider = "grok" as const

  const scan = Effect.fn("ProjectDiscovery.scanGrok")(function* (homeDir: string) {
    const sessionsDir = path.join(homeDir, ".grok", "sessions")
    if (!(yield* pathExists(fs, sessionsDir))) return []

    // The grok CLI owns this directory and can delete or rewrite session
    // folders while we scan. Discovery runs at boot and on refresh for every
    // provider, so a folder that vanishes mid-scan is skipped, never thrown.
    const entries = yield* fs.readDirectory(sessionsDir).pipe(
      Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])),
    )

    const scanned = yield* Effect.forEach(entries, (name) => Effect.gen(function* () {
      const folderStat = yield* statOption(fs, path.join(sessionsDir, name))
      if (Option.isNone(folderStat) || folderStat.value.type !== "Directory") return null
      const cwd = decodeUriComponentOption(name)
      if (Option.isNone(cwd) || !path.isAbsolute(cwd.value)) return null
      const normalizedPath = yield* normalizeExistingDirectory(fs, machine, cwd.value)
      if (Option.isNone(normalizedPath)) return null
      const project: ProviderDiscoveredProject = {
        provider,
        localPath: normalizedPath.value,
        title: path.basename(normalizedPath.value) || normalizedPath.value,
        modifiedAt: mtimeMs(folderStat.value),
      }
      return project
    }), { concurrency: SCAN_CONCURRENCY })

    return asProviderProjects(provider, scanned.filter(isPresent))
  })

  const adapter: ProjectDiscoveryAdapter = { provider, scan }
  return adapter
})

export interface ProjectDiscoveryOptions {
  /** Defaults to Claude, Codex and Grok. */
  adapters?: ReadonlyArray<ProjectDiscoveryAdapter>
}

/**
 * Finds projects the user has worked in with any provider, from each
 * provider's own history on disk.
 *
 * Callers that arrive while a scan of the same home dir is running share its
 * result instead of starting another. Every client resubscribes to
 * local-projects on reconnect, and each subscribe asks for a fresh discovery;
 * a reconnect storm would otherwise stack one full scan per socket. The
 * project commands that refresh discovery also save the project in the
 * store, and the local-projects snapshot lists saved projects itself, so
 * joining a scan that started a moment earlier loses nothing.
 */
export class ProjectDiscovery extends Context.Service<ProjectDiscovery, {
  readonly discover: (homeDir?: string) => Effect.Effect<DiscoveredProject[], ProjectDiscoveryError>
}>()("@kanna/server/ProjectDiscovery") {
  static readonly layer = (options: ProjectDiscoveryOptions = {}) => Layer.effect(this, makeProjectDiscovery(options))
}

const makeProjectDiscovery = Effect.fn("ProjectDiscovery.make")(function* (options: ProjectDiscoveryOptions) {
  const adapters = options.adapters ?? [
    yield* makeClaudeDiscoveryAdapter,
    yield* makeCodexDiscoveryAdapter(),
    yield* makeGrokDiscoveryAdapter,
  ]
  const scope = yield* Effect.scope
  const machine = yield* Machine
  const inFlight = new Map<string, Deferred.Deferred<DiscoveredProject[], ProjectDiscoveryError>>()

  const runDiscovery = (homeDir: string) =>
    Effect.forEach(adapters, (adapter) => adapter.scan(homeDir), { concurrency: "unbounded" }).pipe(
      Effect.map((scans) => mergeDiscoveredProjects(
        scans.flatMap((projects) => projects.map(({ provider: _provider, ...project }) => project)),
      )),
    )

  const discover = Effect.fn("ProjectDiscovery.discover")(function* (homeDir: string = machine.homeDirectory) {
    const existing = inFlight.get(homeDir)
    if (existing) return yield* Deferred.await(existing)

    // The scan runs in the service's scope, not the caller's: a caller that
    // goes away doesn't cancel it for the others waiting on it.
    const deferred = yield* Deferred.make<DiscoveredProject[], ProjectDiscoveryError>()
    inFlight.set(homeDir, deferred)
    yield* runDiscovery(homeDir).pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        inFlight.delete(homeDir)
      }).pipe(Effect.andThen(Deferred.done(deferred, exit)))),
      Effect.forkIn(scope),
    )
    return yield* Deferred.await(deferred)
  })

  return { discover }
})
