import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOTOR_NAMES, STS3215_MAX_TICK } from '@shared/devices'
import type { ArmModel } from '@shared/devices'
import {
  CONTINUOUS_JOINTS,
  JOINT_OFFSETS,
  REVERSED_JOINTS,
  SIM_MANIFESTS,
  SPAN_JOINTS,
  TICKS_PER_TURN,
  applyPositions,
  jointAngleRad,
  jointTuning,
  poseFromReadings,
  type SimJoint,
  type SimManifest
} from '@shared/sim'
import { describe, expect, it } from 'vitest'

const MODELS: ArmModel[] = ['SO100', 'SO101']

function manifestFor(model: ArmModel): SimManifest {
  const path = resolve('assets', SIM_MANIFESTS[model])
  return JSON.parse(readFileSync(path, 'utf8')) as SimManifest
}

/** Node names out of a .glb's JSON chunk, without pulling in a glTF parser. */
function glbNodeNames(model: ArmModel): Set<string> {
  const manifest = manifestFor(model)
  const buffer = readFileSync(resolve('assets', manifest.glb))
  expect(buffer.readUInt32LE(0), 'glTF magic').toBe(0x46546c67)

  let offset = 12
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    if (type === 0x4e4f534a) {
      const json = JSON.parse(buffer.subarray(offset + 8, offset + 8 + length).toString('utf8'))
      return new Set((json.nodes as { name?: string }[]).map((n) => n.name ?? ''))
    }
    offset += 8 + length
  }
  throw new Error(`${manifest.glb} has no JSON chunk`)
}

const BODY: SimJoint = {
  name: 'elbow_flex',
  node: 'joint__elbow_flex',
  axis: [0, 1, 0],
  lower: -1.69,
  upper: 1.69,
  rest: 0
}

/**
 * The conversion has to agree with LeRobot's, or the model and
 * `lerobot-teleoperate` would describe the same arm differently.
 * `MotorsBus._normalize` in DEGREES mode is `(ticks - mid) * 360 / 4095`, and
 * `RobotKinematics.forward_kinematics` feeds exactly that into the URDF.
 */
describe('tick to joint angle', () => {
  it('puts a joint at the middle of its calibrated range at the rest angle', () => {
    const angle = jointAngleRad(BODY, { position: 2000, rangeMin: 1000, rangeMax: 3000 })
    expect(angle).toBeCloseTo(BODY.rest, 10)
  })

  it('turns a tick into 360/4095 degrees of joint', () => {
    const quarter = TICKS_PER_TURN / 4
    const angle = jointAngleRad(BODY, {
      position: 2000 + quarter,
      rangeMin: 1000,
      rangeMax: 3000
    })
    expect((angle * 180) / Math.PI).toBeCloseTo(90, 6)
  })

  it('offsets from the URDF rest angle when the model has a one-sided range', () => {
    // The SO-100's URDF measures from its assembled pose, so mid-travel is not
    // its zero. A reading at the centre must still sit at mid-travel.
    const soUnhinged: SimJoint = { ...BODY, lower: 0, upper: 3.5, rest: 1.75 }
    expect(jointAngleRad(soUnhinged, { position: 2048, rangeMin: 1048, rangeMax: 3048 })).toBeCloseTo(
      1.75,
      10
    )
  })

  it('clamps to the URDF limits rather than folding the model through itself', () => {
    const beyond = jointAngleRad(BODY, { position: 4000, rangeMin: 0, rangeMax: 4095 })
    expect(beyond).toBe(BODY.upper)
    const under = jointAngleRad(BODY, { position: 20, rangeMin: 0, rangeMax: 4095 })
    expect(under).toBe(BODY.lower)
  })

  it('rests when the motor is offline, and when its range is unusable', () => {
    expect(jointAngleRad(BODY, undefined)).toBe(BODY.rest)
    expect(jointAngleRad(BODY, { position: null, rangeMin: 0, rangeMax: 4095 })).toBe(BODY.rest)
    expect(jointAngleRad(BODY, { position: 2000, rangeMin: 3000, rangeMax: 3000 })).toBe(BODY.rest)
  })

  it('falls back to the full encoder span for an uncalibrated motor', () => {
    const uncalibrated = jointAngleRad(BODY, { position: 2000, rangeMin: null, rangeMax: null })
    const explicit = jointAngleRad(BODY, { position: 2000, rangeMin: 0, rangeMax: STS3215_MAX_TICK })
    expect(uncalibrated).toBe(explicit)
  })
})

/**
 * The gripper is the one joint LeRobot does not drive in degrees: it is 0..100 %
 * of its own travel, so its calibrated range is stretched over the jaw's range
 * instead of converted one-to-one.
 */
describe('gripper', () => {
  const jaw: SimJoint = {
    name: 'gripper',
    node: 'joint__gripper',
    axis: [0, 1, 0],
    lower: -0.174533,
    upper: 1.74533,
    rest: 0.785398
  }

  it('is one of the span-mapped joints', () => {
    expect(SPAN_JOINTS).toContain('gripper')
  })

  it('is shut at the bottom of its range and wide at the top', () => {
    expect(jointAngleRad(jaw, { position: 1200, rangeMin: 1200, rangeMax: 2400 })).toBeCloseTo(
      jaw.lower,
      10
    )
    expect(jointAngleRad(jaw, { position: 2400, rangeMin: 1200, rangeMax: 2400 })).toBeCloseTo(
      jaw.upper,
      10
    )
    expect(jointAngleRad(jaw, { position: 1800, rangeMin: 1200, rangeMax: 2400 })).toBeCloseTo(
      (jaw.lower + jaw.upper) / 2,
      10
    )
  })

  it('uses the whole jaw however short the measured travel is', () => {
    // A gripper that only travels 300 ticks still opens fully on screen; the
    // one-to-one conversion would barely move it.
    expect(jointAngleRad(jaw, { position: 1500, rangeMin: 1200, rangeMax: 1500 })).toBeCloseTo(
      jaw.upper,
      10
    )
  })
})

/**
 * Which way a joint turns is a fact about the arm, not about the URDF, so
 * `reversed` can mirror a joint's travel when its encoder counts against the
 * model. The mirror is about the rest pose, the one pose the arm and the model
 * agree on however the joint is wired. No joint currently needs it — see
 * REVERSED_JOINTS — but the mechanism is kept and tested for the next arm that
 * does.
 */
describe('reversed joints', () => {
  it('mirrors a body joint about its rest angle', () => {
    const reading = { position: 2500, rangeMin: 1000, rangeMax: 3000 }
    const forward = jointAngleRad(BODY, reading)
    const backward = jointAngleRad(BODY, reading, { reversed: true })
    expect(backward - BODY.rest).toBeCloseTo(-(forward - BODY.rest), 10)
  })

  it('leaves the rest pose alone, which is what makes it safe to flip', () => {
    const centred = { position: 2000, rangeMin: 1000, rangeMax: 3000 }
    expect(jointAngleRad(BODY, centred, { reversed: true })).toBeCloseTo(BODY.rest, 10)
  })

  it('mirrors a span joint end for end', () => {
    const jaw: SimJoint = { ...BODY, name: 'gripper', lower: -0.2, upper: 1.8, rest: 0.8 }
    const shut = { position: 1200, rangeMin: 1200, rangeMax: 2400 }
    expect(jointAngleRad(jaw, shut)).toBeCloseTo(jaw.lower, 10)
    expect(jointAngleRad(jaw, shut, { reversed: true })).toBeCloseTo(jaw.upper, 10)
  })

  it('reverses no body joint on either model', () => {
    // Driving a real SO-101 showed shoulder_pan mirrored against the model, so
    // the flip it used to carry was removed. The URDF axis direction is already
    // in the kinematic chain and is not repeated as a reversal here.
    expect(jointTuning('SO101', 'shoulder_pan').reversed).toBe(false)
    expect(jointTuning('SO100', 'shoulder_pan').reversed).toBe(false)
    expect(jointTuning('SO101', 'elbow_flex').reversed).toBe(false)
  })

  it('only ever names joints the models actually have', () => {
    const named = [
      ...Object.entries(REVERSED_JOINTS),
      ...Object.entries(CONTINUOUS_JOINTS),
      ...Object.entries(JOINT_OFFSETS).map(([model, offsets]) => [model, Object.keys(offsets)] as const)
    ]
    for (const [model, joints] of named) {
      for (const joint of joints) expect(MOTOR_NAMES, model).toContain(joint)
    }
  })

  it('reads the SO-101 shoulder straight through, without a mirror', () => {
    const manifest = manifestFor('SO101')
    const readings = { shoulder_pan: { position: 2600, rangeMin: 700, rangeMax: 3400 } }
    const pan = manifest.joints.find((j) => j.name === 'shoulder_pan')!
    expect(poseFromReadings(manifest, readings).shoulder_pan).toBeCloseTo(
      jointAngleRad(pan, readings.shoulder_pan),
      10
    )
  })
})

/**
 * `wrist_roll` is the one joint LeRobot never measures: `so_follower.calibrate`
 * names it `full_turn_motor` and writes 0..4095 for it, so its zero is wherever
 * the wrist was held during calibration rather than the URDF's zero. On a real
 * SO-101 that came out a quarter turn off, and the URDF's end stops — which are
 * about cable length, not encoder counts — must not clamp a joint that spins.
 */
describe('wrist roll', () => {
  const roll: SimJoint = {
    name: 'wrist_roll',
    node: 'joint__wrist_roll',
    axis: [0, 1, 0],
    lower: -2.74385,
    upper: 2.84121,
    rest: 0
  }

  it('is a quarter turn out on the SO-101, and turns freely on both models', () => {
    expect(jointTuning('SO101', 'wrist_roll').offset).toBeCloseTo(Math.PI / 2, 10)
    expect(jointTuning('SO101', 'wrist_roll').continuous).toBe(true)
    expect(jointTuning('SO100', 'wrist_roll').continuous).toBe(true)
  })

  it('shifts the whole travel by the offset, including the rest pose', () => {
    const centred = { position: 2048, rangeMin: 0, rangeMax: STS3215_MAX_TICK }
    const plain = jointAngleRad(roll, centred)
    const shifted = jointAngleRad(roll, centred, { offset: Math.PI / 2 })
    expect(shifted - plain).toBeCloseTo(Math.PI / 2, 10)
  })

  it('keeps turning past the URDF limits instead of sticking', () => {
    // Nearly a full turn from centre: with the offset added this lands outside
    // the modelled range, which is exactly where clamping used to freeze it.
    const spun = { position: 4000, rangeMin: 0, rangeMax: STS3215_MAX_TICK }
    const clamped = jointAngleRad(roll, spun, { offset: Math.PI / 2 })
    const free = jointAngleRad(roll, spun, { offset: Math.PI / 2, continuous: true })
    expect(clamped).toBe(roll.upper)
    expect(free).toBeGreaterThan(roll.upper)
  })

  it('is posed with both the offset and the free turn, from the manifest', () => {
    const manifest = manifestFor('SO101')
    const readings = { wrist_roll: { position: 3400, rangeMin: 0, rangeMax: STS3215_MAX_TICK } }
    const joint = manifest.joints.find((j) => j.name === 'wrist_roll')!
    const posed = poseFromReadings(manifest, readings).wrist_roll
    expect(posed).toBeCloseTo(
      jointAngleRad(joint, readings.wrist_roll, { offset: Math.PI / 2, continuous: true }),
      10
    )
    expect(posed).toBeGreaterThan(joint.upper)
  })
})

describe('pose assembly', () => {
  it('gives every joint in the manifest an angle', () => {
    const manifest = manifestFor('SO101')
    const pose = poseFromReadings(manifest, {})
    expect(Object.keys(pose).sort()).toEqual(manifest.joints.map((j) => j.name).sort())
  })

  it('keeps calibrated ranges when a stream frame overwrites positions', () => {
    const before = { elbow_flex: { position: 100, rangeMin: 900, rangeMax: 3100 } }
    const after = applyPositions(before, { elbow_flex: 2000, wrist_roll: 2048 })
    expect(after.elbow_flex).toEqual({ position: 2000, rangeMin: 900, rangeMax: 3100 })
    // A motor the snapshot never described still gets its ticks through.
    expect(after.wrist_roll).toEqual({ position: 2048, rangeMin: null, rangeMax: null })
    expect(before.elbow_flex.position, 'input untouched').toBe(100)
  })
})

/**
 * The scenes are built offline by `tools/blender/build_sim_scene.py` and
 * committed. These guard the seam between that build and the viewer: a rename
 * or a dropped joint would otherwise only show up as an arm that does not move.
 */
describe.each(MODELS)('%s scene', (model) => {
  const manifest = manifestFor(model)

  it('names a joint for every motor the arm has', () => {
    expect(manifest.joints.map((j) => j.name).sort()).toEqual([...MOTOR_NAMES].sort())
  })

  it('points every joint at a node that is really in the glb', () => {
    const nodes = glbNodeNames(model)
    for (const joint of manifest.joints) expect(nodes, joint.name).toContain(joint.node)
    expect(nodes).toContain(manifest.rootNode)
    expect(nodes).toContain(manifest.groundNode)
  })

  it('gives every joint a unit rotation axis and a usable range', () => {
    for (const joint of manifest.joints) {
      const length = Math.hypot(...joint.axis)
      expect(length, joint.name).toBeCloseTo(1, 6)
      expect(joint.upper, joint.name).toBeGreaterThan(joint.lower)
      expect(joint.rest, joint.name).toBeGreaterThanOrEqual(joint.lower)
      expect(joint.rest, joint.name).toBeLessThanOrEqual(joint.upper)
    }
  })

  it('describes a lit scene the viewer can build without guessing', () => {
    expect(manifest.model).toBe(model)
    expect(manifest.triangles).toBeGreaterThan(0)
    expect(manifest.lighting.ambient.intensity).toBeGreaterThan(0)
    expect(manifest.lighting.key.direction).toHaveLength(3)
    expect(manifest.camera.fov).toBeGreaterThan(0)
    expect(manifest.ground.light).toMatch(/^#[0-9a-f]{6}$/i)
    expect(manifest.ground.dark).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
