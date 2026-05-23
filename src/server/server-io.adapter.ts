import { stat } from "node:fs/promises"
import type { Stats } from "node:fs"
import type { BunFile, Server } from "bun"

export type ServerFile = BunFile
export type ServerStats = Stats

export function getServerFile(p: string): ServerFile {
  return Bun.file(p)
}

export function statFile(p: string): Promise<Stats> {
  return stat(p)
}

 
export function serveHttp<T = unknown>(opts: any): Server<T> {
  return Bun.serve(opts) as unknown as Server<T>
}
