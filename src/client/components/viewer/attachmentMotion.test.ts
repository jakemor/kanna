import { describe, expect, test } from "bun:test"
import { attachmentStepMotion, EDGE_NUDGE_PX, enterKeyframes, SLIDE_DISTANCE_PX } from "./attachmentMotion"

const press = (direction: "next" | "previous", extra: Partial<{ blocked: boolean; repeat: boolean; reducedMotion: boolean }> = {}) =>
  attachmentStepMotion({ direction, blocked: false, repeat: false, reducedMotion: false, ...extra })

describe("attachmentStepMotion", () => {
  test("a step slides the way it goes", () => {
    expect(press("next")).toEqual({ kind: "slide", direction: "next" })
    expect(press("previous")).toEqual({ kind: "slide", direction: "previous" })
  })

  test("next comes in from the right, previous from the left", () => {
    expect(enterKeyframes({ kind: "slide", direction: "next" })[0]).toEqual({ transform: `translateX(${SLIDE_DISTANCE_PX}px)`, opacity: 0 })
    expect(enterKeyframes({ kind: "slide", direction: "previous" })[0]).toEqual({ transform: `translateX(${-SLIDE_DISTANCE_PX}px)`, opacity: 0 })
    expect(enterKeyframes({ kind: "slide", direction: "next" }).at(-1)).toEqual({ transform: "translateX(0)", opacity: 1 })
  })

  test("a press past an end nudges the way the item would have left, and moves nothing", () => {
    expect(press("next", { blocked: true })).toEqual({ kind: "nudge", offsetPx: -EDGE_NUDGE_PX })
    expect(press("previous", { blocked: true })).toEqual({ kind: "nudge", offsetPx: EDGE_NUDGE_PX })
  })

  test("a held key steps at once, and doesn't nudge again and again at an end", () => {
    expect(press("next", { repeat: true })).toEqual({ kind: "instant" })
    expect(press("next", { blocked: true, repeat: true })).toEqual({ kind: "none" })
  })

  test("reduced motion fades in place of the slide, with no nudge", () => {
    expect(press("next", { reducedMotion: true })).toEqual({ kind: "fade" })
    expect(enterKeyframes({ kind: "fade" })).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(press("previous", { blocked: true, reducedMotion: true })).toEqual({ kind: "none" })
  })
})
