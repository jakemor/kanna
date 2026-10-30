/**
 * How the viewer's body moves when you step through a chat's attachments
 * (`attachmentNavigation`). Only the body: the header (name, count, actions)
 * changes at once, since it is what you read to know where you are.
 *
 * A step is made from the keyboard, often several in a row, so the motion is
 * small and quick: the item leaves 24px towards where you came from as the
 * next arrives 24px from where you're going, and that tells you the
 * direction. A held key steps with no motion at all, so holding → never
 * waits on an animation. At an end the item gives a few px the way it would
 * have left and comes back: there is nothing past it.
 *
 * WAAPI, not CSS: each card is mounted fresh for its attachment, and the one
 * leaving is a copy left over it for its exit (`leaveAsGhost`).
 */

export type StepDirection = "next" | "previous"

/** `--ease-snappy` in src/index.css. WAAPI can't read a CSS variable. */
const EASE_SNAPPY = "cubic-bezier(0.23, 1, 0.32, 1)"

export const SLIDE_DISTANCE_PX = 24
export const SLIDE_ENTER_MS = 180
export const SLIDE_EXIT_MS = 120
export const REDUCED_FADE_MS = 120
export const EDGE_NUDGE_PX = 10
export const EDGE_NUDGE_MS = 240
/** Where in the nudge it is furthest out: a quick give, then a slower return. */
const EDGE_NUDGE_PEAK = 0.3

/** What a press does to the body. */
export type AttachmentStepMotion =
  | { kind: "slide"; direction: StepDirection }
  | { kind: "fade" }
  | { kind: "instant" }
  | { kind: "nudge"; offsetPx: number }
  | { kind: "none" }

/**
 * The motion for one press: a step (`blocked` false) or a press past an end.
 * A key held down repeats with no motion; reduced motion fades in place of
 * the slide and has no nudge.
 */
export function attachmentStepMotion({ direction, blocked, repeat, reducedMotion }: {
  direction: StepDirection
  blocked: boolean
  repeat: boolean
  reducedMotion: boolean
}): AttachmentStepMotion {
  if (blocked) return repeat || reducedMotion ? { kind: "none" } : { kind: "nudge", offsetPx: slideSign(direction) * -EDGE_NUDGE_PX }
  if (repeat) return { kind: "instant" }
  return reducedMotion ? { kind: "fade" } : { kind: "slide", direction }
}

/**
 * Whether the press being handled is a key held down repeating. Read off the
 * event in flight, like `isKeyboardInitiated` in stores/viewerStore.ts: the
 * navigation's callbacks are not handed it.
 */
export function isHeldKeyRepeat() {
  const event = typeof window === "undefined" ? undefined : window.event
  return typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent && event.repeat
}

/** Next comes in from the right (+1) and leaves the last one to the left; previous mirrors it. */
function slideSign(direction: StepDirection) {
  return direction === "next" ? 1 : -1
}

/** The arriving body's keyframes: from the side it comes in from, or a fade where motion is reduced. */
export function enterKeyframes(motion: Extract<AttachmentStepMotion, { kind: "slide" | "fade" }>): Keyframe[] {
  if (motion.kind === "fade") return [{ opacity: 0 }, { opacity: 1 }]
  return [
    { transform: `translateX(${slideSign(motion.direction) * SLIDE_DISTANCE_PX}px)`, opacity: 0 },
    { transform: "translateX(0)", opacity: 1 },
  ]
}

export function playEnter(body: HTMLElement, motion: Extract<AttachmentStepMotion, { kind: "slide" | "fade" }>) {
  if (typeof body.animate !== "function") return
  body.animate(enterKeyframes(motion), {
    duration: motion.kind === "fade" ? REDUCED_FADE_MS : SLIDE_ENTER_MS,
    easing: EASE_SNAPPY,
  })
}

/** Ghosts and nudges are found again by these, to clear or retarget them. */
const GHOST_ATTRIBUTE = "data-viewer-ghost"
const NUDGE_ID = "viewer-edge-nudge"

/**
 * A copy of what is leaving, laid over where it was, sliding out the way the
 * press points. The card it belonged to is unmounted by the step, so the copy
 * is the only thing left to move. It starts from wherever the body was, mid
 * entrance included, so quick presses carry on from where things are rather
 * than snapping back to start.
 *
 * None for a body a copy can't stand in for: a PDF's frame or a video would
 * load again, blank, and a long table is too many cells to copy on a key.
 */
export function leaveAsGhost(body: HTMLElement, host: HTMLElement, direction: StepDirection) {
  if (typeof body.animate !== "function") return
  if (body.querySelector("iframe, video, canvas") || body.getElementsByTagName("*").length > 400) return
  const hostRect = host.getBoundingClientRect()
  const rect = body.getBoundingClientRect()
  const computed = getComputedStyle(body)
  const from = { transform: computed.transform === "none" ? "translateX(0)" : computed.transform, opacity: computed.opacity }

  // Clipped to the body's box, as the card clips the body.
  const clip = document.createElement("div")
  clip.setAttribute(GHOST_ATTRIBUTE, "")
  Object.assign(clip.style, {
    position: "absolute",
    left: `${rect.left - hostRect.left}px`,
    top: `${rect.top - hostRect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    overflow: "hidden",
  })
  const ghost = body.cloneNode(true) as HTMLElement
  ghost.removeAttribute("data-viewer-body")
  Object.assign(ghost.style, { width: "100%", height: "100%", overflow: "hidden" })
  clip.appendChild(ghost)
  host.appendChild(clip)
  ghost.scrollTop = body.scrollTop
  ghost.scrollLeft = body.scrollLeft

  const animation = ghost.animate([from, { transform: `translateX(${-slideSign(direction) * SLIDE_DISTANCE_PX}px)`, opacity: 0 }], {
    duration: SLIDE_EXIT_MS,
    easing: EASE_SNAPPY,
    fill: "forwards",
  })
  const remove = () => clip.remove()
  animation.finished.then(remove, remove)
}

/** Every ghost still leaving, gone at once: a held key's steps don't wait on them. */
export function clearGhosts(host: HTMLElement) {
  for (const ghost of host.querySelectorAll(`[${GHOST_ATTRIBUTE}]`)) ghost.remove()
}

/**
 * The give at an end: out with the strong ease-out, which slows into the
 * stretch like something held back, and back on the same curve, longer.
 * Added onto whatever the body is doing (an entrance still settling), so it
 * never cuts that short; a second press replaces the first.
 */
export function playNudge(body: HTMLElement, offsetPx: number) {
  if (typeof body.animate !== "function") return
  for (const animation of body.getAnimations()) {
    if (animation.id === NUDGE_ID) animation.cancel()
  }
  const animation = body.animate([
    { transform: "translateX(0)", easing: EASE_SNAPPY },
    { transform: `translateX(${offsetPx}px)`, offset: EDGE_NUDGE_PEAK, easing: EASE_SNAPPY },
    { transform: "translateX(0)" },
  ], { duration: EDGE_NUDGE_MS, composite: "add" })
  animation.id = NUDGE_ID
}
