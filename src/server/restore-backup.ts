import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { z } from "zod"

const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.number(),
  files: z.record(z.string(), z.object({ size: z.number().int().nonnegative(), chunks: z.array(z.string().regex(/^[a-f0-9]{64}$/)) })),
})

/** Reconstruct downloaded R2 objects into a NEW directory; never overwrite live history. */
export async function restoreBackup(source: string, destination: string, manifestPath = path.join(source, "latest.json")) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
  for (const name of Object.keys(manifest.files)) {
    if (path.isAbsolute(name) || name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid backup file path")
    }
    if (!/^(snapshot\.json|sidebar-order\.json|transcripts\/.+|media\/.+|project-uploads\/.+)$/.test(name)) throw new Error("Unexpected backup file")
  }
  if (!manifest.files["snapshot.json"]) throw new Error("Backup is missing its history snapshot")
  await mkdir(destination, { mode: 0o700 }) // EEXIST intentionally prevents overwrites.
  try {
    for (const [name, entry] of Object.entries(manifest.files)) {
      const target = path.join(destination, name)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      const handle = await open(`${target}.partial`, "wx", 0o600)
      let size = 0
      try {
        for (const hash of entry.chunks) {
          const bytes = gunzipSync(await readFile(path.join(source, "chunks", `${hash}.gz`)), { maxOutputLength: 4 * 1024 * 1024 })
          if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Backup chunk checksum mismatch")
          size += bytes.length
          if (size > entry.size) throw new Error("Backup file size mismatch")
          await handle.writeFile(bytes)
        }
        if (size !== entry.size) throw new Error("Backup file size mismatch")
      } finally { await handle.close() }
      await rename(`${target}.partial`, target)
    }
    return { files: Object.keys(manifest.files).length, createdAt: manifest.createdAt }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

if (import.meta.main) {
  const [, , source, destination, manifest] = process.argv
  if (!source || !destination) {
    console.error("Usage: bun src/server/restore-backup.ts <downloaded-backup-prefix> <new-output-directory> [manifest-path]")
    process.exitCode = 1
  } else {
    try {
      const result = await restoreBackup(path.resolve(source), path.resolve(destination), manifest ? path.resolve(manifest) : undefined)
      console.log(`Restored ${result.files} files from ${new Date(result.createdAt).toISOString()} to ${path.resolve(destination)}`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Restore failed")
      process.exitCode = 1
    }
  }
}
