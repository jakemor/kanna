import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schedule, Stream } from "effect"
import { runTest } from "./effect/testing"
import { encodePng, readPngHeader } from "./png-thumbnail"
import {
  classifyIconPath,
  findProjectIcon,
  ProjectIcons,
  rankIconCandidates,
  resolveProjectIconPath,
} from "./project-icons"

const tmp = await mkdtemp(path.join(tmpdir(), "kanna-icons-"))
afterAll(() => rm(tmp, { recursive: true, force: true }))

let counter = 0
async function makeProject(files: Record<string, string | Buffer>) {
  counter += 1
  const root = path.join(tmp, `project-${counter}`)
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }
  await mkdir(root, { recursive: true })
  return root
}

async function makeIconsDir() {
  counter += 1
  const dir = path.join(tmp, `icons-${counter}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function png(size: number, color: [number, number, number] = [200, 40, 40]) {
  const pixels = new Uint8Array(size * size * 4)
  for (let index = 0; index < size * size; index += 1) pixels.set([...color, 255], index * 4)
  return encodePng(size, size, pixels)
}

const best = (paths: string[]) => rankIconCandidates(paths)[0]?.path
const find = (...args: Parameters<typeof findProjectIcon>) => runTest(findProjectIcon(...args))
const pngHeader = (filePath: string) => runTest(readPngHeader(filePath))

describe("rankIconCandidates", () => {
  test("ignores files that only look like icons", () => {
    expect(classifyIconPath("src/components/icon.svg")).toBeNull()
    expect(classifyIconPath("src/components/logo.png")).toBeNull()
    expect(classifyIconPath("android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png")).toBeNull()
    expect(classifyIconPath("android/app/src/main/res/drawable/ic_launcher.png")).toBeNull()
    expect(classifyIconPath("App/Assets.xcassets/Logo.imageset/Contents.json")).toBeNull()
    expect(classifyIconPath("build/icons/16x16.png")).toBeNull()
    expect(classifyIconPath("README.md")).toBeNull()
  })

  test("takes the icon nearest the root", () => {
    expect(best(["packages/site/public/favicon.svg", "public/favicon.ico"])).toBe("public/favicon.ico")
    expect(best(["apps/ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json", "favicon.png"])).toBe("favicon.png")
  })

  test("finds the app in a monorepo whose other packages have no icon", () => {
    expect(best([
      "apps/ios/Kanna/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "apps/ios/Widget/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "docs/public/favicon.ico",
      "examples/todo/public/favicon.svg",
    ])).toBe("apps/ios/Kanna/Assets.xcassets/AppIcon.appiconset/Contents.json")
  })

  test("prefers the main icon set and the main app target", () => {
    expect(best([
      "App/Assets.xcassets/AppIcon-Beta.appiconset/Contents.json",
      "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
    ])).toBe("App/Assets.xcassets/AppIcon.appiconset/Contents.json")
    expect(best([
      "AppWatch/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
    ])).toBe("ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json")
  })

  test("finds icon sets filed in a catalog's group folders", () => {
    expect(classifyIconPath("App/Assets.xcassets/Images/AppIcon.appiconset/Contents.json")).toMatchObject({ kind: "appiconset", score: 2.5 })
    expect(classifyIconPath("App/Assets.xcassets/Images/Logo.imageset/Contents.json")).toBeNull()
    expect(classifyIconPath("App/Images/AppIcon.appiconset/Contents.json")).toBeNull()
  })

  test("prefers an Icon Composer icon, and its main one over alternates", () => {
    expect(best([
      "App/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "App/IconGold.icon/icon.json",
      "App/Icon.icon/icon.json",
    ])).toBe("App/Icon.icon/icon.json")
    expect(classifyIconPath("App/Icon.icon/Assets/layer.png")).toBeNull()
  })

  test("picks the Android density nearest the stored size", () => {
    expect(best([
      "app/src/main/res/mipmap-mdpi/ic_launcher.png",
      "app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp",
      "app/src/main/res/mipmap-xhdpi/ic_launcher_round.png",
      "app/src/main/res/mipmap-xhdpi/ic_launcher.png",
      "app/src/debug/res/mipmap-xhdpi/ic_launcher.png",
      "app/src/main/ic_launcher-playstore.png",
    ])).toBe("app/src/main/res/mipmap-xhdpi/ic_launcher.png")
  })

  test("orders the conventions of one app", () => {
    // React Native: iOS before Android, both under the root.
    expect(best([
      "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
      "ios/Acme/Images.xcassets/AppIcon.appiconset/Contents.json",
    ])).toBe("ios/Acme/Images.xcassets/AppIcon.appiconset/Contents.json")
    // Electron and Tauri.
    expect(best(["build/icon.ico", "build/icon.icns", "build/icon.png"])).toBe("build/icon.png")
    expect(best(["src-tauri/icons/icon.icns", "src-tauri/icons/32x32.png", "src-tauri/icons/128x128.png", "src-tauri/icons/128x128@2x.png"]))
      .toBe("src-tauri/icons/128x128.png")
    // Web: vector first.
    expect(best(["public/favicon.ico", "public/apple-touch-icon.png", "public/favicon.svg"])).toBe("public/favicon.svg")
    expect(best(["src/app/icon.png", "assets/logo.svg"])).toBe("src/app/icon.png")
  })
})

describe("findProjectIcon", () => {
  test("shrinks the 1024px image of an iOS icon set", async () => {
    const root = await makeProject({
      "api/package.json": "{}",
      "ios/Demo/Assets.xcassets/AppIcon.appiconset/Contents.json": JSON.stringify({
        images: [
          { idiom: "universal", platform: "ios", size: "1024x1024", filename: "dark.png", appearances: [{ appearance: "luminosity", value: "dark" }] },
          { idiom: "universal", platform: "ios", size: "1024x1024", filename: "icon.png" },
          { idiom: "iphone", size: "60x60", scale: "3x", filename: "icon-180.png" },
          { idiom: "ipad", size: "20x20", scale: "1x" },
        ],
      }),
      "ios/Demo/Assets.xcassets/AppIcon.appiconset/icon.png": png(1024),
      "ios/Demo/Assets.xcassets/AppIcon.appiconset/dark.png": png(1024, [0, 0, 0]),
      "ios/Demo/Assets.xcassets/AppIcon.appiconset/icon-180.png": png(180),
    })
    const iconsDir = await makeIconsDir()
    const found = await find(root, iconsDir)
    expect(found?.source).toBe(path.join(root, "ios/Demo/Assets.xcassets/AppIcon.appiconset/icon.png"))
    expect(found?.file).toMatch(/^[a-f0-9]{16}-[a-f0-9]{12}\.png$/)
    expect(await pngHeader(path.join(iconsDir, found!.file))).toMatchObject({ width: 96, height: 96 })

    // Unchanged source: the stored file is reused, not rewritten.
    const again = await find(root, iconsDir, { ...found!, scannedAt: 0 })
    expect(again).toEqual(found)
    expect(await readdir(iconsDir)).toEqual([found!.file])
  })

  test("draws an Icon Composer icon's largest layer over its fill", async () => {
    const glyph = new Uint8Array(200 * 200 * 4)
    for (let index = 0; index < 200 * 200; index += 1) {
      // A white glyph on the left half, clear on the right.
      if (index % 200 < 100) glyph.set([255, 255, 255, 255], index * 4)
    }
    const root = await makeProject({
      "App/Icon.icon/icon.json": JSON.stringify({
        fill: { "automatic-gradient": "srgb:0.00000,0.50196,1.00000,1.00000" },
        groups: [{ layers: [{ "image-name": "sparkle.png" }] }, { layers: [{ "image-name": "glyph.png" }] }],
      }),
      "App/Icon.icon/Assets/sparkle.png": png(8),
      "App/Icon.icon/Assets/glyph.png": encodePng(200, 200, glyph),
    })
    const iconsDir = await makeIconsDir()
    const found = await find(root, iconsDir)
    expect(found?.source).toBe(path.join(root, "App/Icon.icon/Assets/glyph.png"))
    expect(found?.background).toBe("0,128,255")
    const stored = await readFile(path.join(iconsDir, found!.file))
    // Opaque throughout, the fill showing where the layer is clear.
    expect(await pngHeader(path.join(iconsDir, found!.file))).toMatchObject({ width: 96, height: 96 })
    const { inflateSync } = await import("node:zlib")
    const raw = inflateSync(stored.subarray(41, 41 + stored.readUInt32BE(33)))
    expect(raw.length).toBe(96 * (96 * 4 + 1))
  })

  test("reads the icon an Expo config names", async () => {
    const root = await makeProject({
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Demo", icon: "./art/app-icon.png" } }),
      "apps/mobile/art/app-icon.png": png(300),
      "apps/api/app.json": JSON.stringify({ name: "api" }),
    })
    const found = await find(root, await makeIconsDir())
    expect(found?.source).toBe(path.join(root, "apps/mobile/art/app-icon.png"))

    const scripted = await makeProject({
      "app.config.ts": "export default { name: 'Demo', icon: './icon-source.png', ios: {} }",
      "icon-source.png": png(64),
    })
    expect((await find(scripted, await makeIconsDir()))?.source).toBe(path.join(scripted, "icon-source.png"))

    const escaping = await makeProject({ "app.json": JSON.stringify({ expo: { icon: "../../outside.png" } }) })
    expect(await find(escaping, await makeIconsDir())).toBeNull()
  })

  test("copies small images and vectors as they are", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`
    const web = await makeProject({ "public/favicon.svg": svg, "public/favicon.ico": "ico" })
    const iconsDir = await makeIconsDir()
    const found = await find(web, iconsDir)
    expect(found?.file.endsWith(".svg")).toBe(true)
    expect(await readFile(path.join(iconsDir, found!.file), "utf8")).toBe(svg)

    const android = await makeProject({ "app/src/main/res/mipmap-xhdpi/ic_launcher.png": png(96) })
    const androidIcons = await makeIconsDir()
    const launcher = await find(android, androidIcons)
    expect(await readFile(path.join(androidIcons, launcher!.file))).toEqual(png(96))
  })

  test("pulls a PNG out of an .icns", async () => {
    const entry = (type: string, payload: Buffer) => {
      const header = Buffer.alloc(8)
      header.write(type, 0, "latin1")
      header.writeUInt32BE(payload.length + 8, 4)
      return Buffer.concat([header, payload])
    }
    const entries = Buffer.concat([
      entry("TOC ", Buffer.alloc(16)),
      entry("ic10", png(1024, [1, 2, 3])),
      entry("ic07", png(128, [9, 8, 7])),
      entry("ic08", Buffer.from("jpeg 2000, not png")),
    ])
    const header = Buffer.alloc(8)
    header.write("icns", 0, "latin1")
    header.writeUInt32BE(entries.length + 8, 4)
    const root = await makeProject({ "build/icon.icns": Buffer.concat([header, entries]) })
    const iconsDir = await makeIconsDir()
    const found = await find(root, iconsDir)
    expect(await readFile(path.join(iconsDir, found!.file))).toEqual(png(128, [9, 8, 7]))
    expect(await readdir(iconsDir)).toEqual([found!.file])
  })

  test("skips build output and dependencies when walking", async () => {
    const root = await makeProject({
      "node_modules/pkg/favicon.ico": "x",
      "app/build/intermediates/res/mipmap-xhdpi/ic_launcher.png": png(96),
      ".cache/favicon.png": png(16),
    })
    expect(await find(root, await makeIconsDir())).toBeNull()
  })

  test("lists through git when the project is a repo", async () => {
    const root = await makeProject({
      "services/api/main.go": "package main",
      "clients/ios/Acme/Assets.xcassets/AppIcon.appiconset/Contents.json": JSON.stringify({ images: [{ size: "1024x1024", filename: "a.png" }] }),
      "clients/ios/Acme/Assets.xcassets/AppIcon.appiconset/a.png": png(200),
      // Ignored, so git never offers it even though it sits at the root.
      "favicon.png": png(32),
      ".gitignore": "favicon.png\n",
    })
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
    for (const args of [["init", "-q"], ["add", "-A"]]) {
      expect(await Bun.spawn(["git", ...args], { cwd: root, env, stdout: "ignore", stderr: "ignore" }).exited).toBe(0)
    }
    const found = await find(root, await makeIconsDir())
    expect(found?.source).toBe(path.join(root, "clients/ios/Acme/Assets.xcassets/AppIcon.appiconset/a.png"))
  })
})

describe("ProjectIcons", () => {
  test("serves a URL, follows the source, and survives a restart", async () => {
    const root = await makeProject({ "public/favicon.png": png(32, [1, 1, 1]) })
    const bare = await makeProject({ "main.py": "" })
    const dataDir = await makeProject({})
    const layer = ProjectIcons.layer({ dataDir, projectPaths: Effect.succeed([root, bare]) })

    const nextUrl = await runTest(Effect.gen(function* () {
      const icons = yield* ProjectIcons
      let changes = 0
      yield* icons.changes.pipe(
        Stream.runForEach(() => Effect.sync(() => { changes += 1 })),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Lets the subscriber see what a pass published.
      const settle = Effect.sleep("20 millis")

      yield* icons.tick(1_000_000)
      yield* settle
      const url = (yield* icons.urls).get(root)!
      expect(url).toStartWith("/api/project-icons/")
      expect((yield* icons.urls).has(bare)).toBe(false)
      expect(changes).toBe(1)
      expect(yield* Effect.promise(() => readFile(resolveProjectIconPath(dataDir, url)!))).toEqual(png(32, [1, 1, 1]))

      // Nothing is due a few seconds later.
      yield* icons.tick(1_005_000)
      yield* settle
      expect(changes).toBe(1)

      // The source changes: picked up at the next source check, old file removed.
      yield* Effect.promise(async () => {
        await writeFile(path.join(root, "public/favicon.png"), png(48, [2, 2, 2]))
        await utimes(path.join(root, "public/favicon.png"), new Date(), new Date(Date.now() + 5_000))
      })
      yield* icons.tick(1_000_000 + 3 * 60_000)
      yield* settle
      const next = (yield* icons.urls).get(root)!
      expect(next).not.toBe(url)
      expect(changes).toBe(2)
      return next
    }).pipe(Effect.provide(layer)))
    expect((await readdir(path.join(dataDir, "project-icons"))).sort()).toEqual(["index.json", nextUrl.split("/").pop()!].sort())

    const restarted = await runTest(Effect.flatMap(Effect.service(ProjectIcons), (icons) => icons.urls).pipe(Effect.provide(layer)))
    expect(restarted.get(root)).toBe(nextUrl)
  })

  test("start runs a pass at once and stops when the layer closes", async () => {
    const root = await makeProject({ "public/favicon.png": png(32, [3, 3, 3]) })
    const dataDir = await makeProject({})
    const urls = await runTest(Effect.gen(function* () {
      const icons = yield* ProjectIcons
      yield* icons.start
      // A second start is a no-op, not a second loop.
      yield* icons.start
      return yield* Effect.gen(function* () {
        const current = yield* icons.urls
        if (!current.has(root)) return yield* Effect.fail("pending" as const)
        return current
      }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }))
    }).pipe(Effect.provide(ProjectIcons.layer({ dataDir, projectPaths: Effect.succeed([root]) }))))
    expect(urls.get(root)).toStartWith("/api/project-icons/")
  })

  test("drops a project that is gone, with its file", async () => {
    const root = await makeProject({ "public/favicon.png": png(32, [4, 4, 4]) })
    const added = await makeProject({ "main.py": "" })
    const dataDir = await makeProject({})
    let live = [root]
    await runTest(Effect.gen(function* () {
      const icons = yield* ProjectIcons
      yield* icons.tick(1_000_000)
      expect((yield* icons.urls).has(root)).toBe(true)
      // The index is rewritten, and the gone dropped, by a pass that found something.
      live = [added]
      yield* icons.tick(1_000_000 + 60 * 60_000)
    }).pipe(Effect.provide(ProjectIcons.layer({ dataDir, projectPaths: Effect.sync(() => live) }))))
    expect(await readdir(path.join(dataDir, "project-icons"))).toEqual(["index.json"])
  })

  test("resolves only its own file names", () => {
    expect(resolveProjectIconPath("/data", "/api/project-icons/0123456789abcdef-0123456789ab.png")).toBe("/data/project-icons/0123456789abcdef-0123456789ab.png")
    expect(resolveProjectIconPath("/data", "/api/project-icons/index.json")).toBeNull()
    expect(resolveProjectIconPath("/data", "/api/project-icons/..%2Fsettings.json")).toBeNull()
    expect(resolveProjectIconPath("/data", "/api/project-icons/../settings.json")).toBeNull()
  })
})
