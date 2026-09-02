/**
 * The 3D view's scene description, and how a motor reading becomes a joint angle.
 *
 * The scenes themselves are built offline by `tools/blender/build_sim_scene.py`,
 * which writes a `.glb` and the manifest typed below. Everything here is pure:
 * the renderer does the WebGL, this decides what pose to put the model in.
 */

import type { ArmModel } from './devices'
import { STS3215_MAX_TICK } from './devices'
import type { MotorState } from './types'

/** One movable URDF joint, and the glTF node the viewer rotates for it. */
export interface SimJoint {
  /** Motor name — the URDF joint names match LeRobot's motor names exactly. */
  name: string
  /** Node in the glb, e.g. `joint__elbow_flex`. Identity at rest. */
  node: string
  /** Rotation axis in the node's own frame, already in glTF (Y-up) coordinates. */
  axis: [number, number, number]
  lower: number
  upper: number
  /** URDF angle a joint sitting mid-travel is at. See the build script. */
  rest: number
}

export interface SimManifest {
  model: ArmModel
  robot: string
  urdf: string
  /** Path of the glb under the assets root, for `assetUrl`. */
  glb: string
  generator: string
  generatedAt: string
  rootNode: string
  groundNode: string
  triangles: number
  joints: SimJoint[]
  ground: { light: string; dark: string; size: number }
  lighting: {
    ambient: { color: string; intensity: number }
    hemisphere: { sky: string; ground: string; intensity: number }
    key: { color: string; intensity: number; direction: [number, number, number] }
  }
  camera: {
    position: [number, number, number]
    target: [number, number, number]
    /** Vertical field of view, in degrees. */
    fov: number
    /** Radius of the volume the default framing covers. */
    radius: number
  }
}

/** Manifest for each model, relative to the assets root. */
export const SIM_MANIFESTS: Record<ArmModel, string> = {
  SO100: 'simulation/generated/so100.json',
  SO101: 'simulation/generated/so101.json'
}

/**
 * Encoder counts in one turn of the output shaft.
 *
 * 4095, not 4096: LeRobot divides by `model_resolution_table[model] - 1`
 * (`MotorsBus._normalize`), and matching it exactly is what keeps this view and
 * `lerobot-teleoperate` describing the same angle.
 */
export const TICKS_PER_TURN = STS3215_MAX_TICK

/**
 * Joints whose calibrated tick range is stretched over the URDF's limits rather
 * than converted one-to-one.
 *
 * The five body joints turn with the servo, so a tick is 360/4095 degrees of
 * joint — the conversion LeRobot's DEGREES mode uses, and what it feeds to the
 * URDF in `RobotKinematics.forward_kinematics`. The gripper is not on that
 * chain: LeRobot drives it as 0..100 % of its own travel, and the linkage
 * between servo and jaw is not 1:1, so mapping its range onto the jaw's range is
 * both closer to the truth and more readable — shut at the minimum, wide at the
 * maximum, whatever the calibration measured.
 */
export const SPAN_JOINTS: readonly string[] = ['gripper']

/**
 * How a joint's encoder relates to the URDF's idea of the same joint.
 *
 * These are facts about the hardware that neither the URDF nor the calibration
 * file records, so they cannot be derived and are not folded into the generated
 * scene — they are watched on a real arm and written down here.
 */
export interface JointTuning {
  /** The encoder counts up the opposite way to the URDF's positive rotation. */
  reversed?: boolean
  /** Constant radians to add, for a joint whose zero is not the URDF's zero. */
  offset?: number
  /** The joint turns freely, so the URDF's end stops must not clamp it. */
  continuous?: boolean
}

/**
 * Joints whose encoder counts up the opposite way to the URDF's rotation.
 *
 * `shoulder_pan` was found reversed on a real SO-101. The SO-100 is not listed
 * because the two URDFs disagree about which way that joint turns: SO-101's
 * origin puts the joint axis at -Z in the base frame (positive is clockwise seen
 * from above), SO-100's at +Z (counter-clockwise). Same servo, opposite
 * conventions, so only one of them needs flipping. That half is reasoned from
 * the geometry rather than watched on an arm.
 */
export const REVERSED_JOINTS: Record<ArmModel, readonly string[]> = {
  SO100: [],
  SO101: ['shoulder_pan']
}

/**
 * Constant angle between a joint's calibrated zero and the URDF's, in radians.
 *
 * Only `wrist_roll` needs one, and it is the one joint that could not avoid it:
 * LeRobot calls it the `full_turn_motor` and writes `range_min = 0`,
 * `range_max = 4095` for it (`so_follower.calibrate`), never measuring where it
 * actually stops. Its zero is therefore wherever the wrist happened to be when
 * you pressed ENTER at "move to the middle of its range", while the URDF's zero
 * is the middle of the modelled range — and the servo horn's splines put those a
 * quarter turn apart.
 *
 * Signs are as the arm sees them: positive turns the model the way a positive
 * reading does. This one was measured against a real SO-101, viewed along the
 * arm from the wrist out towards the jaws.
 */
export const JOINT_OFFSETS: Record<ArmModel, Readonly<Record<string, number>>> = {
  SO100: {},
  SO101: { wrist_roll: Math.PI / 2 }
}

/**
 * Joints with no end stops to hit.
 *
 * `wrist_roll` spins: LeRobot exempts it from the range-of-motion sweep and
 * records a whole turn for it. The URDF still gives it limits, which describe
 * how far the wiring allows rather than anything the encoder knows — clamping to
 * them would freeze the model mid-turn while the real wrist kept going.
 */
export const CONTINUOUS_JOINTS: Record<ArmModel, readonly string[]> = {
  SO100: ['wrist_roll'],
  SO101: ['wrist_roll']
}

/**
 * Yaw, in radians, that puts the arm's reach on the base frame's +X axis.
 *
 * The two URDFs disagree about which way the arm faces from its own root frame:
 * SO-101's reaches along +X, SO-100's along -Y. That is invisible while all the
 * app does is pose a model, but end-effector control has to name directions —
 * a key labelled "forward" has to send the tool forward on both arms — so the
 * solver's chain is built with this rotation folded in ahead of the first joint
 * (`buildChain`'s `base`). +Z is up in both, so a yaw is all it takes.
 */
export const BASE_YAW: Record<ArmModel, number> = {
  SO100: Math.PI / 2,
  SO101: 0
}

/** Everything known about how one joint's readings map onto the model. */
export function jointTuning(model: ArmModel, joint: string): JointTuning {
  return {
    reversed: REVERSED_JOINTS[model].includes(joint),
    offset: JOINT_OFFSETS[model][joint] ?? 0,
    continuous: CONTINUOUS_JOINTS[model].includes(joint)
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Position and calibrated range — the part of `MotorState` this needs. */
export interface JointReading {
  position: number | null
  rangeMin: number | null
  rangeMax: number | null
}

/**
 * Angle in radians to put a joint at, for one motor reading.
 *
 * Falls back to the joint's rest angle when the motor is offline, and to the
 * full encoder span when the device has no calibration yet — the same fallback
 * the 2D diagram's travel bar uses. `reversed` mirrors the travel about the rest
 * pose, which is the one pose both the arm and the model already agree on.
 */
export function jointAngleRad(
  joint: SimJoint,
  reading: JointReading | undefined,
  tuning: JointTuning = {}
): number {
  const { reversed = false, offset = 0, continuous = false } = tuning
  if (!reading || reading.position === null) return joint.rest
  const min = reading.rangeMin ?? 0
  const max = reading.rangeMax ?? STS3215_MAX_TICK
  if (max <= min) return joint.rest
  const stops = (angle: number): number =>
    continuous ? angle : clamp(angle, joint.lower, joint.upper)

  if (SPAN_JOINTS.includes(joint.name)) {
    const travelled = clamp((reading.position - min) / (max - min), 0, 1)
    const fraction = reversed ? 1 - travelled : travelled
    return stops(joint.lower + fraction * (joint.upper - joint.lower) + offset)
  }

  const centre = (min + max) / 2
  const turned = ((reading.position - centre) * 2 * Math.PI) / TICKS_PER_TURN
  return stops(joint.rest + (reversed ? -turned : turned) + offset)
}

/**
 * The inverse of `jointAngleRad`: the encoder tick that puts a joint at `angle`.
 *
 * Inverse kinematics works in the URDF's radians, and the motors only take
 * ticks, so this is the last step of every command the app sends itself —
 * keyboard and gamepad teleoperation, and driving the virtual arm. Going back
 * through the same tuning the 3D view uses is what makes the model and the arm
 * agree about where a solved pose is.
 *
 * The result is clamped to the joint's calibrated range: an angle the URDF
 * allows can still be past a stop this particular arm measured, and the
 * calibration is the one that knows about the real hardware. Null when there is
 * no range to work against, which is `jointAngleRad`'s rest-pose case seen from
 * the other side.
 */
export function ticksForAngle(
  joint: SimJoint,
  angle: number,
  reading: JointReading | undefined,
  tuning: JointTuning = {}
): number | null {
  const { reversed = false, offset = 0 } = tuning
  const min = reading?.rangeMin ?? 0
  const max = reading?.rangeMax ?? STS3215_MAX_TICK
  if (max <= min) return null

  if (SPAN_JOINTS.includes(joint.name)) {
    const span = joint.upper - joint.lower
    if (span === 0) return null
    const fraction = (angle - offset - joint.lower) / span
    const travelled = clamp(reversed ? 1 - fraction : fraction, 0, 1)
    return Math.round(min + travelled * (max - min))
  }

  const centre = (min + max) / 2
  const turned = angle - offset - joint.rest
  const ticks = centre + ((reversed ? -turned : turned) * TICKS_PER_TURN) / (2 * Math.PI)
  return Math.round(clamp(ticks, min, max))
}

/** Every joint's angle, keyed by motor name. */
export function poseFromReadings(
  manifest: SimManifest,
  readings: Record<string, JointReading>
): Record<string, number> {
  const pose: Record<string, number> = {}
  for (const joint of manifest.joints) {
    pose[joint.name] = jointAngleRad(
      joint,
      readings[joint.name],
      jointTuning(manifest.model, joint.name)
    )
  }
  return pose
}

/** `MotorState[]` from a bus snapshot, in the shape `poseFromReadings` wants. */
export function readingsFromMotors(motors: readonly MotorState[]): Record<string, JointReading> {
  const readings: Record<string, JointReading> = {}
  for (const motor of motors) {
    readings[motor.name] = {
      position: motor.position,
      rangeMin: motor.rangeMin,
      rangeMax: motor.rangeMax
    }
  }
  return readings
}

/** Every joint's tick, for a pose in radians. Joints with no range are dropped. */
export function ticksFromPose(
  manifest: SimManifest,
  pose: Record<string, number>,
  readings: Record<string, JointReading>
): Record<string, number> {
  const ticks: Record<string, number> = {}
  for (const joint of manifest.joints) {
    const angle = pose[joint.name]
    if (typeof angle !== 'number' || Number.isNaN(angle)) continue
    const tick = ticksForAngle(
      joint,
      angle,
      readings[joint.name],
      jointTuning(manifest.model, joint.name)
    )
    if (tick !== null) ticks[joint.name] = tick
  }
  return ticks
}

/**
 * The pose an arm holds at the middle of every calibrated range.
 *
 * What the "home" command drives to, and the safest pose to start a solve from.
 * Not simply each joint's `rest` angle: a joint with a tuning offset — SO-101's
 * `wrist_roll`, whose servo zero sits a quarter turn from the URDF's — reads
 * `rest + offset` at mid-range, and driving it to `rest` instead would park it a
 * quarter turn off centre. Going through `jointAngleRad` keeps this the exact
 * inverse of `ticksForAngle`, so homing lands on mid-scale to the tick.
 */
export function centrePose(
  manifest: SimManifest,
  readings: Record<string, JointReading>
): Record<string, number> {
  const pose: Record<string, number> = {}
  for (const joint of manifest.joints) {
    const reading = readings[joint.name]
    const min = reading?.rangeMin ?? 0
    const max = reading?.rangeMax ?? STS3215_MAX_TICK
    pose[joint.name] = jointAngleRad(
      joint,
      { position: Math.round((min + max) / 2), rangeMin: min, rangeMax: max },
      jointTuning(manifest.model, joint.name)
    )
  }
  return pose
}

/** Overlay the live stream's ticks onto the snapshot's calibrated ranges. */
export function applyPositions(
  readings: Record<string, JointReading>,
  positions: Record<string, number>
): Record<string, JointReading> {
  const next = { ...readings }
  for (const [name, position] of Object.entries(positions)) {
    const known = next[name] ?? { position: null, rangeMin: null, rangeMax: null }
    next[name] = { ...known, position }
  }
  return next
}
