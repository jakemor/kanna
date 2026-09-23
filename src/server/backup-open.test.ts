import { expect, test } from "bun:test"
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { listBackupChildren, openBackupChild } from "./backup-open"

test("ancestor replacement cannot redirect a child open through a pinned directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-backup-open-"))
  try {
    await mkdir(path.join(root, "uploads"))
    await mkdir(path.join(root, "private"))
    await writeFile(path.join(root, "uploads/file"), "allowed")
    await writeFile(path.join(root, "private/other"), "secret")
    const parent = await open(path.join(root, "uploads"), "r")
    try {
      await rename(path.join(root, "uploads"), path.join(root, "moved"))
      await symlink(path.join(root, "private"), path.join(root, "uploads"))
      expect(await listBackupChildren(parent.fd)).toEqual(["file"])
      const child = (await openBackupChild(parent.fd, "file"))!
      try {
        const buffer = Buffer.alloc(32)
        const { bytesRead } = await child.read(buffer, 0, buffer.length, 0)
        expect(buffer.subarray(0, bytesRead).toString()).toBe("allowed")
      } finally { await child.close() }
      await symlink(path.join(root, "private/file"), path.join(root, "moved/link"))
      await expect(openBackupChild(parent.fd, "link")).rejects.toThrow("symbolic links")
      await expect(openBackupChild(parent.fd, "../private/file")).rejects.toThrow("invalid name")
    } finally { await parent.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test.skipIf(process.platform !== "linux")("missing procfs descriptor access fails instead of omitting data", async () => {
  await expect(openBackupChild(-1, "transcripts")).rejects.toThrow("mounted procfs")
  const root = await open(tmpdir(), "r")
  try { expect(await openBackupChild(root.fd, `kanna-missing-${crypto.randomUUID()}`)).toBeNull() }
  finally { await root.close() }
})
