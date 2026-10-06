export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export function mobileNavigationSwipe(total: number, delta: number) {
  const next = total * delta > 0 ? total + delta : delta
  if (next >= 32) return { remaining: 0, direction: "expand" as const }
  if (next <= -32) return { remaining: 0, direction: "collapse" as const }
  return { remaining: next, direction: undefined }
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  if (input.delta < 0) return input.scrollTop + input.delta <= 0

  const remaining = max - input.scrollTop
  return input.delta > remaining
}
