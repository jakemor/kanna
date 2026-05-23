import { existsSync } from "node:fs"
import { bin as cloudflaredBin, install as installCloudflared } from "cloudflared"

export const defaultCloudflaredBin = cloudflaredBin
export const defaultExistsSync: (path: string) => boolean = existsSync
export const defaultInstallCloudflared = installCloudflared
