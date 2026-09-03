import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MOTOR_NAMES,
  SO_ARM_MOTORS,
  STS3215_MAX_TICK,
  type ArmModel,
  type MotorNormMode
} from '@shared/devices'
import {
  actionColumnMotors,
  normalizeTicks,
  retarget,
  unnormalizeTicks,
  type TickRange
} from '@shared/normalize'
import {
  SIM_MANIFESTS,
  jointAngleRad,
  jointTuning,
  centrePose,
  ticksForAngle,
  ticksFromPose,
  type SimManifest
} from '@shared/sim'
import {
  VIRTUAL_CENTRE,
  VIRTUAL_ID,
  VIRTUAL_MODEL,
  isVirtual,
  virtualProfile,
  virtualRange
} from '@shared/virtual'
import { describe, expect, it } from 'vitest'

const MODELS: ArmModel[] = ['SO100', 'SO101']

function manifestFor(model: ArmModel): SimManifest {
  return JSON.parse(readFileSync(resolve('assets', SIM_MANIFESTS[model]), 'utf8')) as SimManifest
}

describe('the virtual profile', () => {
  const profile = virtualProfile('/tmp/calibration')

  it('is a follower with a fixed name and model, and no port', () => {
    expect(profile.id).toBe(VIRTUAL_ID)
    expect(profile.model).toBe(VIRTUAL_MODEL)
    expect(profile.role).toBe('robot')
    expect(profile.port).toBe('')
    expect(profile.cameras).toEqual([])
  })

  /** The name becomes a filename, so it has to survive that. */
  it('has a filename-safe name', () => {
    expect(VIRTUAL_ID).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  })

  it('takes its calibration folder from the caller', () => {
    expect(profile.calibrationDir).toBe('/tmp/calibration')
  })

  it('is recognised by uid, and nothing else is', () => {
    expect(isVirtual(profile.uid)).toBe(true)
    expect(isVirtual('p-abc123')).toBe(false)
    expect(isVirtual(null)).toBe(false)
    expect(isVirtual(undefined)).toBe(false)
  })
})

describe.each(MODELS)('virtual %s calibration', (model) => {
  const manifest = manifestFor(model)

  it('has a range for every motor, inside the encoder', () => {
    for (const name of MOTOR_NAMES) {
      const range = virtualRange(model, name)
      expect(range.min, name).toBeGreaterThanOrEqual(0)
      expect(range.max, name).toBeLessThanOrEqual(STS3215_MAX_TICK)
      expect(range.max, name).toBeGreaterThan(range.min)
    }
  })

  /**
   * The point of the table in `@shared/virtual`: a range copied out of a URDF by
   * hand has to still describe that URDF. Read through the same conversion the
   * 3D view uses, the ends of each range must land on the joint's own limits.
   */
  it('reaches exactly the travel the URDF models', () => {
    for (const joint of manifest.joints) {
      if (joint.name === 'wrist_roll') continue // a full turn, with no stops recorded
      if (joint.name === 'gripper') continue // a span, so any range works
      const range = virtualRange(model, joint.name)
      const tuning = jointTuning(model, joint.name)
      const ends = [range.min, range.max].map((position) =>
        jointAngleRad(joint, { position, rangeMin: range.min, rangeMax: range.max }, tuning)
      )
      // `reversed` swaps which end is which, so compare the pair either way
      // round. Two decimals: a half-degree of travel is one encoder tick, and
      // the table stores whole ticks.
      expect(Math.min(...ends), `${joint.name} lower`).toBeCloseTo(joint.lower, 2)
      expect(Math.max(...ends), `${joint.name} upper`).toBeCloseTo(joint.upper, 2)
    }
  })

  it('centres every bounded joint on mid-scale', () => {
    for (const name of MOTOR_NAMES) {
      if (name === 'wrist_roll') continue
      const range = virtualRange(model, name)
      expect((range.min + range.max) / 2, name).toBeCloseTo(VIRTUAL_CENTRE, 0)
    }
  })

  it('records a whole turn for the joint that has no stops', () => {
    expect(virtualRange(model, 'wrist_roll')).toEqual({ min: 0, max: STS3215_MAX_TICK })
  })

  /**
   * Mid-range is what the simulation powers up at, and `centrePose` is what the
   * home command drives to, so the two have to be the same pose.
   */
  it('powers up at the pose the home command aims for', () => {
    const readings = Object.fromEntries(
      MOTOR_NAMES.map((name) => {
        const range = virtualRange(model, name)
        return [
          name,
          {
            position: Math.round((range.min + range.max) / 2),
            rangeMin: range.min,
            rangeMax: range.max
          }
        ]
      })
    )
    const centre = centrePose(manifest, readings)
    for (const joint of manifest.joints) {
      const angle = jointAngleRad(
        joint,
        readings[joint.name],
        jointTuning(model, joint.name)
      )
      expect(angle, joint.name).toBeCloseTo(centre[joint.name], 6)
      // Every joint but the one with a tuning offset also sits at the URDF's
      // own rest angle; `wrist_roll`'s servo zero is a quarter turn from it. Two
      // decimals because an even-length range has no whole tick at its centre.
      const offset = jointTuning(model, joint.name).offset ?? 0
      expect(angle, joint.name).toBeCloseTo(joint.rest + offset, 2)
    }
  })
})

describe('ticksForAngle', () => {
  const manifest = manifestFor('SO101')

  it('is the inverse of jointAngleRad across each joint’s range', () => {
    for (const joint of manifest.joints) {
      const range = virtualRange('SO101', joint.name)
      const tuning = jointTuning('SO101', joint.name)
      for (let step = 0; step <= 10; step++) {
        const position = Math.round(range.min + ((range.max - range.min) * step) / 10)
        const reading = { position, rangeMin: range.min, rangeMax: range.max }
        const angle = jointAngleRad(joint, reading, tuning)
        expect(ticksForAngle(joint, angle, reading, tuning), `${joint.name} @ ${position}`).toBe(
          position
        )
      }
    }
  })

  it('never commands a joint past its calibrated stops', () => {
    const joint = manifest.joints.find((j) => j.name === 'shoulder_lift')!
    const reading = { position: 2048, rangeMin: 1500, rangeMax: 2500 }
    const tuning = jointTuning('SO101', 'shoulder_lift')
    expect(ticksForAngle(joint, joint.upper * 4, reading, tuning)).toBeLessThanOrEqual(2500)
    expect(ticksForAngle(joint, joint.lower * 4, reading, tuning)).toBeGreaterThanOrEqual(1500)
  })

  it('has nothing to say without a usable range', () => {
    const joint = manifest.joints[0]
    expect(ticksForAngle(joint, 0, { position: null, rangeMin: 100, rangeMax: 100 })).toBeNull()
  })
})

describe('ticksFromPose', () => {
  const manifest = manifestFor('SO101')
  const readings = Object.fromEntries(
    MOTOR_NAMES.map((name) => {
      const range = virtualRange('SO101', name)
      return [name, { position: null, rangeMin: range.min, rangeMax: range.max }]
    })
  )

  it('turns the centre pose back into the middle of every range', () => {
    const ticks = ticksFromPose(manifest, centrePose(manifest, readings), readings)
    for (const name of MOTOR_NAMES) {
      const range = virtualRange('SO101', name)
      expect(ticks[name], name).toBe(Math.round((range.min + range.max) / 2))
    }
  })

  it('skips a joint the pose says nothing about', () => {
    expect(ticksFromPose(manifest, { elbow_flex: 0 }, readings)).toEqual({
      elbow_flex: expect.any(Number)
    })
  })
})

/* ------------------------------------------------------------------ *
 * Normalized units                                                    *
 * ------------------------------------------------------------------ */

describe('normalizeTicks', () => {
  const range: TickRange = { min: 1000, max: 3000 }

  /** `(ticks - mid) * 360 / 4095` — MotorsBus._normalize, DEGREES branch. */
  it('measures a body joint in degrees from the middle of its range', () => {
    expect(normalizeTicks('degrees', 2000, range)).toBeCloseTo(0, 9)
    expect(normalizeTicks('degrees', 2000 + 4095 / 4, range)).toBeCloseTo(90, 9)
    expect(normalizeTicks('degrees', 2000 - 4095 / 4, range)).toBeCloseTo(-90, 9)
  })

  /** DEGREES is the one mode LeRobot does not apply `drive_mode` to. */
  it('ignores drive mode in degrees, as LeRobot does', () => {
    expect(normalizeTicks('degrees', 2500, { ...range, driveMode: 1 })).toBeCloseTo(
      normalizeTicks('degrees', 2500, range),
      9
    )
  })

  it('measures the jaws as a percentage of their own travel', () => {
    expect(normalizeTicks('range_0_100', 1000, range)).toBe(0)
    expect(normalizeTicks('range_0_100', 2000, range)).toBe(50)
    expect(normalizeTicks('range_0_100', 3000, range)).toBe(100)
  })

  it('mirrors a percentage when drive mode is set', () => {
    expect(normalizeTicks('range_0_100', 1000, { ...range, driveMode: 1 })).toBe(100)
  })

  it('clamps a percentage to the calibrated range', () => {
    expect(normalizeTicks('range_0_100', 0, range)).toBe(0)
    expect(normalizeTicks('range_0_100', 4095, range)).toBe(100)
  })

  it('spans minus one hundred to one hundred in the symmetric mode', () => {
    expect(normalizeTicks('range_m100_100', 1000, range)).toBe(-100)
    expect(normalizeTicks('range_m100_100', 2000, range)).toBe(0)
    expect(normalizeTicks('range_m100_100', 3000, range)).toBe(100)
  })

  it('refuses a calibration with no travel in it', () => {
    expect(() => normalizeTicks('degrees', 100, { min: 500, max: 500 })).toThrow(/min and max/)
    expect(() => unnormalizeTicks('degrees', 0, { min: 500, max: 500 })).toThrow(/min and max/)
  })
})

describe('unnormalizeTicks', () => {
  const range: TickRange = { min: 1000, max: 3000 }
  const modes: MotorNormMode[] = ['degrees', 'range_0_100', 'range_m100_100']

  it.each(modes)('inverts %s to the tick it came from', (mode) => {
    for (let ticks = 1000; ticks <= 3000; ticks += 137) {
      const back = unnormalizeTicks(mode, normalizeTicks(mode, ticks, range), range)
      // LeRobot truncates rather than rounds, so a tick of slack is expected.
      expect(Math.abs(back - ticks), `${mode} @ ${ticks}`).toBeLessThanOrEqual(1)
    }
  })

  it('truncates towards zero, matching Python’s int()', () => {
    // 50.02 % of a 2000-tick range is 1000.4 above the minimum.
    expect(unnormalizeTicks('range_0_100', 50.02, range)).toBe(2000)
  })
})

describe('retarget', () => {
  /**
   * Teleoperation in one line: the same pose on two arms whose calibrations
   * differ. Mid-range on the leader has to be mid-range on the follower.
   */
  it('maps the middle of one arm’s range onto the middle of another’s', () => {
    const leader: TickRange = { min: 900, max: 3100 }
    const follower: TickRange = { min: 1200, max: 2800 }
    expect(retarget('degrees', 2000, leader, follower)).toBeCloseTo(2000, 0)
    expect(retarget('range_0_100', 2000, leader, follower)).toBeCloseTo(2000, 0)
  })

  it('stretches the jaws’ travel between two different spans', () => {
    const leader: TickRange = { min: 1000, max: 2000 }
    const follower: TickRange = { min: 2000, max: 4000 }
    expect(retarget('range_0_100', 1000, leader, follower)).toBe(2000)
    expect(retarget('range_0_100', 1500, leader, follower)).toBe(3000)
    expect(retarget('range_0_100', 2000, leader, follower)).toBe(4000)
  })

  it('keeps a body joint’s angle rather than its fraction of travel', () => {
    const leader: TickRange = { min: 1000, max: 3000 }
    const follower: TickRange = { min: 1500, max: 2500 }
    // A quarter turn off centre on the leader is a quarter turn off centre on
    // the follower, even though that is most of the follower's shorter range.
    const quarter = 2000 + Math.round(4095 / 4)
    expect(retarget('degrees', quarter, leader, follower)).toBeCloseTo(
      2000 + 4095 / 4,
      0
    )
  })
})

describe('the motor table', () => {
  /** What decides how a recorded action or a leader reading is converted. */
  it('drives the body joints in degrees and the jaws as a percentage', () => {
    for (const spec of SO_ARM_MOTORS) {
      expect(spec.normMode, spec.name).toBe(spec.name === 'gripper' ? 'range_0_100' : 'degrees')
    }
  })
})

describe('actionColumnMotors', () => {
  it('pairs a recorded action’s columns with the motors they drive', () => {
    expect(
      actionColumnMotors(['shoulder_pan.pos', 'shoulder_lift.pos', 'gripper.pos'])
    ).toEqual([
      [0, SO_ARM_MOTORS[0]],
      [1, SO_ARM_MOTORS[1]],
      [2, SO_ARM_MOTORS[5]]
    ])
  })

  /** A bimanual or wheeled recording carries columns this arm has no motor for. */
  it('leaves out a column that is not one of this arm’s motors', () => {
    expect(actionColumnMotors(['x.vel', 'left_shoulder_pan.pos', 'elbow_flex.pos'])).toEqual([
      [2, SO_ARM_MOTORS[2]]
    ])
  })

  it('accepts a bare motor name as well as the .pos suffix', () => {
    expect(actionColumnMotors(['wrist_roll'])).toEqual([[0, SO_ARM_MOTORS[4]]])
  })

  it('has nothing to pair in an empty row', () => {
    expect(actionColumnMotors([])).toEqual([])
  })
})
