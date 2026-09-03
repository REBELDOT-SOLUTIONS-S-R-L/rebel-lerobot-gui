import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOTOR_NAMES, type ArmModel } from '@shared/devices'
import {
  IDENTITY,
  buildChain,
  chainFrames,
  forwardKinematics,
  fromAxisAngle,
  fromOrigin,
  fromRotationVector,
  jacobian,
  matrixOf,
  multiply,
  poseOf,
  solveIk,
  solveLinear,
  toRotationVector,
  translationOf,
  type Chain,
  type Mat4
} from '@shared/kinematics'
import { BASE_YAW, SIM_MANIFESTS, type SimManifest } from '@shared/sim'
import { parseUrdfJoints } from '@shared/urdf'
import { describe, expect, it } from 'vitest'

const MODELS: ArmModel[] = ['SO100', 'SO101']

/** Every motor but the jaws: the gripper is not on the chain to the tool. */
const IK_JOINTS = MOTOR_NAMES.filter((name) => name !== 'gripper')

function manifestFor(model: ArmModel): SimManifest {
  return JSON.parse(readFileSync(resolve('assets', SIM_MANIFESTS[model]), 'utf8')) as SimManifest
}

/** The chain the app builds, base correction and all. */
function chainFor(model: ArmModel): Chain {
  const manifest = manifestFor(model)
  const joints = parseUrdfJoints(readFileSync(resolve(manifest.urdf), 'utf8'))
  return buildChain(joints, IK_JOINTS, fromAxisAngle([0, 0, 1], BASE_YAW[model]))
}

/** Every joint at the middle of its travel — what a calibrated arm reads at rest. */
function restAngles(model: ArmModel): number[] {
  const manifest = manifestFor(model)
  return IK_JOINTS.map((name) => manifest.joints.find((j) => j.name === name)?.rest ?? 0)
}

/** Translate a pose without touching its rotation. */
function shifted(pose: Mat4, by: [number, number, number]): Mat4 {
  const out = [...pose]
  out[3] += by[0]
  out[7] += by[1]
  out[11] += by[2]
  return out
}

describe('transforms', () => {
  it('composes a URDF origin as Rz(yaw) Ry(pitch) Rx(roll) plus a translation', () => {
    const m = fromOrigin([1, 2, 3], [0, 0, Math.PI / 2])
    // A quarter turn about Z sends +X to +Y.
    expect(multiply(m, matrixOf({ position: [1, 0, 0], rotation: [0, 0, 0] }))[3]).toBeCloseTo(1, 9)
    expect(translationOf(m)).toEqual([1, 2, 3])
  })

  it('round-trips a rotation through its vector form', () => {
    for (const v of [
      [0, 0, 0],
      [0.1, -0.2, 0.3],
      [Math.PI / 2, 0, 0],
      [0, 0, -2.5]
    ] as [number, number, number][]) {
      expect(toRotationVector(fromRotationVector(v))).toEqual(
        v.map((n) => expect.closeTo(n, 9))
      )
    }
  })

  /** The half-turn case is where the off-diagonal difference vanishes. */
  it('round-trips a half turn, where the usual formula degenerates', () => {
    for (const axis of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.6, 0.8, 0]
    ] as [number, number, number][]) {
      const v = axis.map((n) => n * Math.PI) as [number, number, number]
      const back = toRotationVector(fromRotationVector(v))
      // Pi and minus pi about an axis are the same rotation, so compare either way.
      const same = back.every((n, i) => Math.abs(n - v[i]) < 1e-4)
      const flipped = back.every((n, i) => Math.abs(n + v[i]) < 1e-4)
      expect(same || flipped, `axis ${axis.join(',')} -> ${back.join(',')}`).toBe(true)
    }
  })

  it('multiplies by the identity without changing anything', () => {
    const m = fromOrigin([0.1, 0.2, 0.3], [0.4, 0.5, 0.6])
    expect(multiply(m, IDENTITY)).toEqual(m.map((n) => expect.closeTo(n, 12)))
    expect(multiply(IDENTITY, m)).toEqual(m.map((n) => expect.closeTo(n, 12)))
  })
})

describe('solveLinear', () => {
  it('solves a well-conditioned system', () => {
    const x = solveLinear(
      [
        [2, 1, -1],
        [-3, -1, 2],
        [-2, 1, 2]
      ],
      [8, -11, -3]
    )
    expect(x).toEqual([2, 3, -1].map((n) => expect.closeTo(n, 9)))
  })

  it('returns null rather than infinities for a singular one', () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4]
        ],
        [3, 6]
      )
    ).toBeNull()
  })
})

describe.each(MODELS)('%s chain', (model) => {
  const chain = chainFor(model)
  const rest = restAngles(model)

  it('has one entry per actuated joint, in order', () => {
    expect(chain.joints.map((j) => j.name)).toEqual(IK_JOINTS)
  })

  /**
   * The whole reason `BASE_YAW` exists: a key labelled "forward" has to send the
   * tool forward on both arms, and the two URDFs disagree about which way that is
   * from their own root frame.
   */
  it('faces +X and stands on +Z at rest', () => {
    const tip = translationOf(forwardKinematics(chain, rest))
    expect(tip[0], 'reach along +X').toBeGreaterThan(0.15)
    expect(Math.abs(tip[1]), 'nothing sideways').toBeLessThan(0.01)
    expect(tip[2], 'above the base').toBeGreaterThan(0.1)
  })

  it('reports a frame per joint plus the tool', () => {
    expect(chainFrames(chain, rest)).toHaveLength(chain.joints.length + 1)
  })

  /**
   * The Jacobian has to be the derivative of the forward kinematics, or every
   * solver step points somewhere other than where it claims.
   */
  it('has a Jacobian matching a numerical derivative of the pose', () => {
    const j = jacobian(chain, rest)
    const h = 1e-6
    for (let column = 0; column < chain.joints.length; column++) {
      const nudged = [...rest]
      nudged[column] += h
      const before = forwardKinematics(chain, rest)
      const after = forwardKinematics(chain, nudged)

      const dp = translationOf(after).map((v, i) => (v - translationOf(before)[i]) / h)
      for (let row = 0; row < 3; row++) {
        expect(j[row][column], `linear row ${row}, joint ${chain.joints[column].name}`).toBeCloseTo(
          dp[row],
          4
        )
      }

      // The angular rows are the joint's axis in the base frame, which the
      // relative rotation between the two poses recovers.
      const spin = toRotationVector(
        multiply(after, [
          before[0], before[4], before[8], 0,
          before[1], before[5], before[9], 0,
          before[2], before[6], before[10], 0,
          0, 0, 0, 1
        ])
      ).map((v) => v / h)
      for (let row = 0; row < 3; row++) {
        expect(j[3 + row][column], `angular row ${row}`).toBeCloseTo(spin[row], 4)
      }
    }
  })

  it('keeps every joint inside its limits', () => {
    const target = shifted(forwardKinematics(chain, rest), [0.4, 0.4, 0.4])
    const solution = solveIk(chain, target, rest)
    for (const [index, joint] of chain.joints.entries()) {
      expect(solution.angles[index]).toBeGreaterThanOrEqual(joint.lower - 1e-9)
      expect(solution.angles[index]).toBeLessThanOrEqual(joint.upper + 1e-9)
    }
  })

  it('reaches a nearby position to well under a millimetre', () => {
    for (const by of [
      [0.01, 0, 0],
      [0.03, 0.02, -0.01],
      [-0.05, 0.05, 0.02]
    ] as [number, number, number][]) {
      const solution = solveIk(chain, shifted(forwardKinematics(chain, rest), by), rest)
      expect(solution.positionError, `moving ${by.join(',')}`).toBeLessThan(0.001)
    }
  })

  /**
   * How the loop actually runs: a target a fraction of a millimetre away every
   * frame, relatched from the pose last reached. It has to converge in one or
   * two iterations and travel the distance asked for, or the arm would either
   * stutter or drift.
   */
  it('tracks a held translation key frame by frame', () => {
    let angles = [...rest]
    let worstIterations = 0
    const start = translationOf(forwardKinematics(chain, angles))

    for (let frame = 0; frame < 60; frame++) {
      const solution = solveIk(chain, shifted(forwardKinematics(chain, angles), [0.001, 0, 0]), angles)
      angles = solution.angles
      worstIterations = Math.max(worstIterations, solution.iterations)
    }

    const end = translationOf(forwardKinematics(chain, angles))
    expect(end[0] - start[0], 'travelled ~60 mm').toBeCloseTo(0.06, 2)
    expect(Math.hypot(end[1] - start[1], end[2] - start[2]), 'off-axis drift').toBeLessThan(0.002)
    expect(worstIterations).toBeLessThanOrEqual(3)
  })

  it('tracks a held rotation key without walking the tool away', () => {
    let angles = [...rest]
    const start = poseOf(forwardKinematics(chain, angles))
    const step = fromRotationVector([0, 0, (0.5 * Math.PI) / 180])

    for (let frame = 0; frame < 60; frame++) {
      const target = multiply(forwardKinematics(chain, angles), step)
      angles = solveIk(chain, target, angles).angles
    }

    const end = poseOf(forwardKinematics(chain, angles))
    const moved = Math.hypot(...end.position.map((v, i) => v - start.position[i]))
    const turned = Math.hypot(...end.rotation.map((v, i) => v - start.rotation[i]))
    expect(moved, 'position held').toBeLessThan(0.005)
    expect(turned, 'orientation turned').toBeGreaterThan(0.2)
  })

  /**
   * Five joints cannot hold an orientation and hit an arbitrary position, so an
   * unreachable target must come back as a best effort with the shortfall
   * reported — never as a throw or a NaN.
   */
  it('reports how far short it fell on an unreachable target', () => {
    const solution = solveIk(chain, shifted(forwardKinematics(chain, rest), [2, 0, 0]), rest)
    expect(solution.converged).toBe(false)
    expect(solution.positionError).toBeGreaterThan(0.5)
    expect(solution.angles.every(Number.isFinite)).toBe(true)
  })

  /**
   * Straight backwards is further round than the shoulder can pan, so the
   * shortfall is a joint against a stop rather than an arm not long enough —
   * which is the case the panel warns about.
   */
  it('names the joints it had to hold against a stop', () => {
    const tip = translationOf(forwardKinematics(chain, rest))
    // Offset sideways as well: straight back is exactly symmetric about the pan
    // axis, so the solver would have no direction to turn in.
    const behind = shifted(forwardKinematics(chain, rest), [-2 * tip[0], 0.1, 0])
    const solution = solveIk(chain, behind, rest)
    expect(solution.clamped).toContain('shoulder_pan')
    const panned = solution.angles[chain.joints.findIndex((j) => j.name === 'shoulder_pan')]
    expect(Math.abs(panned)).toBeCloseTo(
      Math.max(Math.abs(chain.joints[0].lower), Math.abs(chain.joints[0].upper)),
      3
    )
  })

  it('leaves the arm alone when the target is where it already is', () => {
    const solution = solveIk(chain, forwardKinematics(chain, rest), rest)
    expect(solution.converged).toBe(true)
    expect(solution.angles).toEqual(rest.map((n) => expect.closeTo(n, 6)))
  })
})

describe('buildChain', () => {
  const joints = parseUrdfJoints(readFileSync(resolve(manifestFor('SO101').urdf), 'utf8'))

  it('refuses a joint the URDF does not have', () => {
    expect(() => buildChain(joints, ['shoulder_pan', 'no_such_joint'])).toThrow(/no joint named/)
  })

  it('folds the base correction in ahead of the first joint only', () => {
    const plain = buildChain(joints, IK_JOINTS)
    const turned = buildChain(joints, IK_JOINTS, fromAxisAngle([0, 0, 1], Math.PI / 2))
    const rest = restAngles('SO101')
    const before = translationOf(forwardKinematics(plain, rest))
    const after = translationOf(forwardKinematics(turned, rest))
    // A quarter turn about Z sends (x, y) to (-y, x).
    expect(after[0]).toBeCloseTo(-before[1], 9)
    expect(after[1]).toBeCloseTo(before[0], 9)
    expect(after[2]).toBeCloseTo(before[2], 9)
  })
})
