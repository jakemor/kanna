import { Layer } from "effect"
import { BunPlatform } from "../platform/bun"
import { KannaLoggerLayer } from "./logger"

/**
 * What every server-side layer runs on: the Bun platform bindings (file
 * system, path, processes, PTYs, the machine's facts, HTTP) and Kanna's
 * console logger.
 */
export const ServerPlatform = Layer.merge(BunPlatform, KannaLoggerLayer)
