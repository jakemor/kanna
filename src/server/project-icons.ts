import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { copyFile, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { readPngHeader, writePngThumbnail, type Background } from "./png-thumbnail"

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

/** Candidate paths git tracks under `root`, or null when `root` is not in a repo. */
async function listTrackedPaths(root: string): Promise<string[] | null> {
  try {
    // This runs for every saved project, with nobody having asked for it,
    // and `core.fsmonitor` in a repository's config names a program for git
    // to run. Listing the index needs no file monitor.
    const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "ls-files", "-z", "--", ...GIT_PATHSPECS], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exitCode !== 0) return null
    return output.split("\0").filter(Boolean)
  } catch {
    return null
  }
}

/**
 * Candidate paths by reading folders, breadth first and bounded. For a
 * project outside git, and for one whose icon git doesn't track yet.
 */
async function walkForPaths(root: string): Promise<string[]> {
  const found: string[] = []
  let queue: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < WALK_MAX_DIRS) {
    const next: typeof queue = []
    for (const { dir, depth } of queue) {
      if (visited >= WALK_MAX_DIRS) break
      visited += 1
      let entries
      try {
        entries = await readdir(path.join(root, dir), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const relativePath = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isFile()) {
          if (classifyIconPath(relativePath)) found.push(relativePath)
          continue
        }
        if (!entry.isDirectory() || depth >= WALK_MAX_DEPTH || WALK_SKIP_DIRS.has(entry.name)) continue
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
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|svg|gif|icns|ico)$/i

function resolveInside(root: string, baseDir: string, target: string) {
  const resolved = path.resolve(root, baseDir, target)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null
}

/**
 * The image an asset catalog's icon set draws from: its largest, which is the
 * 1024px source. Since Xcode 14 that is the only one a set has to hold, and
 * in older sets it is the one the rest were cut from.
 */
/**
 * A manifest from the project, read whole. These are a few kilobytes when
 * honest, and the scan that reads them runs on its own for every saved
 * project: a clone can make one a link to a device that never ends, or a
 * gigabyte of JSON.
 */
const MAX_MANIFEST_BYTES = 1024 * 1024

async function readManifest(file: string) {
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error("not a manifest")
  return await readFile(file, "utf8")
}

async function resolveAppIconSet(setDir: string): Promise<string | null> {
  let best: { filename: string; pixels: number } | null = null
  try {
    const contents = JSON.parse(await readManifest(path.join(setDir, "Contents.json"))) as {
      images?: Array<{ filename?: unknown; size?: unknown; scale?: unknown; appearances?: unknown }>
    }
    for (const image of contents.images ?? []) {
      if (typeof image.filename !== "string" || !/\.(png|jpe?g)$/i.test(image.filename)) continue
      if (image.filename.includes("/") || image.filename.includes("\\")) continue
      const points = typeof image.size === "string" ? Number.parseFloat(image.size) : Number.NaN
      const scale = typeof image.scale === "string" ? Number.parseFloat(image.scale) : 1
      let pixels = Number.isFinite(points) ? points * (Number.isFinite(scale) ? scale : 1) : 1
      // Dark and tinted variants are the same size; the plain one is the icon.
      if (image.appearances) pixels -= 0.5
      if (!best || pixels > best.pixels) best = { filename: image.filename, pixels }
    }
  } catch {
    return null
  }
  return best ? path.join(setDir, best.filename) : null
}

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

/**
 * An Icon Composer icon is layers over a fill, composed by the system at
 * build time, so there is no finished image to read. This takes the layer
 * image with the most to it (the largest file: the artwork, not a sparkle on
 * top) and the fill as the colour to draw it over. A single-layer icon, the
 * common case, comes out as it looks.
 */
async function resolveIconComposer(bundleDir: string): Promise<{ path: string; background: Background | null } | null> {
  let icon: { fill?: unknown; groups?: Array<{ layers?: Array<{ "image-name"?: unknown }> }> }
  try {
    icon = JSON.parse(await readManifest(path.join(bundleDir, "icon.json")))
  } catch {
    return null
  }
  let best: { path: string; size: number } | null = null
  for (const group of icon.groups ?? []) {
    for (const layer of group.layers ?? []) {
      const imageName = layer["image-name"]
      if (typeof imageName !== "string" || !IMAGE_EXTENSIONS.test(imageName)) continue
      if (imageName.includes("/") || imageName.includes("\\")) continue
      const layerPath = path.join(bundleDir, "Assets", imageName)
      const info = await stat(layerPath).catch(() => null)
      if (info?.isFile() && (!best || info.size > best.size)) best = { path: layerPath, size: info.size }
    }
  }
  if (!best) return null
  // `{ "solid": colour }`, `{ "automatic-gradient": colour }`, or a gradient's
  // list of colours, of which the first will do at this size.
  const fill = icon.fill && typeof icon.fill === "object" ? Object.values(icon.fill as Record<string, unknown>)[0] : null
  return { path: best.path, background: parseIconComposerColor(Array.isArray(fill) ? fill[0] : fill) }
}

/** The icon an Expo config names, relative to the config. */
async function resolveExpoIcon(configPath: string): Promise<string | null> {
  let text: string
  try {
    const handle = await open(configPath, "r")
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      text = buffer.toString("utf8", 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  if (configPath.endsWith(".json")) {
    try {
      const json = JSON.parse(text) as Record<string, any>
      const expo = (json.expo ?? json) as Record<string, any>
      const named = [expo.icon, expo.ios?.icon, expo.android?.icon, expo.android?.adaptiveIcon?.foregroundImage]
        .find((value) => typeof value === "string" && IMAGE_EXTENSIONS.test(value))
      return typeof named === "string" ? named : null
    } catch {
      return null
    }
  }
  return /\bicon\s*:\s*["'`]([^"'`\n]+\.(?:png|jpe?g|webp|svg))["'`]/i.exec(text)?.[1] ?? null
}

interface IconSource {
  path: string
  /** A colour to draw the image over; for Icon Composer, whose fill is not in the image. */
  background: Background | null
}

async function resolveCandidateSource(root: string, candidate: IconCandidate): Promise<IconSource | null> {
  const bare = (sourcePath: string | null) => sourcePath ? { path: sourcePath, background: null } : null
  if (candidate.kind === "appiconset") {
    return bare(await resolveAppIconSet(path.join(root, path.dirname(candidate.path))))
  }
  if (candidate.kind === "icon-composer") {
    return resolveIconComposer(path.join(root, path.dirname(candidate.path)))
  }
  if (candidate.kind === "expo-config") {
    const named = await resolveExpoIcon(path.join(root, candidate.path))
    return bare(named ? resolveInside(root, path.dirname(candidate.path), named) : null)
  }
  return bare(path.join(root, candidate.path))
}

/**
 * `.icns` is a list of the icon at each size, most of them whole PNG files.
 * Reads the list's 8-byte headers and copies out the smallest PNG that covers
 * the thumbnail, so a 1 MB file costs a few seeks and one small read.
 */
async function extractIcnsPng(sourcePath: string, targetPath: string): Promise<boolean> {
  // Smallest first that is big enough, then the one below as a last resort.
  const preferred = ["ic07", "ic13", "ic08", "ic14", "ic09", "ic10", "ic12"]
  const handle = await open(sourcePath, "r")
  let chosen: { start: number; length: number; order: number } | null = null
  try {
    const header = Buffer.alloc(16)
    const { size } = await handle.stat()
    if ((await handle.read(header, 0, 8, 0)).bytesRead < 8 || header.toString("latin1", 0, 4) !== "icns") return false
    let offset = 8
    while (offset + 8 <= size) {
      if ((await handle.read(header, 0, 16, offset)).bytesRead < 8) break
      const length = header.readUInt32BE(4)
      if (length < 8) break
      const order = preferred.indexOf(header.toString("latin1", 0, 4))
      // Some writers store JPEG 2000 under the same names; only PNG is any use here.
      const isPng = header.readUInt32BE(8) === 0x89504e47
      if (order >= 0 && isPng && (!chosen || order < chosen.order)) {
        chosen = { start: offset + 8, length: length - 8, order }
      }
      offset += length
    }
  } finally {
    await handle.close()
  }
  if (!chosen) return false
  await pipeline(
    createReadStream(sourcePath, { start: chosen.start, end: chosen.start + chosen.length - 1 }),
    createWriteStream(targetPath)
  )
  return true
}

/** macOS's own image tool, for what the PNG reader can't take. Decodes in its process, not this one. */
async function resizeWithSips(sourcePath: string, targetPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false
  try {
    const child = Bun.spawn(
      ["/usr/bin/sips", "-s", "format", "png", "-Z", String(THUMBNAIL_SIZE), sourcePath, "--out", targetPath],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: GIT_TIMEOUT_MS }
    )
    return (await child.exited) === 0
  } catch {
    return false
  }
}

/**
 * Writes the stored form of `sourcePath` to `<targetBase>.<ext>` and returns
 * the extension, or null when the source can't be made small.
 */
async function writeIconFile(
  sourcePath: string,
  sourceSize: number,
  targetBase: string,
  background: Background | null
): Promise<string | null> {
  const extension = path.extname(sourcePath).slice(1).toLowerCase()
  const copyAs = async (as: string) => {
    await copyFile(sourcePath, `${targetBase}.${as}`)
    return as
  }

  if (extension === "svg" || extension === "ico") {
    return sourceSize <= COPY_MAX_BYTES ? copyAs(extension) : null
  }

  if (extension === "icns") {
    const extracted = `${targetBase}.icns.tmp`
    try {
      if (!(await extractIcnsPng(sourcePath, extracted))) return null
      const header = await readPngHeader(extracted)
      if (header && Math.max(header.width, header.height) <= THUMBNAIL_SIZE * 2) {
        await rename(extracted, `${targetBase}.png`)
      } else {
        await writePngThumbnail(extracted, `${targetBase}.png`, THUMBNAIL_SIZE)
      }
      return "png"
    } catch {
      return null
    } finally {
      await rm(extracted, { force: true })
    }
  }

  if (extension === "png") {
    const header = await readPngHeader(sourcePath)
    if (!header) return null
    // A background has to be drawn in, so the image goes through even when small.
    if (!background && Math.max(header.width, header.height) <= THUMBNAIL_SIZE * 2 && sourceSize <= PASS_THROUGH_MAX_BYTES) {
      return copyAs("png")
    }
    try {
      await writePngThumbnail(sourcePath, `${targetBase}.png`, THUMBNAIL_SIZE, background ?? undefined)
      return "png"
    } catch {
      // Interlaced, or not what its header says. Falls through to sips.
    }
  } else if (!/^(webp|jpe?g|gif)$/.test(extension)) {
    return null
  } else if (sourceSize <= PASS_THROUGH_MAX_BYTES) {
    return copyAs(extension === "jpeg" ? "jpg" : extension)
  }

  if (await resizeWithSips(sourcePath, `${targetBase}.png`)) return "png"
  return sourceSize <= COPY_MAX_BYTES ? copyAs(extension === "jpeg" ? "jpg" : extension) : null
}

function shortHash(value: string, length: number) {
  return createHash("sha1").update(value).digest("hex").slice(0, length)
}

interface IconRecord {
  /** Name under the icons dir, or null when the project has no icon. */
  file: string | null
  /** The image `file` was made from, with what it looked like then. */
  source?: string
  mtimeMs?: number
  size?: number
  /** The colour it was drawn over, `r,g,b`, when there was one. */
  background?: string
  scannedAt: number
}

interface IconIndex {
  version: number
  finder?: number
  projects: Record<string, IconRecord>
}

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
export async function findProjectIcon(root: string, iconsDir: string, previous?: IconRecord): Promise<FoundProjectIcon | null> {
  const tracked = await listTrackedPaths(root)
  let candidates = tracked ? rankIconCandidates(tracked) : []
  if (candidates.length === 0) candidates = rankIconCandidates(await walkForPaths(root))
  // A dozen is every plausible icon; past that they are logos in odd corners.
  for (const candidate of candidates.slice(0, 12)) {
    const resolved = await resolveCandidateSource(root, candidate)
    if (!resolved) continue
    const source = resolved.path
    let info
    try {
      info = await stat(source)
    } catch {
      continue
    }
    if (!info.isFile() || info.size === 0) continue
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
      return { file: previous.file, ...found }
    }
    const base = `${shortHash(root, 16)}-${shortHash(`${THUMBNAIL_VERSION}\0${source}\0${info.mtimeMs}\0${info.size}\0${found.background ?? ""}`, 12)}`
    const extension = await writeIconFile(source, info.size, path.join(iconsDir, base), resolved.background).catch(() => null)
    if (extension) return { file: `${base}.${extension}`, ...found }
  }
  return null
}

/** The stored file a project icon URL names, or null for anything else. */
export function resolveProjectIconPath(dataDir: string, pathname: string): string | null {
  if (!pathname.startsWith(PROJECT_ICON_URL_PREFIX)) return null
  const name = pathname.slice(PROJECT_ICON_URL_PREFIX.length)
  return ICON_FILE_PATTERN.test(name) ? path.join(dataDir, "project-icons", name) : null
}

export class ProjectIcons {
  private readonly iconsDir: string
  private readonly indexPath: string
  /** By project path. */
  private readonly records = new Map<string, IconRecord>()
  /** When each found icon's source was last stat'ed. Not kept across restarts. */
  private readonly sourceCheckedAt = new Map<string, number>()
  private urls = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private indexDirty = false

  constructor(
    dataDir: string,
    private readonly getProjectPaths: () => string[],
    private readonly onChange: () => void
  ) {
    this.iconsDir = path.join(dataDir, "project-icons")
    this.indexPath = path.join(this.iconsDir, "index.json")
    this.load()
  }

  /**
   * Synchronous, and before the first sidebar is built: a few kilobytes read
   * once so the first paint after a restart already has its icons.
   */
  private load() {
    try {
      mkdirSync(this.iconsDir, { recursive: true })
      const index = JSON.parse(readFileSync(this.indexPath, "utf8")) as IconIndex
      const present = new Set(readdirSync(this.iconsDir))
      // Icons drawn some other way are all redone; the files go below.
      const projects = index.version === THUMBNAIL_VERSION ? index.projects : {}
      // Kept, so their icons show meanwhile, and due at once.
      const stale = index.finder !== FINDER_VERSION
      for (const [projectPath, record] of Object.entries(projects)) {
        // A stored file that has gone missing is a project to search again.
        if (record.file && !present.has(record.file)) continue
        this.records.set(projectPath, stale ? { ...record, scannedAt: 0 } : record)
        if (record.file) present.delete(record.file)
      }
      // What is left belongs to no project: a crash between writing an icon
      // and writing the index, or an index from another thumbnail version.
      for (const name of present) {
        if (ICON_FILE_PATTERN.test(name)) void rm(path.join(this.iconsDir, name), { force: true })
      }
      this.rebuildUrls()
    } catch {
      // No index yet, or an unreadable one: everything is searched afresh.
    }
  }

  /** Project path to icon URL, for the sidebar builder. Projects without an icon are absent. */
  getUrls(): ReadonlyMap<string, string> {
    return this.urls
  }

  start() {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One pass over the projects, one at a time. With nothing due it is a map
   * lookup and two comparisons per project.
   */
  async tick(nowMs = Date.now()) {
    if (this.ticking) return
    this.ticking = true
    // The first pass after an install finds an icon for every project in
    // turn. Each push re-derives the whole sidebar, so they go out in batches.
    let unannounced = false
    let announcedAt = Date.now()
    try {
      for (const projectPath of this.getProjectPaths()) {
        if (!(await this.refresh(projectPath, nowMs))) continue
        this.rebuildUrls()
        unannounced = true
        if (Date.now() - announcedAt < CHANGE_NOTIFY_INTERVAL_MS) continue
        unannounced = false
        announcedAt = Date.now()
        this.onChange()
      }
      if (unannounced) this.onChange()
      if (this.indexDirty) await this.persist()
    } finally {
      this.ticking = false
    }
  }

  /** Returns whether the project's icon changed. */
  private async refresh(projectPath: string, nowMs: number): Promise<boolean> {
    const record = this.records.get(projectPath)
    if (record) {
      const scanAge = nowMs - record.scannedAt
      if (!record.file) {
        if (scanAge < MISS_RESCAN_INTERVAL_MS) return false
      } else if (scanAge < HIT_RESCAN_INTERVAL_MS) {
        if (nowMs - (this.sourceCheckedAt.get(projectPath) ?? 0) < SOURCE_CHECK_INTERVAL_MS) return false
        this.sourceCheckedAt.set(projectPath, nowMs)
        const info = await stat(record.source!).catch(() => null)
        if (info && info.mtimeMs === record.mtimeMs && info.size === record.size) return false
      }
    }

    const found = await findProjectIcon(projectPath, this.iconsDir, record).catch(() => null)
    this.sourceCheckedAt.set(projectPath, nowMs)
    this.records.set(projectPath, found ? { ...found, scannedAt: nowMs } : { file: null, scannedAt: nowMs })
    this.indexDirty = true
    const previousFile = record?.file ?? null
    const file = found?.file ?? null
    if (previousFile === file) return false
    if (previousFile) await rm(path.join(this.iconsDir, previousFile), { force: true })
    return true
  }

  private rebuildUrls() {
    const urls = new Map<string, string>()
    for (const [projectPath, record] of this.records) {
      if (record.file) urls.set(projectPath, `${PROJECT_ICON_URL_PREFIX}${record.file}`)
    }
    this.urls = urls
  }

  /** Writes the index, and drops projects that are gone along with their files. */
  private async persist() {
    this.indexDirty = false
    const live = new Set(this.getProjectPaths())
    for (const [projectPath, record] of this.records) {
      if (live.has(projectPath)) continue
      this.records.delete(projectPath)
      this.sourceCheckedAt.delete(projectPath)
      if (record.file) await rm(path.join(this.iconsDir, record.file), { force: true })
    }
    const index: IconIndex = { version: THUMBNAIL_VERSION, finder: FINDER_VERSION, projects: Object.fromEntries(this.records) }
    const temporaryPath = `${this.indexPath}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(index))
      await rename(temporaryPath, this.indexPath)
    } catch {
      // The index is a cache: without it the next boot searches again.
    }
  }
}
