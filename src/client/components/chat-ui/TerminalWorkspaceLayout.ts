export const TERMINAL_HORIZONTAL_PADDING = 24

export function getMinimumTerminalWidth(minColumnWidth: number) {
  return minColumnWidth + TERMINAL_HORIZONTAL_PADDING
}
