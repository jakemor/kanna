import { close, constants, fstat, read } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { promisify } from "node:util"
import { CString, dlopen, ptr, read as memory, toArrayBuffer, type Pointer } from "bun:ffi"

const closeFd = promisify(close)
const statFd = promisify(fstat)
const readFd = promisify(read)
const readDirSymbol = process.arch === "arm64" ? "readdir" : "readdir$INODE64"
let native: ReturnType<typeof load> | undefined
function load() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    [readDirSymbol]: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
  })
}

// Linux uses procfs's descriptor references, which pin the directory regardless
// of rename. No libc loading or glibc dependency (also works on musl/Alpine).
// Darwin lacks directory traversal through /dev/fd, so use openat/fdopendir.
export async function openBackupChild(parent: number, name: string) {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error("Backup source has an invalid name")
  if (process.platform === "linux") {
    try { return await open(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // ENOENT may describe missing procfs, not a missing optional source.
        // Validate the descriptor reference before allowing an omission.
        try { await stat(`/proc/self/fd/${parent}`) } catch {
          throw new Error("Backup capture on Linux requires accessible /proc/self/fd (mounted procfs)")
        }
        return null
      }
      throw new Error("Backup source could not be opened without following symbolic links")
    }
  }
  if (process.platform !== "darwin") throw new Error("Backup capture requires macOS or Linux")
  const lib = native ??= load()
  const fd = lib.symbols.openat(parent, ptr(Buffer.from(`${name}\0`)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x1000000) // O_CLOEXEC
  if (fd < 0) {
    if (memory.i32(lib.symbols.__error()!) === 2) return null
    throw new Error("Backup source could not be opened without following symbolic links")
  }
  return {
    fd,
    stat: () => statFd(fd),
    close: () => closeFd(fd),
    read: (buffer: Buffer, offset: number, length: number, position: number) => readFd(fd, buffer, offset, length, position),
  }
}

export async function listBackupChildren(parent: number): Promise<string[]> {
  if (process.platform === "linux") return readdir(`/proc/self/fd/${parent}`)
  if (process.platform !== "darwin") throw new Error("Backup capture requires macOS or Linux")
  const lib = native ??= load()
  // Give fdopendir its own close-on-exec descriptor; closedir owns this one.
  const fd = lib.symbols.openat(parent, ptr(Buffer.from(".\0")), constants.O_RDONLY | constants.O_DIRECTORY | 0x1000000)
  if (fd < 0) throw new Error("Backup directory could not be opened")
  const directory = lib.symbols.fdopendir(fd)
  if (!directory) { await closeFd(fd); throw new Error("Backup directory could not be listed") }
  try {
    const names: string[] = []
    let visited = 0
    while (true) {
      new Int32Array(toArrayBuffer(lib.symbols.__error()!, 0, 4))[0] = 0
      const entry = lib.symbols[readDirSymbol]!(directory) as Pointer | null
      if (!entry) {
        if (memory.i32(lib.symbols.__error()!) !== 0) throw new Error("Backup directory listing failed")
        return names
      }
      // Darwin's explicit INODE64 dirent ABI: d_name follows ino(8), seekoff(8),
      // reclen(2), namlen(2), type(1). Copy before the next readdir reuses memory.
      const name = new CString(entry, 21).toString()
      if (name !== "." && name !== "..") names.push(name)
      if (++visited % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
  } finally { lib.symbols.closedir(directory) }
}
