import { expect, test } from "bun:test"
import { startupSlot } from "./startup-slot"

test("startup slots fail on early reads and double binding", () => {
  const slot = startupSlot<{ value: number }>("router")

  expect(() => slot.get()).toThrow("router was read before startup bound it")
  const router = { value: 1 }
  expect(slot.bind(router)).toBe(router)
  expect(slot.get()).toBe(router)
  expect(() => slot.bind({ value: 2 })).toThrow("router was already bound")
})
