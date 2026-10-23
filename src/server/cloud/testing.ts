/**
 * Test helpers for the cloud modules: a typed fake control-plane client,
 * a logger that records what the loops say, and a real-time wait for the
 * Promise fakes (fetch, connector) to settle between TestClock steps.
 */

import { Effect, Logger } from "effect"
import { DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import { CloudApiError, CloudNetworkError, type CloudApiClient } from "./api-client"

/** A `CloudApiClient` whose calls die unless the test supplies them. */
export function makeFakeCloudApiClient(overrides: Partial<CloudApiClient> = {}): CloudApiClient {
  const notUsed = (method: string) => () => Effect.die(new Error(`fake CloudApiClient.${method} not used`))
  return {
    controlUrl: DEFAULT_CLOUD_CONTROL_URL,
    pair: notUsed("pair"),
    requestDeviceCode: notUsed("requestDeviceCode"),
    pollDeviceCode: notUsed("pollDeviceCode"),
    heartbeat: notUsed("heartbeat"),
    markOffline: notUsed("markOffline"),
    removeMachine: notUsed("removeMachine"),
    ...overrides,
  }
}

export const apiError = (status: number, message = `control plane returned ${status}`, path = "/heartbeat") =>
  new CloudApiError({ message, status, path })

export const networkError = (message: string, path = "/heartbeat") =>
  new CloudNetworkError({ message, path, cause: new Error(message) })

/** Records every `Effect.log*` line, in place of the console logger. */
export function captureLogs() {
  const lines: Array<{ level: string; message: string }> = []
  const layer = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      const parts: unknown[] = Array.isArray(message) ? message : [message]
      lines.push({ level: logLevel, message: parts.map(String).join(" ") })
    }),
  ])
  return {
    layer,
    lines,
    infos: () => lines.filter((line) => line.level === "Info").map((line) => line.message),
    warnings: () => lines.filter((line) => line.level === "Warn").map((line) => line.message),
  }
}

/** Waits in real time (not the TestClock) until `condition` holds. */
export const waitFor = (condition: () => boolean, timeoutMs = 2_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out")
      await Bun.sleep(2)
    }
  })

/** Lets fibers woken by a TestClock step run to their next wait. */
export const settle = Effect.promise(() => Bun.sleep(10))
