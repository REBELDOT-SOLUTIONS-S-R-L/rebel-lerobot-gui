/**
 * LeRobot's tick <-> normalized-unit conversion, in TypeScript.
 *
 * Everything LeRobot puts on a wire or in a dataset is normalized: a body joint
 * is degrees from the middle of its calibrated range, the gripper is a
 * percentage of its own travel. Encoder ticks only exist inside the motor bus.
 *
 * The app needs both directions in-process for the two things it drives itself:
 * mapping a leader arm's readings onto a follower with a different calibration,
 * and turning a recorded episode's actions back into goal positions. Both are
 * only correct if they agree with `MotorsBus._normalize` / `._unnormalize`
 * exactly (motors_bus.py:854-911), so this is a deliberate transcription —
 * including that DEGREES ignores `drive_mode`, which the other two modes apply.
 */

import type { MotorNormMode, MotorSpec } from './devices'
import { SO_ARM_MOTORS, STS3215_MAX_TICK } from './devices'

/** One motor's calibration, as far as normalization is concerned. */
export interface TickRange {
  min: number
  max: number
  /** `drive_mode` from the calibration file; 1 mirrors the normalized value. */
  driveMode?: number | null
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Encoder ticks -> the units LeRobot's observations and actions are in. */
export function normalizeTicks(mode: MotorNormMode, ticks: number, range: TickRange): number {
  const { min, max } = range
  if (max === min) throw new Error('Invalid calibration: min and max are equal.')
  const flip = !!range.driveMode

  if (mode === 'degrees') {
    const mid = (min + max) / 2
    return ((ticks - mid) * 360) / STS3215_MAX_TICK
  }
  const bounded = clamp(ticks, min, max)
  if (mode === 'range_0_100') {
    const norm = ((bounded - min) / (max - min)) * 100
    return flip ? 100 - norm : norm
  }
  const norm = ((bounded - min) / (max - min)) * 200 - 100
  return flip ? -norm : norm
}

/** The inverse: a normalized value -> encoder ticks, truncated as LeRobot does. */
export function unnormalizeTicks(mode: MotorNormMode, value: number, range: TickRange): number {
  const { min, max } = range
  if (max === min) throw new Error('Invalid calibration: min and max are equal.')
  const flip = !!range.driveMode

  if (mode === 'degrees') {
    const mid = (min + max) / 2
    return Math.trunc((value * STS3215_MAX_TICK) / 360 + mid)
  }
  if (mode === 'range_0_100') {
    const bounded = clamp(flip ? 100 - value : value, 0, 100)
    return Math.trunc((bounded / 100) * (max - min) + min)
  }
  const bounded = clamp(flip ? -value : value, -100, 100)
  return Math.trunc(((bounded + 100) / 200) * (max - min) + min)
}

/**
 * A reading on one arm as the equivalent goal position on another.
 *
 * This is teleoperation in one line: `lerobot-teleoperate` reads the leader
 * normalized and writes the follower unnormalized, so two arms with different
 * calibrated ranges still describe the same pose. Used when the follower is the
 * virtual arm, where there is no `lerobot-teleoperate` process to do it.
 */
export function retarget(
  mode: MotorNormMode,
  ticks: number,
  from: TickRange,
  to: TickRange
): number {
  return unnormalizeTicks(mode, normalizeTicks(mode, ticks, from), to)
}

/**
 * Which column of a recorded action belongs to which motor.
 *
 * LeRobot names an arm's action features `<motor>.pos`
 * (`so_follower.action_features`). Anything else in the row — a mobile base's
 * wheels, the second arm of a bimanual recording — has no motor on this arm and
 * is left out rather than guessed at, so a dataset recorded on other hardware
 * replays whatever part of it does apply.
 */
export function actionColumnMotors(columns: readonly string[]): [number, MotorSpec][] {
  const pairs: [number, MotorSpec][] = []
  columns.forEach((column, index) => {
    const name = column.replace(/\.pos$/, '')
    const motor = SO_ARM_MOTORS.find((spec) => spec.name === name)
    if (motor) pairs.push([index, motor])
  })
  return pairs
}
