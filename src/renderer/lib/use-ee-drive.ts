import {
  HOME_RATE,
  STALL_FRACTION,
  STALL_GRACE,
  advanceGripper,
  advanceJoints,
  requestedTravel,
  stepTowards
} from '@shared/ee-drive'
import { forwardKinematics, poseOf, translationOf, type Pose } from '@shared/kinematics'
import { centrePose, poseFromReadings, ticksFromPose, type JointReading } from '@shared/sim'
import {
  EE_LOOP_HZ,
  IDLE_COMMAND,
  KEYBOARD_CODES,
  commandFromKeys,
  commandFromPad,
  homeFromKeys,
  homeFromPad,
  isIdle,
  type EeCommand,
  type PadSnapshot
} from '@shared/teleop-input'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import { IK_JOINTS, type ArmKinematics } from './arm-kinematics'

/**
 * The control loop behind keyboard and gamepad teleoperation.
 *
 * Fifty times a second it reads the keys or the sticks, moves its idea of where
 * the tool should be, solves the joint angles that put it there, and writes
 * those to the arm as goal positions. The arithmetic is all in `@shared/ee-drive`
 * and `@shared/kinematics`; what is here is the wiring — listeners, the timer,
 * and the once-per-engage handshake with the arm.
 *
 * The loop tracks the pose it has *commanded*, seeded from where the arm was
 * when it engaged, and not the pose the arm reports back. That is the same
 * latched reference LeRobot's own end-effector pipeline defaults to: on a loaded
 * arm the two diverge by however much the servos sag, and re-seeding from the
 * measurement every frame turns that sag into drift the operator has to fight.
 * The 3D view follows the real readings, so the difference stays visible.
 */

export interface EeDriveOptions {
  /** The follower to drive. */
  uid: string | null
  controller: 'keyboard' | 'gamepad'
  /** False stops the loop, drops the listeners and leaves the arm holding. */
  engaged: boolean
  kinematics: ArmKinematics | null
  /** Calibrated ranges and the last positions read, from the open snapshot. */
  readings: Record<string, JointReading>
  /** Multiplier on the base speeds; 1 is normal. */
  speed: number
}

export interface EeDriveState {
  /** What the input is asking for right now, for the on-screen meters. */
  command: EeCommand
  /** The commanded tool pose, in the arm's base frame. */
  tool: Pose | null
  /** How far the last solve fell short, in metres and radians. */
  positionError: number
  orientationError: number
  /** Joints the solver had to hold against an end stop. */
  clamped: string[]
  /**
   * The tool is being asked to move and is not moving — out of reach, or held
   * by a stop. What the panel warns about; see `requestedTravel`.
   */
  stalled: boolean
  /** Jaw opening, 0 shut to 1 wide. */
  gripper: number
  /** Travelling back to the middle of every range. */
  homing: boolean
  /** The gamepad being read, when there is one. */
  pad: { id: string; standard: boolean } | null
  /** A write failed, so the arm has stopped following. */
  error: string | null
}

const IDLE_STATE: EeDriveState = {
  command: IDLE_COMMAND,
  tool: null,
  positionError: 0,
  orientationError: 0,
  clamped: [],
  stalled: false,
  gripper: 0.5,
  homing: false,
  pad: null,
  error: null
}

/** How often the meters refresh. Far below the loop rate; it is only a display. */
const PUBLISH_HZ = 15

/** Consecutive failed writes before the loop gives up and says so. */
const WRITE_FAILURE_LIMIT = 3

function readPad(): { snapshot: PadSnapshot; id: string } | null {
  const pads = navigator.getGamepads?.() ?? []
  for (const pad of pads) {
    if (!pad?.connected) continue
    return {
      id: pad.id,
      snapshot: {
        axes: pad.axes,
        buttons: pad.buttons.map((button) => button.value),
        standard: pad.mapping === 'standard'
      }
    }
  }
  return null
}

export function useEeDrive(opts: EeDriveOptions): EeDriveState {
  const { uid, controller, engaged, kinematics, readings, speed } = opts
  const [state, setState] = useState<EeDriveState>(IDLE_STATE)

  // Latest-value refs: the loop is not a render, so it reads these rather than
  // being torn down and rebuilt every time a reading arrives.
  const readingsRef = useRef(readings)
  readingsRef.current = readings
  const speedRef = useRef(speed)
  speedRef.current = speed

  useEffect(() => {
    if (!engaged || !uid || !kinematics) {
      setState(IDLE_STATE)
      return
    }
    const { chain, manifest } = kinematics
    const gripperJoint = manifest.joints.find((joint) => joint.name === 'gripper')

    // Seed from the arm's own pose, through exactly the conversion the 3D view
    // uses, so engaging never moves anything: the first frame's target is where
    // the tool already is.
    const seed = readingsRef.current
    const seedPose = poseFromReadings(manifest, seed)
    // Where the home command goes: the middle of every calibrated range, which
    // is not each joint's raw rest angle wherever a tuning offset applies.
    const centre = centrePose(manifest, seed)
    const homeAngles = IK_JOINTS.map((name) => centre[name] ?? 0)
    let angles = IK_JOINTS.map((name, index) => seedPose[name] ?? homeAngles[index])
    let gripper = gripperFractionOf(seed.gripper)

    const pressed = new Set<string>()
    let homing = false
    let homeHeld = false
    let dirty = false
    let writing = false
    let failures = 0
    let stopped = false
    let last = performance.now()
    let sincePublish = 0
    /**
     * What the last actual solve made of the target.
     *
     * Held across frames rather than recomputed: an idle frame does not solve,
     * and zeroing this on one would make the "against an end stop" warning
     * disappear the moment a key was released — exactly when the operator needs
     * to know why the arm stopped following.
     */
    let solution = { positionError: 0, orientationError: 0, clamped: [] as string[] }
    /** Seconds the tool has been asked to move without moving. */
    let stalledFor = 0

    /** A field has the keyboard, so the letters belong to it, not to the arm. */
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!KEYBOARD_CODES.has(event.code) || typing(event.target)) return
      // Arrows and page keys would otherwise scroll the panel out from under the
      // arm, and a key that both flies the tool and does something else is worse
      // than either on its own.
      event.preventDefault()
      pressed.add(event.code)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      pressed.delete(event.code)
    }
    /** A key held as the window loses focus would otherwise stay held forever. */
    const onBlur = (): void => pressed.clear()

    if (controller === 'keyboard') {
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
    }

    const timer = setInterval(() => {
      if (stopped) return
      const now = performance.now()
      // Capped: a backgrounded window resumes with a huge gap, and integrating
      // it would fling the arm across the table in one frame.
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now

      const pad = controller === 'gamepad' ? readPad() : null
      const command =
        controller === 'keyboard'
          ? commandFromKeys(pressed)
          : pad
            ? commandFromPad(pad.snapshot)
            : IDLE_COMMAND
      const home =
        controller === 'keyboard' ? homeFromKeys(pressed) : pad ? homeFromPad(pad.snapshot) : false

      if (home && !homeHeld) homing = true
      homeHeld = home
      // Any deliberate command takes the arm back off the home path.
      if (!isIdle(command)) homing = false

      if (homing) {
        const arrived = stepTowards(angles, homeAngles, dt, HOME_RATE)
        gripper += Math.sign(0.5 - gripper) * Math.min(Math.abs(0.5 - gripper), dt)
        if (arrived) homing = false
        dirty = true
        // Nothing is being solved for on the way home, and the pose being left
        // behind is the one any stale shortfall was about.
        solution = { positionError: 0, orientationError: 0, clamped: [] }
        stalledFor = 0
      } else if (!isIdle(command)) {
        const before = translationOf(forwardKinematics(chain, angles))
        const step = advanceJoints({ chain, angles, command, dt, speed: speedRef.current })
        angles = step.angles
        gripper = advanceGripper(gripper, command, dt, speedRef.current)
        solution = step
        dirty = true

        const asked = requestedTravel(command, dt, speedRef.current)
        const after = translationOf(forwardKinematics(chain, angles))
        const got = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])
        stalledFor = asked > 0 && got < asked * STALL_FRACTION ? stalledFor + dt : 0
      } else {
        // Not being asked for anything, so nothing is being refused.
        stalledFor = 0
      }

      if (dirty && !writing && failures < WRITE_FAILURE_LIMIT) {
        const pose: Record<string, number> = {}
        IK_JOINTS.forEach((name, index) => {
          pose[name] = angles[index]
        })
        if (gripperJoint) {
          pose.gripper = gripperJoint.lower + gripper * (gripperJoint.upper - gripperJoint.lower)
        }
        const ticks = ticksFromPose(manifest, pose, readingsRef.current)
        dirty = false
        writing = true
        void api.motor
          .moveMany(uid, ticks)
          .then((res) => {
            if (res.ok) {
              failures = 0
              return
            }
            failures += 1
            if (failures >= WRITE_FAILURE_LIMIT) {
              setState((prev) => ({ ...prev, error: res.error }))
            }
          })
          .catch((err: unknown) => {
            failures += 1
            if (failures >= WRITE_FAILURE_LIMIT) {
              setState((prev) => ({ ...prev, error: errorMessage(err) }))
            }
          })
          .finally(() => {
            writing = false
          })
      }

      sincePublish += dt
      if (sincePublish < 1 / PUBLISH_HZ) return
      sincePublish = 0
      setState((prev) => ({
        ...prev,
        command,
        tool: poseOf(forwardKinematics(chain, angles)),
        positionError: solution.positionError,
        orientationError: solution.orientationError,
        clamped: solution.clamped,
        stalled: stalledFor >= STALL_GRACE,
        gripper,
        homing,
        pad: pad ? { id: pad.id, standard: pad.snapshot.standard } : null
      }))
    }, 1000 / EE_LOOP_HZ)

    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    // `readings` and `speed` are read through refs on purpose; re-running the
    // effect for either would re-seed the loop from the arm mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, uid, controller, kinematics])

  return state
}

/** The jaws' opening as a fraction of their travel; half-open with no reading. */
function gripperFractionOf(reading: JointReading | undefined): number {
  if (!reading || reading.position === null) return 0.5
  const min = reading.rangeMin ?? 0
  const max = reading.rangeMax ?? 0
  if (max <= min) return 0.5
  return Math.min(1, Math.max(0, (reading.position - min) / (max - min)))
}
