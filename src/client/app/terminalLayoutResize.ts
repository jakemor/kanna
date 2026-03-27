import { DEFAULT_TERMINAL_MAIN_SIZES } from "../stores/terminalLayoutStore"

export const TERMINAL_CLOSE_HEIGHT_THRESHOLD_PX = 35

export function getTerminalHeightFromContainer(containerHeight: number, terminalSizePercent: number) {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) return 0
  if (!Number.isFinite(terminalSizePercent) || terminalSizePercent <= 0) return 0
  return containerHeight * (terminalSizePercent / 100)
}

export function shouldCloseTerminalPane(containerHeight: number, terminalSizePercent: number) {
  const terminalHeight = getTerminalHeightFromContainer(containerHeight, terminalSizePercent)
  return terminalHeight >= 0 && terminalHeight < TERMINAL_CLOSE_HEIGHT_THRESHOLD_PX
}

export function getDefaultTerminalMainSizes(): [number, number] {
  return [...DEFAULT_TERMINAL_MAIN_SIZES]
}
