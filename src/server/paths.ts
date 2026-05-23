import { homedir } from "node:os"
import path from "node:path"

export function resolveLocalPath(localPath: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homedir()
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export function getProjectUploadDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), ".kanna", "uploads")
}

export function getProjectExportDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), ".kanna", "exports")
}
