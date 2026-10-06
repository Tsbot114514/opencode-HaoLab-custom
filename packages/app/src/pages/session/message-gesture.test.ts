import { describe, expect, test } from "bun:test"
import { mobileNavigationSwipe, normalizeWheelDelta, shouldMarkBoundaryGesture } from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("converts line mode to px", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 500 })).toBe(120)
  })

  test("converts page mode to container height", () => {
    expect(normalizeWheelDelta({ deltaY: -1, deltaMode: 2, rootHeight: 600 })).toBe(-600)
  })

  test("keeps pixel mode unchanged", () => {
    expect(normalizeWheelDelta({ deltaY: 16, deltaMode: 0, rootHeight: 600 })).toBe(16)
  })
})

describe("mobileNavigationSwipe", () => {
  test("expands after an upward finger gesture or positive wheel movement", () => {
    expect(mobileNavigationSwipe(0, 14)).toEqual({ remaining: 14, direction: undefined })
    expect(mobileNavigationSwipe(14, 19)).toEqual({ remaining: 0, direction: "expand" })
  })

  test("collapses after a downward gesture and ignores a direction change until threshold", () => {
    expect(mobileNavigationSwipe(20, -10)).toEqual({ remaining: -10, direction: undefined })
    expect(mobileNavigationSwipe(-10, -23)).toEqual({ remaining: 0, direction: "collapse" })
    expect(mobileNavigationSwipe(0, 3)).toEqual({ remaining: 3, direction: undefined })
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("marks when nested scroller cannot scroll", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 300,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond top boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -40,
        scrollTop: 10,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond bottom boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 50,
        scrollTop: 580,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("does not mark when nested scroller can consume movement", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(false)
  })
})
