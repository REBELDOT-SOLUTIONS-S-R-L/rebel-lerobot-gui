import type { DeviceRole } from './devices'

/**
 * Geometry for the annotated arm diagram.
 *
 * Both `assets/so101-robot.png` and `assets/so101-leader.png` are 800x1200 in
 * the same pose, but the leader sits ~40px further left, so each gets its own
 * anchor table. Anchors are normalized to the *image* (0..1); everything else
 * is expressed in the diagram's own user-space units so the SVG overlay and the
 * HTML callout cards share one coordinate system and need no DOM measurement.
 *
 * These values were read off a decile grid rendered over the source images.
 * Nudging a dot is a one-line edit here — no component changes needed.
 */

export type CalloutSide = 'left' | 'right'

export interface MotorAnchor {
  motor: string
  /** Position of the motor in the image, normalized 0..1. */
  x: number
  y: number
  side: CalloutSide
  /** Vertical slot for the callout card, normalized 0..1 of diagram height. */
  calloutY: number
}

/** Diagram user-space: 800x1200 image centered in a 1740x1200 canvas. */
export const DIAGRAM = {
  width: 1740,
  height: 1200,
  image: { x: 470, y: 0, width: 800, height: 1200 },
  /** x where a leader line terminates and its card begins. */
  leaderStop: { left: 430, right: 1310 }
} as const

/** Fraction of the diagram width taken by one callout gutter. */
export const GUTTER_FRACTION = DIAGRAM.leaderStop.left / DIAGRAM.width

const ROBOT_ANCHORS: readonly MotorAnchor[] = [
  { motor: 'shoulder_pan', x: 0.613, y: 0.75, side: 'right', calloutY: 0.75 },
  { motor: 'shoulder_lift', x: 0.5, y: 0.604, side: 'left', calloutY: 0.63 },
  { motor: 'elbow_flex', x: 0.625, y: 0.412, side: 'right', calloutY: 0.45 },
  { motor: 'wrist_flex', x: 0.438, y: 0.182, side: 'right', calloutY: 0.15 },
  { motor: 'wrist_roll', x: 0.306, y: 0.263, side: 'left', calloutY: 0.21 },
  { motor: 'gripper', x: 0.281, y: 0.375, side: 'left', calloutY: 0.42 }
] as const

const LEADER_ANCHORS: readonly MotorAnchor[] = [
  { motor: 'shoulder_pan', x: 0.575, y: 0.75, side: 'right', calloutY: 0.75 },
  { motor: 'shoulder_lift', x: 0.444, y: 0.6, side: 'left', calloutY: 0.63 },
  { motor: 'elbow_flex', x: 0.556, y: 0.412, side: 'right', calloutY: 0.45 },
  { motor: 'wrist_flex', x: 0.394, y: 0.175, side: 'right', calloutY: 0.15 },
  { motor: 'wrist_roll', x: 0.319, y: 0.263, side: 'left', calloutY: 0.21 },
  { motor: 'gripper', x: 0.338, y: 0.35, side: 'left', calloutY: 0.42 }
] as const

export function anchorsFor(role: DeviceRole): readonly MotorAnchor[] {
  return role === 'robot' ? ROBOT_ANCHORS : LEADER_ANCHORS
}

/** Image file each role's diagram uses, relative to the assets root. */
export function armImageFor(role: DeviceRole): string {
  return role === 'robot' ? 'so101-robot.png' : 'so101-leader.png'
}

/** Anchor position in diagram user-space. */
export function anchorPoint(a: MotorAnchor): { x: number; y: number } {
  return {
    x: DIAGRAM.image.x + a.x * DIAGRAM.image.width,
    y: DIAGRAM.image.y + a.y * DIAGRAM.image.height
  }
}

/**
 * Elbowed leader line: out of the joint, a short diagonal, then a horizontal
 * run to the gutter. Returns an SVG points string.
 */
export function leaderPoints(a: MotorAnchor): string {
  const p = anchorPoint(a)
  const stop = a.side === 'left' ? DIAGRAM.leaderStop.left : DIAGRAM.leaderStop.right
  const targetY = a.calloutY * DIAGRAM.height
  // Bend partway between the joint and the gutter, then run flat to the card.
  const bendX = a.side === 'left' ? p.x - (p.x - stop) * 0.45 : p.x + (stop - p.x) * 0.45
  return `${p.x},${p.y} ${bendX},${targetY} ${stop},${targetY}`
}

