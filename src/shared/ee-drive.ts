/**
 * One control frame of end-effector driving.
 *
 * The loop this belongs to is in the renderer, where the keys and the gamepad
 * are; the arithmetic is here so it can be tested without a browser and so the
 * two decisions that shape how the arm feels are written down in one place:
 *
 *  - The target is taken from the pose the solver last reached, not from a
 *    free-running ideal one. A five-joint arm cannot hold an orientation while
 *    it translates, so an ideal target would drift further out of reach the
 *    longer a key was held; relatching means every frame asks for something a
 *    fraction of a millimetre away, which converges in one or two iterations and
 *    never jumps to a different arm configuration mid-flight.
 *  - Translation is in the base frame and rotation in the tool frame. Forward
 *    stays forward however the wrist is turned, and a roll is a roll of the jaws
 *    rather than of the room. LeRobot's own end-effector pipeline splits them
 *    the same way (`EEReferenceAndDelta`).
 */

import {
  forwardKinematics,
  fromRotationVector,
  multiply,
  solveIk,
  translationOf,
  type Chain,
  type IkOptions,
  type IkSolution,
  type Mat4
} from './kinematics'
import {
  EE_ANGULAR_SPEED,
  EE_FINE_SCALE,
  EE_GRIPPER_SPEED,
  EE_LINEAR_SPEED,
  isIdle,
  type EeCommand
} from './teleop-input'

/** Everything a frame needs. `speed` scales the base rates; 1 is normal. */
export interface DriveStep {
  chain: Chain
  /** Where the solver left the joints last frame, in radians. */
  angles: readonly number[]
  command: EeCommand
  /** Seconds since the previous frame. */
  dt: number
  speed?: number
  ik?: IkOptions
}

/** How much of a rate this frame gets, after the fine modifier. */
export function frameScale(command: EeCommand, speed = 1, dt = 0): number {
  return speed * (command.fine ? EE_FINE_SCALE : 1) * dt
}

/** The pose one frame of command asks the tool to move to. */
export function targetPose(step: DriveStep): Mat4 {
  const { chain, angles, command } = step
  const current = forwardKinematics(chain, angles)
  const scale = frameScale(command, step.speed, step.dt)

  const position = translationOf(current)
  const turned = multiply(
    current,
    fromRotationVector([
      command.rx * EE_ANGULAR_SPEED * scale,
      command.ry * EE_ANGULAR_SPEED * scale,
      command.rz * EE_ANGULAR_SPEED * scale
    ])
  )
  return [
    turned[0], turned[1], turned[2], position[0] + command.x * EE_LINEAR_SPEED * scale,
    turned[4], turned[5], turned[6], position[1] + command.y * EE_LINEAR_SPEED * scale,
    turned[8], turned[9], turned[10], position[2] + command.z * EE_LINEAR_SPEED * scale,
    0, 0, 0, 1
  ]
}

/**
 * The joint angles one frame of command leads to.
 *
 * An idle command is answered with the angles unchanged rather than with a
 * solve: it is the common case, and re-solving a target that is already met
 * would let numerical noise walk the arm around while nothing is being asked of
 * it.
 */
export function advanceJoints(step: DriveStep): IkSolution {
  const angles = [...step.angles]
  if (isIdle(step.command) || step.dt <= 0) {
    return {
      angles,
      positionError: 0,
      orientationError: 0,
      iterations: 0,
      converged: true,
      clamped: []
    }
  }
  return solveIk(step.chain, targetPose(step), angles, step.ik)
}

/**
 * The jaws' new opening, as a fraction of their travel.
 *
 * Not part of the inverse-kinematics chain: the gripper hangs off the wrist and
 * does not move the tool, so it is driven straight from its own axis.
 */
export function advanceGripper(
  fraction: number,
  command: EeCommand,
  dt: number,
  speed = 1
): number {
  const next = fraction + command.gripper * EE_GRIPPER_SPEED * frameScale(command, speed, dt)
  return next < 0 ? 0 : next > 1 ? 1 : next
}

/**
 * Step a set of angles towards another at a limited rate.
 *
 * What the home command uses. Writing the rest pose straight out would have a
 * real arm cross its whole range at whatever speed the servos manage, which is
 * both alarming and hard on the gearing; walking there over a second or so is
 * the same move the bridge's motion test makes (`_glide`). True once every joint
 * has arrived.
 */
export function stepTowards(
  angles: number[],
  target: readonly number[],
  dt: number,
  rate: number
): boolean {
  const budget = rate * dt
  let arrived = true
  for (let i = 0; i < angles.length; i++) {
    const remaining = (target[i] ?? angles[i]) - angles[i]
    if (Math.abs(remaining) <= budget) {
      angles[i] = target[i] ?? angles[i]
      continue
    }
    angles[i] += Math.sign(remaining) * budget
    arrived = false
  }
  return arrived
}

/** Radians per second the home command travels at. */
export const HOME_RATE = 0.9

/**
 * How far one frame of command asks the tool to travel, in metres.
 *
 * Compared against how far it actually went, this is what detects a stalled
 * arm. Relatching the target from the pose last reached — the thing that makes
 * tracking clean — means the per-frame solver error stays tiny even when the arm
 * has run out of reach: each frame asks for a fraction of a millimetre, gets
 * most of it, and the next frame asks again from the same place. The arm simply
 * stops moving. Only the gap between asked and delivered says so.
 */
export function requestedTravel(command: EeCommand, dt: number, speed = 1): number {
  const scale = frameScale(command, speed, dt)
  return Math.hypot(command.x, command.y, command.z) * EE_LINEAR_SPEED * scale
}

/** Fraction of the asked-for travel below which the arm counts as stalled. */
export const STALL_FRACTION = 0.25

/** Seconds of that before the panel says so, rather than on one stuttered frame. */
export const STALL_GRACE = 0.3
