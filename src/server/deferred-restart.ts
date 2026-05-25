import { LOG_PREFIX } from "../shared/branding"

interface DeferredRestartControllerOptions {
  isIdle: () => boolean
  restart: () => void
  log?: (message: string) => void
  intervalMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

export function createDeferredRestartController(options: DeferredRestartControllerOptions) {
  const log = options.log ?? console.log
  const intervalMs = options.intervalMs ?? 1000
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval
  let restartRequested = false
  let checkInterval: ReturnType<typeof setInterval> | null = null

  function clear() {
    if (!checkInterval) return
    clearIntervalFn(checkInterval)
    checkInterval = null
  }

  function restartNow(reason: string) {
    log(`${LOG_PREFIX} ${reason}, restarting now`)
    clear()
    options.restart()
  }

  function request(reason: string) {
    if (options.isIdle()) {
      restartNow(reason)
      return
    }

    if (!restartRequested) {
      log(`${LOG_PREFIX} ${reason}, deferring restart until active sessions are idle`)
    }
    restartRequested = true

    if (checkInterval) return
    checkInterval = setIntervalFn(() => {
      if (!restartRequested || !options.isIdle()) return
      restartRequested = false
      restartNow("deferred restart conditions satisfied")
    }, intervalMs)
  }

  return {
    request,
    clear,
    get pending() {
      return restartRequested
    },
  }
}
