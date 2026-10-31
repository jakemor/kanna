import type { WindowShape } from "./native-window"

/** What the page preload puts on <html> for src/index.css's `mac-app:` variant. */
export interface PageChrome {
  fullScreen: boolean
  vars: Record<string, string>
}

/**
 * The window's shape in the page's CSS pixels. The shape is in points, where
 * the traffic lights live, and page zoom (⌘+ / ⌘−) scales every CSS pixel
 * but leaves the lights alone. Sent as points, a 90% page drew its title-bar
 * row 3pt above the lights and its sidebar toggle against the green one; so
 * each native measure is divided by the zoom.
 *
 * Full screen has no lights to clear and square corners; its values put the
 * sidebar back to its browser look (16px corners, 12px padding). They are the
 * page's own sizes, so they zoom with it.
 */
export function pageChrome(shape: WindowShape, { fullScreen, zoom }: { fullScreen: boolean; zoom: number }): PageChrome {
  const px = (points: number) => `${Math.round((points / zoom) * 100) / 100}px`
  return {
    fullScreen,
    vars: {
      "--mac-traffic-lights-inset": fullScreen ? "20px" : px(shape.trafficLightsInset),
      "--mac-traffic-lights-center": px(shape.trafficLightsCenter),
      "--mac-window-radius": fullScreen ? "24px" : px(shape.cornerRadius),
    },
  }
}
