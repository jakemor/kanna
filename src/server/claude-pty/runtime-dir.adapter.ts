import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

export async function createRuntimeDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix))
}

export async function writeRuntimeFile(
  filePath: string,
  contents: string,
  options?: { encoding?: BufferEncoding; mode?: number },
): Promise<void> {
  await writeFile(filePath, contents, options)
}

export async function removeRuntimeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
