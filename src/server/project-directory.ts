import { mkdir, stat } from "node:fs/promises"
import { resolveLocalPath } from "./paths"

export async function ensureProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)
  await mkdir(resolvedPath, { recursive: true })
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}
