import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getLlmProviderFilePath } from "../shared/branding"
import type { LlmProviderFile, LlmProviderSnapshot } from "../shared/types"
import { normalizeLlmProviderSnapshot, createDefaultSnapshot } from "./llm-provider"

export async function readLlmProviderSnapshotFromDisk(
  filePath = getLlmProviderFilePath(homedir())
): Promise<LlmProviderSnapshot> {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      return createDefaultSnapshot(filePath, "LLM provider file was empty. Using defaults.")
    }
    return normalizeLlmProviderSnapshot(JSON.parse(text), filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createDefaultSnapshot(filePath)
    }
    if (error instanceof SyntaxError) {
      return createDefaultSnapshot(filePath, "LLM provider file is invalid JSON. Using defaults.")
    }
    throw error
  }
}

export async function writeLlmProviderSnapshotToDisk(
  value: Pick<LlmProviderFile, "provider" | "apiKey" | "model"> & { baseUrl: string },
  filePath = getLlmProviderFilePath(homedir())
): Promise<LlmProviderSnapshot> {
  const snapshot = normalizeLlmProviderSnapshot(value, filePath)
  const payload: LlmProviderFile = {
    provider: snapshot.provider,
    apiKey: snapshot.apiKey,
    model: snapshot.model,
    baseUrl: snapshot.provider === "custom" ? snapshot.baseUrl : null,
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  return snapshot
}
