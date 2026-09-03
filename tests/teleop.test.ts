import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOTOR_NAMES } from '@shared/devices'
import {
  HOME_RATE,
  advanceGripper,
  advanceJoints,
  frameScale,
  requestedTravel,
  stepTowards,
  targetPose,
  STALL_FRACTION
} from '@shared/ee-drive'
import {
  buildChain,
  forwardKinematics,
  fromAxisAngle,
  multiply,
  toRotationVector,
  translationOf,
  type Chain
} from '@shared/kinematics'
import { BASE_YAW, SIM_MANIFESTS, type SimManifest } from '@shared/sim'
import {
  EE_ANGULAR_SPEED,
  EE_AXES,
  EE_FINE_SCALE,
  EE_LINEAR_SPEED,
  FINE_KEYS,
  HOME_KEYS,
  IDLE_COMMAND,
  KEYBOARD_BINDINGS,
  KEYBOARD_CODES,
  applyDeadzone,
  commandFromKeys,
  commandFromPad,
  drivenInApp,
  homeFromKeys,
  homeFromPad,
  isIdle,
  keyLabel,
  type EeCommand,
  type PadSnapshot
} from '@shared/teleop-input'
import { parseUrdfJoints } from '@shared/urdf'
import { VIRTUAL_UID } from '@shared/virtual'
import { describe, expect, it } from 'vitest'

const IK_JOINTS = MOTOR_NAMES.filter((name) => name !== 'gripper')

function chain(): Chain {
  const manifest = JSON.parse(
    readFileSync(resolve('assets', SIM_MANIFESTS.SO101), 'utf8')
  ) as SimManifest
  return buildChain(
    parseUrdfJoints(readFileSync(resolve(manifest.urdf), 'utf8')),
    IK_JOINTS,
    fromAxisAngle([0, 0, 1], BASE_YAW.SO101)
  )
}

const keys = (...codes: string[]): Set<string> => new Set(codes)

function pad(patch: { axes?: number[]; buttons?: number[] } = {}): PadSnapshot {
  return {
    axes: patch.axes ?? [0, 0, 0, 0],
    buttons: patch.buttons ?? new Array(17).fill(0),
    standard: true
  }
}

function withButton(index: number, value = 1): PadSnapshot {
  const buttons = new Array(17).fill(0)
  buttons[index] = value
  return pad({ buttons })
}

describe('drivenInApp', () => {
  it('leaves a leader driving a real follower to lerobot-teleoperate', () => {
    expect(drivenInApp({ controller: 'leader', robotUid: 'p-1' })).toBe(false)
  })

  it('takes over for the virtual arm and for the two tool controllers', () => {
    expect(drivenInApp({ controller: 'leader', robotUid: VIRTUAL_UID })).toBe(true)
    expect(drivenInApp({ controller: 'keyboard', robotUid: 'p-1' })).toBe(true)
    expect(drivenInApp({ controller: 'gamepad', robotUid: 'p-1' })).toBe(true)
  })
})

describe('keyboard mapping', () => {
  it('is idle with nothing held', () => {
    expect(isIdle(commandFromKeys(keys()))).toBe(true)
    expect(commandFromKeys(keys())).toEqual(IDLE_COMMAND)
  })

  it('drives one axis per binding, in both directions', () => {
    for (const binding of KEYBOARD_BINDINGS) {
      for (const code of binding.positive) {
        expect(commandFromKeys(keys(code))[binding.target], `${code}`).toBe(1)
      }
      for (const code of binding.negative) {
        expect(commandFromKeys(keys(code))[binding.target], `${code}`).toBe(-1)
      }
    }
  })

  /** Both keys held is a mistake, and standing still is the safe reading of it. */
  it('cancels opposing keys out', () => {
    expect(commandFromKeys(keys('KeyW', 'KeyS')).x).toBe(0)
    expect(isIdle(commandFromKeys(keys('KeyW', 'KeyS')))).toBe(true)
  })

  it('treats the arrow keys as aliases of the translation axes', () => {
    expect(commandFromKeys(keys('ArrowUp')).x).toBe(commandFromKeys(keys('KeyW')).x)
    expect(commandFromKeys(keys('ArrowLeft')).y).toBe(commandFromKeys(keys('KeyA')).y)
    expect(commandFromKeys(keys('PageUp')).z).toBe(commandFromKeys(keys('KeyR')).z)
  })

  it('reads the fine modifier without it counting as a command', () => {
    const held = commandFromKeys(keys(FINE_KEYS[0]))
    expect(held.fine).toBe(true)
    expect(isIdle(held)).toBe(true)
  })

  it('reads the home key', () => {
    expect(homeFromKeys(keys(HOME_KEYS[0]))).toBe(true)
    expect(homeFromKeys(keys('KeyW'))).toBe(false)
  })

  /** Anything the controller acts on has to be swallowed, or it also scrolls. */
  it('lists every key it consumes', () => {
    for (const binding of KEYBOARD_BINDINGS) {
      for (const code of [...binding.positive, ...binding.negative]) {
        expect(KEYBOARD_CODES.has(code), code).toBe(true)
      }
    }
    for (const code of [...FINE_KEYS, ...HOME_KEYS]) {
      expect(KEYBOARD_CODES.has(code), code).toBe(true)
    }
    expect(KEYBOARD_CODES.has('KeyZ')).toBe(false)
  })

  it('labels keys for the legend without the code prefix', () => {
    expect(keyLabel('KeyW')).toBe('W')
    expect(keyLabel('Digit0')).toBe('0')
    expect(keyLabel('ArrowUp')).toBe('↑')
    expect(keyLabel('Comma')).toBe(',')
    expect(keyLabel('ShiftLeft')).toBe('Shift')
  })

  it('binds each axis exactly once, so no key drives two things', () => {
    const targets = KEYBOARD_BINDINGS.map((b) => b.target)
    expect(new Set(targets).size).toBe(targets.length)
    expect(targets).toEqual([...EE_AXES, 'gripper'])

    const all = KEYBOARD_BINDINGS.flatMap((b) => [...b.positive, ...b.negative])
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('applyDeadzone', () => {
  it('ignores a stick resting slightly off centre', () => {
    expect(applyDeadzone(0.05)).toBe(0)
    expect(applyDeadzone(-0.05)).toBe(0)
  })

  it('rescales the rest of the travel so it starts from zero', () => {
    expect(applyDeadzone(0.12)).toBe(0)
    expect(applyDeadzone(1)).toBe(1)
    expect(applyDeadzone(-1)).toBe(-1)
    expect(applyDeadzone(0.56)).toBeCloseTo(0.5, 2)
  })

  it('never exceeds full deflection, whatever the device reports', () => {
    expect(applyDeadzone(1.4)).toBe(1)
    expect(applyDeadzone(-1.4)).toBe(-1)
  })
})

describe('gamepad mapping', () => {
  it('is idle with the sticks centred', () => {
    expect(isIdle(commandFromPad(pad()))).toBe(true)
  })

  /** Push away to send the tool away: the API reports stick-up as -1. */
  it('sends the tool forward when the left stick is pushed away', () => {
    expect(commandFromPad(pad({ axes: [0, -1, 0, 0] })).x).toBe(1)
    expect(commandFromPad(pad({ axes: [0, 1, 0, 0] })).x).toBe(-1)
  })

  it('sends the tool left when the left stick goes left', () => {
    expect(commandFromPad(pad({ axes: [-1, 0, 0, 0] })).y).toBe(1)
    expect(commandFromPad(pad({ axes: [1, 0, 0, 0] })).y).toBe(-1)
  })

  it('pitches and yaws from the right stick', () => {
    expect(commandFromPad(pad({ axes: [0, 0, 0, -1] })).ry).toBe(1)
    expect(commandFromPad(pad({ axes: [0, 0, -1, 0] })).rz).toBe(1)
  })

  it('reads the triggers as an analog vertical axis', () => {
    expect(commandFromPad(withButton(7, 0.5)).z).toBeCloseTo(0.47, 2)
    expect(commandFromPad(withButton(6)).z).toBe(-1)
  })

  it('opens and closes the jaws from the bumpers', () => {
    expect(commandFromPad(withButton(5)).gripper).toBe(1)
    expect(commandFromPad(withButton(4)).gripper).toBe(-1)
  })

  it('rolls from the d-pad and reads the fine and home buttons', () => {
    expect(commandFromPad(withButton(15)).rx).toBe(1)
    expect(commandFromPad(withButton(14)).rx).toBe(-1)
    expect(commandFromPad(withButton(0)).fine).toBe(true)
    expect(homeFromPad(withButton(3))).toBe(true)
    expect(homeFromPad(pad())).toBe(false)
  })

  it('reads a short axis or button array as centred rather than throwing', () => {
    expect(isIdle(commandFromPad({ axes: [], buttons: [], standard: false }))).toBe(true)
  })
})

describe('frameScale', () => {
  it('is the speed setting times the frame length', () => {
    expect(frameScale(IDLE_COMMAND, 1, 0.02)).toBeCloseTo(0.02, 9)
    expect(frameScale(IDLE_COMMAND, 2, 0.02)).toBeCloseTo(0.04, 9)
  })

  it('quarters everything while the fine modifier is held', () => {
    expect(frameScale({ ...IDLE_COMMAND, fine: true }, 1, 0.02)).toBeCloseTo(
      0.02 * EE_FINE_SCALE,
      9
    )
  })
})

describe('targetPose', () => {
  const c = chain()
  const rest = IK_JOINTS.map(() => 0)
  const command = (patch: Partial<EeCommand>): EeCommand => ({ ...IDLE_COMMAND, ...patch })

  /** Base-frame translation: forward stays forward however the wrist is turned. */
  it('translates in the base frame at the set speed', () => {
    const dt = 0.02
    const before = translationOf(forwardKinematics(c, rest))
    const after = translationOf(
      targetPose({ chain: c, angles: rest, command: command({ x: 1 }), dt })
    )
    expect(after[0] - before[0]).toBeCloseTo(EE_LINEAR_SPEED * dt, 9)
    expect(after[1] - before[1]).toBeCloseTo(0, 9)
    expect(after[2] - before[2]).toBeCloseTo(0, 9)
  })

  /** Tool-frame rotation: a roll is a roll of the jaws, not of the room. */
  it('rotates in the tool frame at the set speed', () => {
    const dt = 0.02
    const current = forwardKinematics(c, rest)
    const target = targetPose({ chain: c, angles: rest, command: command({ rz: 1 }), dt })
    // The relative rotation between the two is the commanded one, expressed in
    // the tool's own frame.
    const relative = toRotationVector(multiply(transposeRotation(current), target))
    expect(Math.hypot(...relative)).toBeCloseTo(EE_ANGULAR_SPEED * dt, 6)
    expect(relative[2]).toBeCloseTo(EE_ANGULAR_SPEED * dt, 6)
    expect(translationOf(target)).toEqual(
      translationOf(current).map((n) => expect.closeTo(n, 9))
    )
  })

  it('halves the step when the frame is half as long', () => {
    const one = targetPose({ chain: c, angles: rest, command: command({ x: 1 }), dt: 0.02 })
    const half = targetPose({ chain: c, angles: rest, command: command({ x: 1 }), dt: 0.01 })
    const base = translationOf(forwardKinematics(c, rest))[0]
    expect(translationOf(half)[0] - base).toBeCloseTo((translationOf(one)[0] - base) / 2, 9)
  })
})

describe('advanceJoints', () => {
  const c = chain()
  const rest = IK_JOINTS.map(() => 0)

  /** The common case, and re-solving it would let noise walk the arm about. */
  it('does not solve at all for an idle command', () => {
    const step = advanceJoints({ chain: c, angles: rest, command: IDLE_COMMAND, dt: 0.02 })
    expect(step.iterations).toBe(0)
    expect(step.angles).toEqual(rest)
    expect(step.converged).toBe(true)
  })

  it('does not solve for a zero-length frame', () => {
    const step = advanceJoints({
      chain: c,
      angles: rest,
      command: { ...IDLE_COMMAND, x: 1 },
      dt: 0
    })
    expect(step.angles).toEqual(rest)
  })

  it('moves the tool the commanded distance in one frame', () => {
    const dt = 0.02
    const step = advanceJoints({
      chain: c,
      angles: rest,
      command: { ...IDLE_COMMAND, x: 1 },
      dt
    })
    const travelled =
      translationOf(forwardKinematics(c, step.angles))[0] -
      translationOf(forwardKinematics(c, rest))[0]
    expect(travelled).toBeCloseTo(EE_LINEAR_SPEED * dt, 4)
  })

  it('returns a fresh array rather than mutating the angles it was given', () => {
    const angles = [...rest]
    advanceJoints({ chain: c, angles, command: { ...IDLE_COMMAND, x: 1 }, dt: 0.02 })
    expect(angles).toEqual(rest)
  })
})

describe('advanceGripper', () => {
  it('stays put with no command', () => {
    expect(advanceGripper(0.5, IDLE_COMMAND, 0.02)).toBe(0.5)
  })

  it('opens and closes at the set rate', () => {
    expect(advanceGripper(0.5, { ...IDLE_COMMAND, gripper: 1 }, 0.02)).toBeGreaterThan(0.5)
    expect(advanceGripper(0.5, { ...IDLE_COMMAND, gripper: -1 }, 0.02)).toBeLessThan(0.5)
  })

  it('stops at shut and at wide open', () => {
    expect(advanceGripper(0.99, { ...IDLE_COMMAND, gripper: 1 }, 1)).toBe(1)
    expect(advanceGripper(0.01, { ...IDLE_COMMAND, gripper: -1 }, 1)).toBe(0)
  })
})

describe('stepTowards', () => {
  it('walks at the given rate and reports when it has not arrived', () => {
    const angles = [0, 0]
    expect(stepTowards(angles, [1, -1], 0.1, 1)).toBe(false)
    expect(angles).toEqual([0.1, -0.1])
  })

  it('lands exactly on the target rather than overshooting it', () => {
    const angles = [0.95, -0.02]
    expect(stepTowards(angles, [1, 0], 0.1, 1)).toBe(true)
    expect(angles).toEqual([1, 0])
  })

  it('leaves a joint the target says nothing about alone', () => {
    const angles = [0.3, 0.4]
    expect(stepTowards(angles, [0.3], 0.1, HOME_RATE)).toBe(true)
    expect(angles).toEqual([0.3, 0.4])
  })
})

describe('requestedTravel', () => {
  const command = (patch: Partial<EeCommand>): EeCommand => ({ ...IDLE_COMMAND, ...patch })

  it('is the distance a frame of full deflection asks for', () => {
    expect(requestedTravel(command({ x: 1 }), 0.02)).toBeCloseTo(EE_LINEAR_SPEED * 0.02, 9)
  })

  it('combines the three translation axes', () => {
    expect(requestedTravel(command({ x: 1, y: 1 }), 0.02)).toBeCloseTo(
      Math.SQRT2 * EE_LINEAR_SPEED * 0.02,
      9
    )
  })

  /** A rotation command moves the tool's frame, not its position. */
  it('asks for no travel from a pure rotation, or from the jaws', () => {
    expect(requestedTravel(command({ rx: 1, ry: 1, rz: 1 }), 0.02)).toBe(0)
    expect(requestedTravel(command({ gripper: 1 }), 0.02)).toBe(0)
  })

  it('shrinks with the fine modifier and with the speed setting', () => {
    const plain = requestedTravel(command({ x: 1 }), 0.02)
    expect(requestedTravel(command({ x: 1, fine: true }), 0.02)).toBeCloseTo(
      plain * EE_FINE_SCALE,
      9
    )
    expect(requestedTravel(command({ x: 1 }), 0.02, 0.5)).toBeCloseTo(plain / 2, 9)
  })

  /**
   * The stall detector's whole premise: what a frame asks for is comparable to
   * what the arm delivers, so a reachable target passes and a stalled one does
   * not.
   */
  it('is met by a reachable target and not by an out-of-reach one', () => {
    const c = chain()
    const rest = IK_JOINTS.map(() => 0)
    const dt = 0.02
    const forward = command({ x: 1 })

    const asked = requestedTravel(forward, dt)
    const near = advanceJoints({ chain: c, angles: rest, command: forward, dt })
    const moved = travelBetween(c, rest, near.angles)
    expect(moved).toBeGreaterThan(asked * STALL_FRACTION)

    // Reach as far forward as the arm can, then keep asking for more.
    let angles = [...rest]
    for (let frame = 0; frame < 400; frame++) {
      angles = advanceJoints({ chain: c, angles, command: forward, dt }).angles
    }
    const stuck = advanceJoints({ chain: c, angles, command: forward, dt })
    expect(travelBetween(c, angles, stuck.angles)).toBeLessThan(asked * STALL_FRACTION)
  })
})

/** How far the tool moved between two sets of joint angles. */
function travelBetween(c: Chain, from: readonly number[], to: readonly number[]): number {
  const a = translationOf(forwardKinematics(c, from))
  const b = translationOf(forwardKinematics(c, to))
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

/** A transform's rotation, transposed, with the translation dropped. */
function transposeRotation(m: readonly number[]): number[] {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1]
}
