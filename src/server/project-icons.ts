import { createHash } from "node:crypto"
import path from "node:path"
import { Clock, Context, Effect, FileSystem, Layer, Match, Option, PubSub, Ref, Schedule, Schema, Semaphore, Stream } from "effect"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { ProcessSpawner, type ProcessSpawnOptions } from "./platform/process-spawner"
import { readPngHeader, writePngThumbnail, type Background } from "./png-thumbnail"
import { capturePlatform } from "./platform"

/**
 * A project's icon, found in its own files.
 *
 * Three steps, each kept cheap:
 *
 * 1. List the files that could be an icon. In a git repo that is one
 *    `git ls-files` with a pathspec per convention, which reads the index and
 *    never the working tree, so `node_modules`, `Pods` and build output cost
 *    nothing. It covers the whole repo, so a monorepo with an iOS app three
 *    folders down is found as easily as a favicon at the root.
 * 2. Rank them (`rankIconCandidates`): nearest the root first, then by kind.
 * 3. Turn the winner into a small file under `<dataDir>/project-icons/`. The
 *    sidebar gets a URL to that file and nothing else, so the browser never
 *    decodes a 1024px app icon to draw 16px of it.
 *
 * The answer is kept in `index.json` beside the files, so a restart draws
 * every icon at once and re-checks in the background.
 */

export const PROJECT_ICON_URL_PREFIX = "/api/project-icons/"
/** Longest side of a stored icon. Covers a 32px slot on a 3x screen. */
const THUMBNAIL_SIZE = 96
/** Bumped when stored icons would come out different, so old ones are redone. */
const THUMBNAIL_VERSION = 1
/**
 * Bumped when the finder learns a convention it used to miss, so every
 * project is searched again at the next boot instead of when its last search
 * goes stale. 2: icon sets in a catalog's group folders, and Icon Composer.
 */
const FINDER_VERSION = 2
const ICON_FILE_PATTERN = /^[a-f0-9]{16}-[a-f0-9]{12}\.(png|svg|webp|jpg|gif|ico)$/

/** An image this small is stored as it is. */
const PASS_THROUGH_MAX_BYTES = 64 * 1024
/** Past this an image that can't be shrunk is given up on. */
const COPY_MAX_BYTES = 512 * 1024

const TICK_INTERVAL_MS = 15_000
/** How often a found icon's source file is stat'ed for changes. */
const SOURCE_CHECK_INTERVAL_MS = 2 * 60_000
/** How often a project with an icon is searched again, in case a better one appeared. */
const HIT_RESCAN_INTERVAL_MS = 60 * 60_000
const MISS_RESCAN_INTERVAL_MS = 20 * 60_000
/** The least time between two sidebar pushes during one pass. */
const CHANGE_NOTIFY_INTERVAL_MS = 500
const GIT_TIMEOUT_MS = 5_000

/**
 * Everything `classifyIconPath` can accept, as git pathspecs. Wider than the
 * classifier on purpose: git does the coarse cut and the classifier the fine.
 */
const GIT_PATHSPECS = [
  "**/*.appiconset/Contents.json",
  "**/*.icon/icon.json",
  "**/mipmap-*/ic_launcher*",
  "**/ic_launcher-playstore.png",
  "**/app.json",
  "**/app.config.*",
  "**/favicon.svg",
  "**/favicon.png",
  "**/favicon.ico",
  "**/apple-touch-icon.png",
  "**/apple-icon.png",
  "**/icon.svg",
  "**/icon.png",
  "**/icon.icns",
  "**/icon.ico",
  "**/icons/*x*.png",
  "**/logo.svg",
  "**/logo.png",
].map((pattern) => `:(glob)${pattern}`)

/** Never descended into by the fallback walk. Git's ignore rules do this for the main path. */
const WALK_SKIP_DIRS = new Set([
  "node_modules", "Pods", "Carthage", "DerivedData", "dist", "out", "target", "vendor", "venv",
  "coverage", "__pycache__", "tmp", "temp",
])
const WALK_MAX_DIRS = 400
const WALK_MAX_DEPTH = 8

/** Folders that hold a copy of someone else's project, or a throwaway one. */
const NOISE_SEGMENT = /^(examples?|samples?|demos?|tests?|__tests__|__fixtures__|fixtures?|templates?|mocks?|e2e|specs?|third[-_]?party|vendor|archived?|deprecated|legacy)$/i
/** Folders that hold a site about the project rather than the project. */
const SIDE_SEGMENT = /^(docs?|documentation|website|site|landing|marketing|storybook|blog)$/i
/** An app's lesser targets, each with an icon set of its own. */
const LESSER_TARGET = /(watch|widget|extension|appclip|sticker|imessage|tests)/i
/** Folders an icon sits in that say nothing about where the app is. */
const ASSET_DIRS = new Set(["public", "static", "assets", "images", "img"])
const APP_ICON_DIRS = new Set([...ASSET_DIRS, "build", "resources", "buildResources", "electron", "icons"])
const LOGO_DIRS = new Set([...ASSET_DIRS, ".github", "media", "brand", "branding"])
const ANDROID_DENSITIES = ["xhdpi", "xxhdpi", "xxxhdpi", "hdpi", "mdpi"]
const EXTENSION_ORDER: Record<string, number> = { svg: 0, png: 0.1, webp: 0.1, icns: 0.2, ico: 0.3 }

export interface IconCandidate {
  /** Relative to the project, forward slashes. */
  path: string
  /**
   * What the path is: the image itself, or a file that names it (an asset
   * catalog's `Contents.json`, an Expo config).
   */
  kind: "image" | "appiconset" | "icon-composer" | "expo-config"
  /** Lower is better. */
  score: number
}

/** Segments left once the trailing folders in `dirs` are dropped. */
function stripTrailing(segments: string[], dirs: ReadonlySet<string>) {
  let end = segments.length
  while (end > 0 && dirs.has(segments[end - 1]!)) end -= 1
  return segments.slice(0, end)
}

/**
 * Scores one path, or returns null when it is not an icon by any convention
 * known here. The score is `depth * 10 + kind + detail`:
 *
 * - depth is how far down the app sits, not the file. `public/favicon.svg`
 *   and `MyApp/Assets.xcassets/AppIcon.appiconset/Contents.json` are both an
 *   app at the root, depth 0.
 * - kind orders the conventions at one depth: web, Expo, iOS, Android, Tauri,
 *   Electron and loose `icon.png` files, then logos.
 * - detail orders the files of one app: the Android density nearest the size
 *   needed, SVG before PNG before ICO.
 */
export function classifyIconPath(relativePath: string): IconCandidate | null {
  const segments = relativePath.split("/")
  const name = segments[segments.length - 1]!
  const dirs = segments.slice(0, -1)
  const parent = dirs[dirs.length - 1]
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()

  let penalty = 0
  for (const segment of dirs) {
    if (NOISE_SEGMENT.test(segment)) penalty += 100
    else if (SIDE_SEGMENT.test(segment)) penalty += 15
  }
  const candidate = (kind: IconCandidate["kind"], appDirs: string[], rank: number, detail = 0): IconCandidate => ({
    path: relativePath,
    kind,
    score: penalty + appDirs.length * 10 + rank + detail,
  })

  // iOS and macOS: <App>/<Name>.xcassets/[<Group>/...]<Set>.appiconset/Contents.json
  // A catalog can file its sets in group folders, so the set needn't sit
  // directly in it.
  if (name === "Contents.json") {
    if (!parent?.endsWith(".appiconset")) return null
    let catalogIndex = dirs.length - 2
    while (catalogIndex >= 0 && !dirs[catalogIndex]!.endsWith(".xcassets")) catalogIndex -= 1
    if (catalogIndex < 0) return null
    const before = dirs.slice(0, catalogIndex)
    if (before.some((segment) => LESSER_TARGET.test(segment))) penalty += 30
    // The folder holding the catalog is the app's own; what counts is where that is.
    // Behind an Icon Composer icon of the same app: a project that has one has moved to it.
    return candidate("appiconset", before.slice(0, -1), 2, parent === "AppIcon.appiconset" ? 0.5 : 1)
  }

  // Xcode 26's Icon Composer: <App>/<Name>.icon/icon.json, layers in Assets/.
  if (name === "icon.json") {
    if (!parent?.endsWith(".icon")) return null
    const before = dirs.slice(0, -1)
    if (before.some((segment) => LESSER_TARGET.test(segment))) penalty += 30
    // Alternate icons sit beside the main one under names of their own.
    return candidate("icon-composer", before.slice(0, -1), 2, /^(App)?Icon\.icon$/.test(parent) ? 0 : 0.1)
  }

  // Android: <module>/src/<variant>/res/mipmap-<density>/ic_launcher.png
  if (parent?.startsWith("mipmap-")) {
    const launcher = /^ic_launcher(_round)?\.(png|webp)$/.exec(name)
    const density = ANDROID_DENSITIES.indexOf(parent.slice("mipmap-".length))
    if (!launcher || density < 0 || dirs[dirs.length - 2] !== "res") return null
    let moduleDirs = dirs.slice(0, -2)
    if (moduleDirs[moduleDirs.length - 2] === "src") {
      if (moduleDirs[moduleDirs.length - 1] !== "main") penalty += 3
      moduleDirs = moduleDirs.slice(0, -2)
    }
    return candidate("image", moduleDirs.slice(0, -1), 3, density * 0.01 + (launcher[1] ? 0.005 : 0))
  }
  if (name === "ic_launcher-playstore.png") {
    if (dirs[dirs.length - 2] !== "src") return null
    return candidate("image", dirs.slice(0, -3), 3, 0.06)
  }

  if (name === "app.json" || /^app\.config\.(js|ts|mjs|cjs)$/.test(name)) {
    return candidate("expo-config", dirs, 1, name === "app.json" ? 0 : 0.01)
  }

  if (/^favicon\.(svg|png|ico)$/.test(name) || name === "apple-touch-icon.png" || name === "apple-icon.png") {
    const appDirs = stripTrailing(stripTrailing(dirs, ASSET_DIRS), new Set(["app", "src"]))
    const detail = name === "favicon.svg" ? 0 : name.startsWith("apple-") ? 0.1 : name === "favicon.png" ? 0.2 : 0.3
    return candidate("image", appDirs, 0, detail)
  }

  // Tauri and electron-builder keep sized copies: icons/128x128.png
  const sized = /^(\d+)x\1(@2x)?\.png$/.exec(name)
  if (sized) {
    const size = Number(sized[1]) * (sized[2] ? 2 : 1)
    const holder = dirs[dirs.length - 2]
    if (parent !== "icons" || size < 64 || !holder || !(holder === "src-tauri" || APP_ICON_DIRS.has(holder))) return null
    // The smallest that still covers the thumbnail, so there is the least to read.
    const detail = size >= THUMBNAIL_SIZE ? Math.min(0.4, size / 10_000) : 0.5
    return candidate("image", stripTrailing(dirs.slice(0, -2), APP_ICON_DIRS), holder === "src-tauri" ? 4 : 5, detail)
  }

  if (/^icon\.(svg|png|icns|ico)$/.test(name)) {
    const detail = EXTENSION_ORDER[extension] ?? 0.4
    // Next.js: app/icon.png is the favicon.
    if (parent === "app") return candidate("image", stripTrailing(dirs, new Set(["app", "src"])), 0, 0.15 + detail / 10)
    if (parent === ".idea") return candidate("image", dirs.slice(0, -1), 8, detail)
    if (parent === "icons" && dirs[dirs.length - 2] === "src-tauri") return candidate("image", dirs.slice(0, -2), 4, 0.45 + detail / 10)
    if (parent === undefined || APP_ICON_DIRS.has(parent)) return candidate("image", stripTrailing(dirs, APP_ICON_DIRS), 5, detail)
    return null
  }

  if (/^logo\.(svg|png)$/.test(name)) {
    if (parent !== undefined && !LOGO_DIRS.has(parent)) return null
    return candidate("image", stripTrailing(dirs, LOGO_DIRS), 7, EXTENSION_ORDER[extension] ?? 0.4)
  }

  return null
}

/** The paths that are icons, best first. Ties go to the shorter path, then by name. */
export function rankIconCandidates(relativePaths: readonly string[]): IconCandidate[] {
  const candidates: IconCandidate[] = []
  for (const relativePath of relativePaths) {
    const candidate = classifyIconPath(relativePath)
    if (candidate) candidates.push(candidate)
  }
  return candidates.sort((left, right) => (
    left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path)
  ))
}

export class ProjectIconFileError extends Schema.TaggedError<ProjectIconFileError>()(
  "@kanna/server/project-icons/ProjectIconFileError",
  {
    operation: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const FILE_ERROR = "@kanna/server/project-icons/ProjectIconFileError"
const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new ProjectIconFileError({ operation, filePath, cause })

/**
 * `FileSystemExtras.stat` rather than `FileSystem`'s: the platform's stat
 * rounds mtime to whole milliseconds, and `mtimeMs` is stored in
 * `index.json` and hashed into file names, so a rounded value would redo
 * every icon.
 */
const statFile = (filePath: string) =>
  FileSystemExtras.use((files) => files.stat(filePath)).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(fileError("stat", filePath)(cause))),
  )

/**
 * Runs a short-lived child to its end, with its stdout as text when piped.
 * Killed (SIGTERM) after `GIT_TIMEOUT_MS`, and if the caller is interrupted
 * first. Succeeds with the exit code (null when a signal ended it).
 */
const runChild = (operation: string, cwd: string, argv: ReadonlyArray<string>, options: ProcessSpawnOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const child = yield* spawner.spawn(argv, options)
    yield* child.kill().pipe(Effect.delay(GIT_TIMEOUT_MS), Effect.forkScoped)
    const [output, exit] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(child.stdout)),
      child.exited,
    ], { concurrency: "unbounded" })
    return { output, exitCode: exit.exitCode }
  }).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (cause) => Effect.fail(fileError(operation, cwd)(cause))),
    Effect.scoped,
  )

/** Candidate paths git tracks under `root`, or null when `root` is not in a repo. */
const listTrackedPaths = Effect.fn("ProjectIcons.listTrackedPaths")(function* (root: string) {
  const machine = yield* Machine
  return yield* runChild("git ls-files", root, ["git", "ls-files", "-z", "--", ...GIT_PATHSPECS], {
    cwd: root,
    stdout: "pipe",
    env: { ...machine.env.snapshot(), GIT_OPTIONAL_LOCKS: "0" },
  }).pipe(
    Effect.map(({ output, exitCode }) => (exitCode === 0 ? output.split("\0").filter(Boolean) : null)),
    Effect.catchTag(FILE_ERROR, () => Effect.succeed(null)),
  )
})

/**
 * Candidate paths by reading folders, breadth first and bounded. For a
 * project outside git, and for one whose icon git doesn't track yet.
 *
 * `FileSystemExtras.readDirectoryEntries`: the walk needs each entry's type,
 * which `FileSystem.readDirectory` doesn't give without a stat per entry.
 */
const walkForPaths = Effect.fn("ProjectIcons.walkForPaths")(function* (root: string) {
  const files = yield* FileSystemExtras
  const found: string[] = []
  let queue: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < WALK_MAX_DIRS) {
    const next: typeof queue = []
    for (const { dir, depth } of queue) {
      if (visited >= WALK_MAX_DIRS) break
      visited += 1
      const directory = path.join(root, dir)
      const entries = yield* files.readDirectoryEntries(directory).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)))
      if (!entries) continue
      for (const entry of entries) {
        const relativePath = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.kind === "File") {
          if (classifyIconPath(relativePath)) found.push(relativePath)
          continue
        }
        if (entry.kind !== "Directory" || depth >= WALK_MAX_DEPTH || WALK_SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith(".") && entry.name !== ".idea" && entry.name !== ".github") continue
        // `build` is where electron-builder keeps its icon, and also where
        // every other tool writes its output: look at it, go no deeper than
        // its `icons`.
        if (path.basename(dir) === "build" && entry.name !== "icons") continue
        next.push({ dir: relativePath, depth: depth + 1 })
      }
    }
    queue = next
  }
  return found
})

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|svg|gif|icns|ico)$/i

function resolveInside(root: string, baseDir: string, target: string) {
  const resolved = path.resolve(root, baseDir, target)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null
}

/** Reads a small JSON file and decodes it, or None when it is missing or not that shape. */
const readJsonFile = <A>(filePath: string, decode: (text: string) => Option.Option<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(filePath).pipe(Effect.option)
    return Option.flatMap(text, decode)
  })

const AppIconSetContents = Schema.Struct({
  images: Schema.optionalKey(Schema.Array(Schema.Struct({
    filename: Schema.optionalKey(Schema.Unknown),
    size: Schema.optionalKey(Schema.Unknown),
    scale: Schema.optionalKey(Schema.Unknown),
    appearances: Schema.optionalKey(Schema.Unknown),
  }))),
})
const decodeAppIconSetContents = Schema.decodeUnknownOption(Schema.fromJsonString(AppIconSetContents))

/**
 * The image an asset catalog's icon set draws from: its largest, which is the
 * 1024px source. Since Xcode 14 that is the only one a set has to hold, and
 * in older sets it is the one the rest were cut from.
 */
const resolveAppIconSet = Effect.fn("ProjectIcons.resolveAppIconSet")(function* (setDir: string) {
  const contents = yield* readJsonFile(path.join(setDir, "Contents.json"), decodeAppIconSetContents)
  if (Option.isNone(contents)) return null
  let best: { filename: string; pixels: number } | null = null
  for (const image of contents.value.images ?? []) {
    if (typeof image.filename !== "string" || !/\.(png|jpe?g)$/i.test(image.filename)) continue
    if (image.filename.includes("/") || image.filename.includes("\\")) continue
    const points = typeof image.size === "string" ? Number.parseFloat(image.size) : Number.NaN
    const scale = typeof image.scale === "string" ? Number.parseFloat(image.scale) : 1
    let pixels = Number.isFinite(points) ? points * (Number.isFinite(scale) ? scale : 1) : 1
    // Dark and tinted variants are the same size; the plain one is the icon.
    if (image.appearances) pixels -= 0.5
    if (!best || pixels > best.pixels) best = { filename: image.filename, pixels }
  }
  return best ? path.join(setDir, best.filename) : null
})

/** A colour in Icon Composer's form, `srgb:0.07843,0.08235,0.10196,1.00000`. */
function parseIconComposerColor(value: unknown): Background | null {
  if (typeof value !== "string") return null
  const match = /^(?:srgb|extended-srgb|display-p3):([\d.]+),([\d.]+),([\d.]+)/.exec(value)
    ?? /^(?:gray|extended-gray):([\d.]+)/.exec(value)
  if (!match) return null
  const channels = (match.length === 4 ? match.slice(1, 4) : [match[1], match[1], match[1]]).map(Number)
  return channels.every((channel) => Number.isFinite(channel))
    ? channels.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255)) as unknown as Background
    : null
}

const IconComposerFile = Schema.Struct({
  fill: Schema.optionalKey(Schema.Unknown),
  groups: Schema.optionalKey(Schema.Array(Schema.Struct({
    layers: Schema.optionalKey(Schema.Array(Schema.Struct({
      "image-name": Schema.optionalKey(Schema.Unknown),
    }))),
  }))),
})
const decodeIconComposerFile = Schema.decodeUnknownOption(Schema.fromJsonString(IconComposerFile))

/**
 * An Icon Composer icon is layers over a fill, composed by the system at
 * build time, so there is no finished image to read. This takes the layer
 * image with the most to it (the largest file: the artwork, not a sparkle on
 * top) and the fill as the colour to draw it over. A single-layer icon, the
 * common case, comes out as it looks.
 */
const resolveIconComposer = Effect.fn("ProjectIcons.resolveIconComposer")(function* (bundleDir: string) {
  const file = yield* readJsonFile(path.join(bundleDir, "icon.json"), decodeIconComposerFile)
  if (Option.isNone(file)) return null
  const icon = file.value
  let best: { path: string; size: number } | null = null
  for (const group of icon.groups ?? []) {
    for (const layer of group.layers ?? []) {
      const imageName = layer["image-name"]
      if (typeof imageName !== "string" || !IMAGE_EXTENSIONS.test(imageName)) continue
      if (imageName.includes("/") || imageName.includes("\\")) continue
      const layerPath = path.join(bundleDir, "Assets", imageName)
      const info = yield* statFile(layerPath).pipe(Effect.catchTag(FILE_ERROR, () => Effect.succeed(null)))
      if (info?.kind === "File" && (!best || info.size > best.size)) best = { path: layerPath, size: info.size }
    }
  }
  if (!best) return null
  // `{ "solid": colour }`, `{ "automatic-gradient": colour }`, or a gradient's
  // list of colours, of which the first will do at this size.
  const fill = icon.fill && typeof icon.fill === "object" ? Object.values(icon.fill)[0] : null
  return { path: best.path, background: parseIconComposerColor(Array.isArray(fill) ? fill[0] : fill) }
})

/** `value[key]` when `value` is an object, as JSON property access reads it. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** The icon an Expo config names, relative to the config. */
const resolveExpoIcon = Effect.fn("ProjectIcons.resolveExpoIcon")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* Effect.scoped(
    fs.open(configPath, { flag: "r" }).pipe(Effect.flatMap((file) => file.readAlloc(64 * 1024))),
  ).pipe(Effect.option)
  if (Option.isNone(bytes)) return null
  const text = Option.match(bytes.value, {
    onNone: () => "",
    onSome: (read) => Buffer.from(read.buffer, read.byteOffset, read.byteLength).toString("utf8"),
  })
  if (configPath.endsWith(".json")) {
    return Option.match(decodeJson(text), {
      onNone: () => null,
      onSome: (json) => {
        const expo = field(json, "expo") ?? json
        const named = [
          field(expo, "icon"),
          field(field(expo, "ios"), "icon"),
          field(field(expo, "android"), "icon"),
          field(field(field(expo, "android"), "adaptiveIcon"), "foregroundImage"),
        ].find((value) => typeof value === "string" && IMAGE_EXTENSIONS.test(value))
        return typeof named === "string" ? named : null
      },
    })
  }
  return /\bicon\s*:\s*["'`]([^"'`\n]+\.(?:png|jpe?g|webp|svg))["'`]/i.exec(text)?.[1] ?? null
})

interface IconSource {
  path: string
  /** A colour to draw the image over; for Icon Composer, whose fill is not in the image. */
  background: Background | null
}

const resolveCandidateSource = Effect.fn("ProjectIcons.resolveCandidateSource")(function* (
  root: string,
  candidate: IconCandidate,
) {
  const bare = (sourcePath: string | null): IconSource | null => (sourcePath ? { path: sourcePath, background: null } : null)
  return yield* Match.value(candidate.kind).pipe(
    Match.when("appiconset", () => resolveAppIconSet(path.join(root, path.dirname(candidate.path))).pipe(Effect.map(bare))),
    Match.when("icon-composer", () => resolveIconComposer(path.join(root, path.dirname(candidate.path)))),
    Match.when("expo-config", () =>
      resolveExpoIcon(path.join(root, candidate.path)).pipe(
        Effect.map((named) => bare(named ? resolveInside(root, path.dirname(candidate.path), named) : null)),
      )),
    Match.when("image", () => Effect.succeed(bare(path.join(root, candidate.path)))),
    Match.exhaustive,
  )
})

/**
 * `.icns` is a list of the icon at each size, most of them whole PNG files.
 * Reads the list's 8-byte headers and copies out the smallest PNG that covers
 * the thumbnail, so a 1 MB file costs a few seeks and one small read.
 */
const extractIcnsPng = Effect.fn("ProjectIcons.extractIcnsPng")(function* (sourcePath: string, targetPath: string) {
  const fs = yield* FileSystem.FileSystem
  // Smallest first that is big enough, then the one below as a last resort.
  const preferred = ["ic07", "ic13", "ic08", "ic14", "ic09", "ic10", "ic12"]
  const chosen = yield* Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(sourcePath, { flag: "r" })
    const header = Buffer.alloc(16)
    const size = Number((yield* file.stat).size)
    const readAt = (length: number, offset: number) => file.read(header.subarray(0, length), { position: BigInt(offset) })
    if ((yield* readAt(8, 0)) < 8 || header.toString("latin1", 0, 4) !== "icns") return null
    let found: { start: number; length: number; order: number } | null = null
    let offset = 8
    while (offset + 8 <= size) {
      if ((yield* readAt(16, offset)) < 8) break
      const length = header.readUInt32BE(4)
      if (length < 8) break
      const order = preferred.indexOf(header.toString("latin1", 0, 4))
      // Some writers store JPEG 2000 under the same names; only PNG is any use here.
      const isPng = header.readUInt32BE(8) === 0x89504e47
      if (order >= 0 && isPng && (!found || order < found.order)) {
        found = { start: offset + 8, length: length - 8, order }
      }
      offset += length
    }
    return found
  }))
  if (!chosen) return false
  yield* fs.stream(sourcePath, { offset: chosen.start, bytesToRead: chosen.length }).pipe(Stream.run(fs.sink(targetPath)))
  return true
}, (effect, sourcePath) => effect.pipe(
  Effect.catchTag("PlatformError", (cause) =>
    Effect.fail(new ProjectIconFileError({ operation: "extract icns", filePath: sourcePath, cause }))),
))

/** macOS's own image tool, for what the PNG reader can't take. Decodes in its process, not this one. */
const resizeWithSips = Effect.fn("ProjectIcons.resizeWithSips")(function* (sourcePath: string, targetPath: string) {
  const machine = yield* Machine
  if (machine.platform !== "darwin") return false
  return yield* runChild(
    "sips",
    sourcePath,
    ["/usr/bin/sips", "-s", "format", "png", "-Z", String(THUMBNAIL_SIZE), sourcePath, "--out", targetPath],
    {},
  ).pipe(
    Effect.map(({ exitCode }) => exitCode === 0),
    Effect.catchTag(FILE_ERROR, () => Effect.succeed(false)),
  )
})

/**
 * Writes the stored form of `sourcePath` to `<targetBase>.<ext>` and returns
 * the extension, or null when the source can't be made small.
 */
const writeIconFile = Effect.fn("ProjectIcons.writeIconFile")(function* (
  sourcePath: string,
  sourceSize: number,
  targetBase: string,
  background: Background | null,
) {
  const fs = yield* FileSystem.FileSystem
  const extension = path.extname(sourcePath).slice(1).toLowerCase()
  const copyAs = (as: string) =>
    fs.copyFile(sourcePath, `${targetBase}.${as}`).pipe(
      Effect.as(as),
      Effect.catchTag("PlatformError", (cause) => Effect.fail(new ProjectIconFileError({ operation: "copy", filePath: sourcePath, cause }))),
    )

  if (extension === "svg" || extension === "ico") {
    return sourceSize <= COPY_MAX_BYTES ? yield* copyAs(extension) : null
  }

  if (extension === "icns") {
    const extracted = `${targetBase}.icns.tmp`
    return yield* Effect.gen(function* () {
      if (!(yield* extractIcnsPng(sourcePath, extracted))) return null
      const header = yield* readPngHeader(extracted)
      if (header && Math.max(header.width, header.height) <= THUMBNAIL_SIZE * 2) {
        yield* fs.rename(extracted, `${targetBase}.png`).pipe(
          Effect.catchTag("PlatformError", (cause) => Effect.fail(new ProjectIconFileError({ operation: "rename", filePath: extracted, cause }))),
        )
      } else {
        yield* writePngThumbnail(extracted, `${targetBase}.png`, THUMBNAIL_SIZE)
      }
      return "png"
    }).pipe(
      Effect.catchTags({
        [FILE_ERROR]: () => Effect.succeed(null),
        "@kanna/server/png-thumbnail/PngFileError": () => Effect.succeed(null),
        "@kanna/server/png-thumbnail/UnsupportedPngError": () => Effect.succeed(null),
      }),
      Effect.ensuring(fs.remove(extracted, { force: true }).pipe(Effect.ignore)),
    )
  }

  if (extension === "png") {
    const header = yield* readPngHeader(sourcePath)
    if (!header) return null
    // A background has to be drawn in, so the image goes through even when small.
    if (!background && Math.max(header.width, header.height) <= THUMBNAIL_SIZE * 2 && sourceSize <= PASS_THROUGH_MAX_BYTES) {
      return yield* copyAs("png")
    }
    const written = yield* writePngThumbnail(sourcePath, `${targetBase}.png`, THUMBNAIL_SIZE, background ?? undefined).pipe(
      Effect.as(true),
      // Interlaced, or not what its header says. Falls through to sips.
      Effect.catchTags({
        "@kanna/server/png-thumbnail/PngFileError": () => Effect.succeed(false),
        "@kanna/server/png-thumbnail/UnsupportedPngError": () => Effect.succeed(false),
      }),
    )
    if (written) return "png"
  } else if (!/^(webp|jpe?g|gif)$/.test(extension)) {
    return null
  } else if (sourceSize <= PASS_THROUGH_MAX_BYTES) {
    return yield* copyAs(extension === "jpeg" ? "jpg" : extension)
  }

  if (yield* resizeWithSips(sourcePath, `${targetBase}.png`)) return "png"
  return sourceSize <= COPY_MAX_BYTES ? yield* copyAs(extension === "jpeg" ? "jpg" : extension) : null
})

function shortHash(value: string, length: number) {
  return createHash("sha1").update(value).digest("hex").slice(0, length)
}

const IconRecordSchema = Schema.Struct({
  /** Name under the icons dir, or null when the project has no icon. */
  file: Schema.NullOr(Schema.String),
  /** The image `file` was made from, with what it looked like then. */
  source: Schema.optionalKey(Schema.String),
  mtimeMs: Schema.optionalKey(Schema.Number),
  size: Schema.optionalKey(Schema.Number),
  /** The colour it was drawn over, `r,g,b`, when there was one. */
  background: Schema.optionalKey(Schema.String),
  scannedAt: Schema.Number,
})
type IconRecord = typeof IconRecordSchema.Type

const IconIndexSchema = Schema.Struct({
  version: Schema.Number,
  finder: Schema.optionalKey(Schema.Number),
  projects: Schema.Record(Schema.String, IconRecordSchema),
})
type IconIndex = typeof IconIndexSchema.Type

export interface FoundProjectIcon {
  file: string
  source: string
  mtimeMs: number
  size: number
  background?: string
}

/**
 * Finds `root`'s icon and stores it under `iconsDir`. `previous` is the last
 * answer: when the same source is unchanged its stored file is reused.
 */
export const findProjectIcon = Effect.fn("ProjectIcons.findProjectIcon")(function* (
  root: string,
  iconsDir: string,
  previous?: IconRecord,
) {
  yield* Effect.annotateCurrentSpan("projectPath", root)
  const tracked = yield* listTrackedPaths(root)
  let candidates = tracked ? rankIconCandidates(tracked) : []
  if (candidates.length === 0) candidates = rankIconCandidates(yield* walkForPaths(root))
  // A dozen is every plausible icon; past that they are logos in odd corners.
  for (const candidate of candidates.slice(0, 12)) {
    const resolved = yield* resolveCandidateSource(root, candidate)
    if (!resolved) continue
    const source = resolved.path
    const info = yield* statFile(source).pipe(Effect.catchTag(FILE_ERROR, () => Effect.succeed(null)))
    if (!info || info.kind !== "File" || info.size === 0) continue
    const found = {
      source,
      mtimeMs: info.mtimeMs,
      size: info.size,
      ...(resolved.background ? { background: resolved.background.join(",") } : {}),
    }
    if (
      previous?.file && previous.source === source && previous.mtimeMs === info.mtimeMs
      && previous.size === info.size && previous.background === found.background
    ) {
      return { file: previous.file, ...found } satisfies FoundProjectIcon
    }
    const base = `${shortHash(root, 16)}-${shortHash(`${THUMBNAIL_VERSION}\0${source}\0${info.mtimeMs}\0${info.size}\0${found.background ?? ""}`, 12)}`
    const extension = yield* writeIconFile(source, info.size, path.join(iconsDir, base), resolved.background).pipe(
      Effect.catchTags({
        [FILE_ERROR]: () => Effect.succeed(null),
        "@kanna/server/png-thumbnail/PngFileError": () => Effect.succeed(null),
      }),
    )
    if (extension) return { file: `${base}.${extension}`, ...found } satisfies FoundProjectIcon
  }
  return null
})

/** The stored file a project icon URL names, or null for anything else. */
export function resolveProjectIconPath(dataDir: string, pathname: string): string | null {
  if (!pathname.startsWith(PROJECT_ICON_URL_PREFIX)) return null
  const name = pathname.slice(PROJECT_ICON_URL_PREFIX.length)
  return ICON_FILE_PATTERN.test(name) ? path.join(dataDir, "project-icons", name) : null
}

export interface ProjectIconsOptions {
  dataDir: string
  /** The paths of the live projects, read at each pass. */
  projectPaths: Effect.Effect<ReadonlyArray<string>>
}

/**
 * Every project's icon, kept under `<dataDir>/project-icons/` and re-checked
 * in the background once `start` has run.
 *
 * `changes` emits after a pass changes an icon (batched, at most one per
 * 500 ms within a pass), never on subscribe; read `urls` for the current map.
 */
export class ProjectIcons extends Context.Service<ProjectIcons, {
  /** Project path to icon URL, for the sidebar builder. Projects without an icon are absent. */
  readonly urls: Effect.Effect<ReadonlyMap<string, string>>
  readonly changes: Stream.Stream<void>
  /** Runs a pass now and then every 15 s, until the layer closes. Idempotent. */
  readonly start: Effect.Effect<void>
  /** One pass over the projects; skipped when one is already running. */
  readonly tick: (nowMs?: number) => Effect.Effect<void>
}>()("@kanna/server/ProjectIcons") {
  static readonly layer = (options: ProjectIconsOptions) => Layer.effect(this, makeProjectIcons(options))
}

const makeProjectIcons = Effect.fn("ProjectIcons.make")(function* (options: ProjectIconsOptions) {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* capturePlatform<FileSystem.FileSystem | FileSystemExtras | Machine | ProcessSpawner>()
  const iconsDir = path.join(options.dataDir, "project-icons")
  const indexPath = path.join(iconsDir, "index.json")
  // Touched only inside `tick`, which the semaphore keeps to one at a time.
  /** By project path. */
  const records = new Map<string, IconRecord>()
  /** When each found icon's source was last stat'ed. Not kept across restarts. */
  const sourceCheckedAt = new Map<string, number>()
  let indexDirty = false
  const urls = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
  const changes = yield* PubSub.unbounded<void>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
  const ticking = yield* Semaphore.make(1)
  const started = yield* Ref.make(false)

  const rebuildUrls = Effect.suspend(() => Ref.set(urls, new Map(
    [...records].flatMap(([projectPath, record]) =>
      record.file ? [[projectPath, `${PROJECT_ICON_URL_PREFIX}${record.file}`] as const] : []),
  )))

  const removeIcon = (name: string) =>
    fs.remove(path.join(iconsDir, name), { force: true }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new ProjectIconFileError({ operation: "remove", filePath: path.join(iconsDir, name), cause }))),
    )

  // Before the first sidebar is built: a few kilobytes read once so the first
  // paint after a restart already has its icons. No index yet, or an
  // unreadable one, and everything is searched afresh.
  const loaded = yield* Effect.gen(function* () {
    yield* fs.makeDirectory(iconsDir, { recursive: true })
    const index = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(IconIndexSchema))(yield* fs.readFileString(indexPath))
    return { index, present: new Set(yield* fs.readDirectory(iconsDir)) }
  }).pipe(Effect.option)
  if (Option.isSome(loaded)) {
    const { index, present } = loaded.value
    // Icons drawn some other way are all redone; the files go below.
    const projects = index.version === THUMBNAIL_VERSION ? index.projects : {}
    // Kept, so their icons show meanwhile, and due at once.
    const stale = index.finder !== FINDER_VERSION
    for (const [projectPath, record] of Object.entries(projects)) {
      // A stored file that has gone missing is a project to search again.
      if (record.file && !present.has(record.file)) continue
      records.set(projectPath, stale ? { ...record, scannedAt: 0 } : record)
      if (record.file) present.delete(record.file)
    }
    // What is left belongs to no project: a crash between writing an icon
    // and writing the index, or an index from another thumbnail version.
    yield* Effect.forEach(
      [...present].filter((name) => ICON_FILE_PATTERN.test(name)),
      (name) => removeIcon(name).pipe(Effect.ignore),
    ).pipe(Effect.forkScoped)
    yield* rebuildUrls
  }

  /** Returns whether the project's icon changed. */
  const refresh = Effect.fn("ProjectIcons.refresh")(function* (projectPath: string, nowMs: number) {
    const record = records.get(projectPath)
    if (record) {
      const scanAge = nowMs - record.scannedAt
      if (!record.file) {
        if (scanAge < MISS_RESCAN_INTERVAL_MS) return false
      } else if (scanAge < HIT_RESCAN_INTERVAL_MS) {
        if (nowMs - (sourceCheckedAt.get(projectPath) ?? 0) < SOURCE_CHECK_INTERVAL_MS) return false
        sourceCheckedAt.set(projectPath, nowMs)
        const info = yield* statFile(record.source!).pipe(Effect.catchTag(FILE_ERROR, () => Effect.succeed(null)))
        if (info && info.mtimeMs === record.mtimeMs && info.size === record.size) return false
      }
    }

    const found = yield* findProjectIcon(projectPath, iconsDir, record)
    sourceCheckedAt.set(projectPath, nowMs)
    records.set(projectPath, found ? { ...found, scannedAt: nowMs } : { file: null, scannedAt: nowMs })
    indexDirty = true
    const previousFile = record?.file ?? null
    const file = found?.file ?? null
    if (previousFile === file) return false
    if (previousFile) yield* removeIcon(previousFile)
    return true
  })

  /** Writes the index, and drops projects that are gone along with their files. */
  const persist = Effect.fn("ProjectIcons.persist")(function* () {
    indexDirty = false
    const live = new Set(yield* options.projectPaths)
    for (const [projectPath, record] of records) {
      if (live.has(projectPath)) continue
      records.delete(projectPath)
      sourceCheckedAt.delete(projectPath)
      if (record.file) yield* removeIcon(record.file)
    }
    const index: IconIndex = { version: THUMBNAIL_VERSION, finder: FINDER_VERSION, projects: Object.fromEntries(records) }
    const temporaryPath = `${indexPath}.tmp`
    // The index is a cache: without it the next boot searches again.
    yield* fs.writeFileString(temporaryPath, JSON.stringify(index)).pipe(
      Effect.andThen(fs.rename(temporaryPath, indexPath)),
      Effect.ignore,
    )
  })

  /**
   * One pass over the projects, one at a time. With nothing due it is a map
   * lookup and two comparisons per project.
   */
  const pass = Effect.fn("ProjectIcons.tick")(function* (nowMs?: number) {
    const now = nowMs ?? (yield* Clock.currentTimeMillis)
    // The first pass after an install finds an icon for every project in
    // turn. Each push re-derives the whole sidebar, so they go out in batches.
    let unannounced = false
    let announcedAt = yield* Clock.currentTimeMillis
    for (const projectPath of yield* options.projectPaths) {
      if (!(yield* refresh(projectPath, now))) continue
      yield* rebuildUrls
      unannounced = true
      if ((yield* Clock.currentTimeMillis) - announcedAt < CHANGE_NOTIFY_INTERVAL_MS) continue
      unannounced = false
      announcedAt = yield* Clock.currentTimeMillis
      yield* PubSub.publish(changes, undefined)
    }
    if (unannounced) yield* PubSub.publish(changes, undefined)
    if (indexDirty) yield* persist()
  })
  const tick = (nowMs?: number) =>
    pass(nowMs).pipe(
      ticking.withPermitsIfAvailable(1),
      Effect.asVoid,
      Effect.catchTag(FILE_ERROR, (error) => Effect.logWarning("Project icon pass failed:", error.cause)),
      // The finder's functions take the platform from context; the layer
      // already resolved it.
      Effect.provide(platform),
    )

  // `start` is called from outside the layer; the passes belong to the layer,
  // so they stop when it closes, not when the caller's scope does.
  const layerScope = yield* Effect.scope
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return
    yield* tick().pipe(Effect.repeat(Schedule.fixed(TICK_INTERVAL_MS)), Effect.forkIn(layerScope))
  })

  return {
    urls: Ref.get(urls),
    changes: Stream.fromPubSub(changes),
    start,
    tick,
  }
})
