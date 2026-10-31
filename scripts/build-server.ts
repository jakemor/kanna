/**
 * Bundles the server into dist/server for the npm package.
 *
 * Published kanna-code runs this bundle, not src/server: a fresh install then
 * resolves a handful of packages instead of hundreds (the Mac app's
 * "Resolving dependencies" step). Everything the server imports is bundled
 * except EXTERNAL below, which stays a real dependency in package.json.
 * A checkout still runs the source (bin/kanna), so `bun run dev` and tests
 * don't see this.
 *
 * Output sits two levels under the package root, like src/server, so the
 * paths the server builds from import.meta (dist/client, dist/export-viewer,
 * package.json) resolve the same way from either.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { checkServerBundle } from "./server-bundle-check"

const ROOT = path.resolve(import.meta.dir, "..")
const OUT_DIR = path.join(ROOT, "dist", "server")

/**
 * Not bundled, each for a reason:
 * - cloudflared finds the binary it downloads relative to its own package.
 * - The Pi packages read their package.json, themes and templates from
 *   their own folder, which a bundle would point at Kanna's instead.
 * - koffi (Windows-only, in Pi's terminal UI, which Kanna never runs) and
 *   @opentelemetry/api (an optional, guarded import in Mistral's SDK) aren't
 *   installed at all, the same as before bundling.
 */
const EXTERNAL = ["cloudflared", "@mariozechner/*", "koffi", "@opentelemetry/api"]
/** Of EXTERNAL, the ones no one installs: their only callers guard the import. */
const OPTIONAL = ["koffi", "@opentelemetry/api"]

rmSync(OUT_DIR, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [path.join(ROOT, "src/server/entry.ts")],
  outdir: OUT_DIR,
  target: "bun",
  format: "esm",
  // One file, not chunks: Bun 1.3.5 (packageManager then, so CI's build)
  // wrote split chunks that export the same name twice, which fails to parse.
  splitting: false,
  // Stack traces in logs and bug reports keep pointing at src/server.
  sourcemap: "linked",
  external: EXTERNAL,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// The bundle that came out, not the config that went in: nothing external
// inlined, no build-machine path baked in, nothing loaded that won't be
// installed (server-bundle-check.ts).
const pkgJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
const check = checkServerBundle(
  result.outputs
    .filter((output) => output.path.endsWith(".js"))
    .map((output) => ({ path: path.relative(ROOT, output.path), text: readFileSync(output.path, "utf8") })),
  {
    external: EXTERNAL,
    dependencies: Object.keys(pkgJson.dependencies ?? {}),
    optional: OPTIONAL,
    forbiddenPaths: [ROOT],
  },
)
if (check.problems.length > 0) {
  console.error(`The server bundle would break at runtime:\n${check.problems.map((problem) => `  - ${problem}`).join("\n")}`)
  process.exit(1)
}

// Bundled code carries its authors' licenses: collect every package the
// sourcemaps name and write their notices next to the bundle.
const packages = new Map<string, string>()
for (const output of result.outputs) {
  if (!output.path.endsWith(".map")) continue
  // Only the file list: Bun writes `\x` escapes into the maps' embedded
  // source text, which JSON.parse rejects.
  const list = readFileSync(output.path, "utf8").match(/"sources"\s*:\s*(\[[^\]]*\])/)?.[1]
  for (const source of list ? JSON.parse(list) as string[] : []) {
    const match = source.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
    if (!match) continue
    const name = match[1]!
    if (packages.has(name)) continue
    const dir = path.join(ROOT, "node_modules", name)
    packages.set(name, dir)
  }
}

const notices: string[] = []
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const pkgPath = path.join(dir, "package.json")
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string; license?: string }
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE", "LICENSE-MIT"]
    .map((file) => path.join(dir, file))
    .find((file) => existsSync(file))
  notices.push([
    `${name}@${pkg.version ?? "?"} (${pkg.license ?? "see package"})`,
    licenseFile ? readFileSync(licenseFile, "utf8").trim() : "No license file shipped with the package.",
  ].join("\n\n"))
}
writeFileSync(
  path.join(OUT_DIR, "THIRD_PARTY_LICENSES.txt"),
  `Kanna's server bundle includes code from these packages.\n\n${notices.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
)

const jsBytes = result.outputs.filter((output) => output.path.endsWith(".js")).reduce((sum, output) => sum + output.size, 0)
console.log(`server bundle: ${(jsBytes / 1e6).toFixed(1)} MB of JS, ${packages.size} bundled packages, in ${path.relative(ROOT, OUT_DIR)}`)
