import type { Subprocess } from "bun"

 
type BunTerminalCtor = any

export function hasBunTerminal(): boolean {
  return typeof Bun.Terminal === "function"
}

 
export function createBunTerminal(opts: any): any {
  return new (Bun.Terminal as BunTerminalCtor)(opts)
}

 
export function spawnTerminalProcess(cmd: string[], opts: any): Subprocess {
  return Bun.spawn(cmd, opts)
}
