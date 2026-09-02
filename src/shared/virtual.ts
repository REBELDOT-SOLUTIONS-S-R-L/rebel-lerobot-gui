/**
 * The virtual arm: a follower that exists only in the app.
 *
 * It is a stand-in for a real SO-101 — same six motors, same encoder ticks, same
 * calibrated ranges — with no serial port, no motors and nothing to set up. It
 * is offered wherever a follower is, so the whole app can be driven, watched in
 * 3D and replayed onto without any hardware plugged in, and without a Python
 * environment: nothing about it goes through LeRobot.
 *
 * Its name and model are fixed on purpose. A profile's name is what LeRobot
 * addresses its calibration by, and its model decides which 3D scene loads; the
 * virtual arm answers both questions itself, so there is nothing here for a user
 * to get wrong.
 */

import type { ArmModel, DeviceRole } from './devices'
import { STS3215_MAX_TICK } from './devices'
import type { DeviceProfile } from './types'

export const VIRTUAL_UID = 'virtual-arm'

/** Also the calibration filename, so it has to be filename-safe. */
export const VIRTUAL_ID = 'virtual_arm'

export const VIRTUAL_MODEL: ArmModel = 'SO101'

export const VIRTUAL_ROLE: DeviceRole = 'robot'

export function isVirtual(uid: string | null | undefined): boolean {
  return uid === VIRTUAL_UID
}

/**
 * The virtual arm's profile.
 *
 * Synthesised rather than stored: it must exist before anything is configured,
 * it must never be editable, and it must not be one of the profiles a user can
 * delete. The calibration folder is the only thing that comes from outside, so
 * "save what the sim is holding" writes somewhere the rest of the app can see.
 */
export function virtualProfile(calibrationDir: string): DeviceProfile {
  return {
    uid: VIRTUAL_UID,
    id: VIRTUAL_ID,
    role: VIRTUAL_ROLE,
    model: VIRTUAL_MODEL,
    port: '',
    calibrationDir,
    cameras: [],
    notes: 'Simulated in the app — no serial port, no motors, nothing to calibrate.'
  }
}

/* ------------------------------------------------------------------ *
 * Factory calibration                                                 *
 * ------------------------------------------------------------------ */

/** Mid-scale on a 12-bit encoder. Every bounded joint is centred here. */
export const VIRTUAL_CENTRE = Math.round(STS3215_MAX_TICK / 2)

const TICKS_PER_RADIAN = STS3215_MAX_TICK / (2 * Math.PI)

/**
 * Half of each joint's modelled travel, in radians.
 *
 * Straight off the `<limit>` elements of the URDFs in `assets/simulation`:
 * `(upper - lower) / 2`, which for a joint whose rest pose is its midpoint is
 * how far it swings each way. `tests/virtual.test.ts` checks the ranges below
 * against those files, so an edit to a URDF cannot silently leave the virtual
 * arm describing a differently-shaped one.
 *
 * `wrist_roll` is absent because it spins: LeRobot records a whole turn for it
 * rather than measuring stops (see CONTINUOUS_JOINTS), and so does this.
 * `gripper` is absent because its calibration is a span rather than an angle —
 * the linkage between servo and jaw is not 1:1, so any range works and a wide
 * one is the most readable.
 */
const HALF_TRAVEL: Record<ArmModel, Readonly<Record<string, number>>> = {
  SO101: {
    shoulder_pan: 1.91986,
    shoulder_lift: 1.74533,
    elbow_flex: 1.69,
    wrist_flex: 1.65806
  },
  SO100: {
    shoulder_pan: 2,
    shoulder_lift: 1.75,
    elbow_flex: 1.57079,
    wrist_flex: 1.85
  }
}

/** A full turn, for the joint that has no stops to record. */
const FULL_TURN = { min: 0, max: STS3215_MAX_TICK }

/** Half the encoder, centred — a plausible gripper span, and obviously round. */
const GRIPPER_SPAN = {
  min: VIRTUAL_CENTRE - 1024,
  max: VIRTUAL_CENTRE + 1024
}

export interface VirtualRange {
  min: number
  max: number
}

/**
 * The tick range the virtual arm reports for one joint, as a real arm's
 * calibration file would.
 */
export function virtualRange(model: ArmModel, motor: string): VirtualRange {
  if (motor === 'wrist_roll') return { ...FULL_TURN }
  if (motor === 'gripper') return { ...GRIPPER_SPAN }
  const half = HALF_TRAVEL[model][motor]
  if (half === undefined) return { ...FULL_TURN }
  const ticks = Math.round(half * TICKS_PER_RADIAN)
  return { min: VIRTUAL_CENTRE - ticks, max: VIRTUAL_CENTRE + ticks }
}
