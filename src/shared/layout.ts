/**
 * Geometry for the panels' resizable two-column split.
 *
 * Pure so the rules can be tested without a DOM: the drag handler and the
 * window-resize handler both go through `clampSidebarWidth`, which is the only
 * place the limits are expressed.
 */

/** The side column never exceeds half the window, however far the drag goes. */
export const SIDEBAR_MAX_FRACTION = 0.5

/** Below this the side column stops being usable, so dragging snaps up to it. */
export const SIDEBAR_MIN = 280

export function clampSidebarWidth(opts: {
  width: number
  /** Width of the split container itself. */
  containerWidth: number
  /** Window width, which the 50% ceiling is measured against. */
  windowWidth: number
  /** Floor for the main column, so a drag cannot collapse the real content. */
  minMain: number
}): number {
  const { width, containerWidth, windowWidth, minMain } = opts
  const upper = Math.min(windowWidth * SIDEBAR_MAX_FRACTION, containerWidth - minMain)
  // The ceiling wins over the floor: in a window too narrow for both, the side
  // column gives way rather than squeezing the main one below its minimum.
  return Math.round(Math.max(Math.min(width, upper), Math.min(SIDEBAR_MIN, upper)))
}
