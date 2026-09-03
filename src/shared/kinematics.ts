/**
 * Forward and inverse kinematics for the SO arms.
 *
 * Written from scratch rather than borrowed: LeRobot's own `RobotKinematics`
 * needs `placo`, a compiled solver that is not part of any lerobot extra the app
 * installs, so an install that can teleoperate could still not solve IK. This is
 * a few hundred lines of pure arithmetic over the same URDF, with no
 * dependencies, which also means it runs in the renderer at frame rate and is
 * testable in node.
 *
 * Conventions throughout:
 *   - Matrices are row-major 4x4, 16 numbers, as `Mat4`.
 *   - Lengths are metres, angles radians — the URDF's own units.
 *   - A pose is the tool frame expressed in the arm's base frame.
 *
 * The arm has five actuated joints below the gripper, so a full six-degree pose
 * is not generally reachable. `solveIk` is therefore a damped least-squares
 * solver with separate position and orientation weights: given an impossible
 * target it returns the best compromise and reports how far off it is, rather
 * than failing.
 */

import type { UrdfJoint, Vec3 } from './urdf'
import { jointPath, rootLink, toolLink } from './urdf'

/** Row-major 4x4 transform. */
export type Mat4 = readonly number[]

export interface ChainJoint {
  name: string
  /** Fixed transform from the previous joint's frame into this joint's. */
  origin: Mat4
  /** Unit rotation axis, in this joint's own frame. */
  axis: Vec3
  lower: number
  upper: number
}

export interface Chain {
  /** Actuated joints, base outwards. */
  joints: ChainJoint[]
  /** Fixed transform from the last joint's frame into the tool frame. */
  tool: Mat4
}

export interface Pose {
  position: Vec3
  /** Orientation as a rotation vector: axis * angle, in the base frame. */
  rotation: Vec3
}

/* ------------------------------------------------------------------ *
 * Matrix and vector arithmetic                                        *
 * ------------------------------------------------------------------ */

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        a[row * 4] * b[col] +
        a[row * 4 + 1] * b[4 + col] +
        a[row * 4 + 2] * b[8 + col] +
        a[row * 4 + 3] * b[12 + col]
    }
  }
  return out
}

export function translationOf(m: Mat4): Vec3 {
  return [m[3], m[7], m[11]]
}

/**
 * URDF's `rpy` is a fixed-axis roll-pitch-yaw, i.e. Rz(yaw) Ry(pitch) Rx(roll).
 */
export function fromOrigin(xyz: Vec3, rpy: Vec3): Mat4 {
  const [r, p, y] = rpy
  const [cr, sr] = [Math.cos(r), Math.sin(r)]
  const [cp, sp] = [Math.cos(p), Math.sin(p)]
  const [cy, sy] = [Math.cos(y), Math.sin(y)]
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, xyz[0],
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, xyz[1],
    -sp, cp * sr, cp * cr, xyz[2],
    0, 0, 0, 1
  ]
}

/** Rotation of `angle` about a unit `axis`, as a 4x4 with no translation. */
export function fromAxisAngle(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = normalize(axis)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1
  ]
}

/** A rotation vector (axis * angle) as a rotation matrix — the exponential map. */
export function fromRotationVector(v: Vec3): Mat4 {
  const angle = Math.hypot(v[0], v[1], v[2])
  if (angle < 1e-12) return IDENTITY
  return fromAxisAngle([v[0] / angle, v[1] / angle, v[2] / angle], angle)
}

/**
 * A rotation matrix as a rotation vector — the logarithmic map.
 *
 * The half-turn case is taken from the diagonal rather than from the
 * off-diagonal difference, which vanishes there.
 */
export function toRotationVector(m: Mat4): Vec3 {
  const trace = m[0] + m[5] + m[10]
  const cos = Math.min(1, Math.max(-1, (trace - 1) / 2))
  const angle = Math.acos(cos)
  if (angle < 1e-9) return [0, 0, 0]
  if (Math.PI - angle < 1e-6) {
    // Near pi: pick the largest diagonal to keep the square root well away from 0.
    const diag: Vec3 = [m[0], m[5], m[10]]
    const largest = diag[0] > diag[1] ? (diag[0] > diag[2] ? 0 : 2) : diag[1] > diag[2] ? 1 : 2
    const axis: Vec3 = [0, 0, 0]
    axis[largest] = Math.sqrt(Math.max(0, (diag[largest] + 1) / 2))
    const other = [(largest + 1) % 3, (largest + 2) % 3]
    // R = I + sin(a) K + (1 - cos(a)) K^2, so the symmetric part gives the axis.
    const sym = (i: number, j: number): number => (m[i * 4 + j] + m[j * 4 + i]) / 2
    for (const k of other) axis[k] = axis[largest] === 0 ? 0 : sym(largest, k) / (2 * axis[largest])
    const scaled = normalize(axis)
    return [scaled[0] * angle, scaled[1] * angle, scaled[2] * angle]
  }
  const scale = angle / (2 * Math.sin(angle))
  return [(m[9] - m[6]) * scale, (m[2] - m[8]) * scale, (m[4] - m[1]) * scale]
}

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  if (length < 1e-12) return [0, 0, 0]
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Rotate a direction by a transform's rotation, ignoring its translation. */
function rotate(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2]
  ]
}

export function poseOf(m: Mat4): Pose {
  return { position: translationOf(m), rotation: toRotationVector(m) }
}

export function matrixOf(pose: Pose): Mat4 {
  const r = fromRotationVector(pose.rotation)
  return [
    r[0], r[1], r[2], pose.position[0],
    r[4], r[5], r[6], pose.position[1],
    r[8], r[9], r[10], pose.position[2],
    0, 0, 0, 1
  ]
}

/* ------------------------------------------------------------------ *
 * Building a chain from a URDF                                        *
 * ------------------------------------------------------------------ */

/** A `continuous` URDF joint records no limit; keep IK inside one turn. */
const CONTINUOUS_LIMIT = Math.PI

/**
 * The chain through `order`, base outwards.
 *
 * Fixed joints sitting between two actuated ones are folded into the next
 * actuated joint's origin, so the returned chain has exactly one entry per
 * actuated joint however the URDF chose to break the geometry up.
 *
 * `base` is folded in ahead of the first joint, for a URDF whose root frame is
 * not the one commands should be given in — see `BASE_YAW` in `@shared/sim`.
 */
export function buildChain(
  joints: readonly UrdfJoint[],
  order: readonly string[],
  base: Mat4 = IDENTITY
): Chain {
  const root = rootLink(joints)
  if (!root) throw new Error('This URDF has no root link.')

  const byName = new Map(joints.map((j) => [j.name, j]))
  const chain: ChainJoint[] = []
  let link = root
  let pending: Mat4 = base

  for (const name of order) {
    const joint = byName.get(name)
    if (!joint) throw new Error(`This URDF has no joint named '${name}'.`)
    const lead = jointPath(joints, link, joint.parent)
    if (lead === null) {
      throw new Error(`No path from '${link}' to '${joint.parent}' in this URDF.`)
    }
    if (lead.some((j) => j.type !== 'fixed')) {
      throw new Error(`Unexpected moving joint between '${link}' and '${joint.name}'.`)
    }
    // The base correction only applies once, ahead of the first joint.
    let origin: Mat4 = pending
    pending = IDENTITY
    for (const step of [...lead, joint]) {
      origin = multiply(origin, fromOrigin(step.origin.xyz, step.origin.rpy))
    }
    chain.push({
      name: joint.name,
      origin,
      axis: normalize(joint.axis),
      lower: joint.limit?.lower ?? -CONTINUOUS_LIMIT,
      upper: joint.limit?.upper ?? CONTINUOUS_LIMIT
    })
    link = joint.child
  }

  const tip = toolLink(joints, link)
  const lead = jointPath(joints, link, tip) ?? []
  let tool: Mat4 = IDENTITY
  for (const step of lead) tool = multiply(tool, fromOrigin(step.origin.xyz, step.origin.rpy))

  return { joints: chain, tool }
}

/* ------------------------------------------------------------------ *
 * Forward kinematics                                                  *
 * ------------------------------------------------------------------ */

/**
 * Each joint's frame in the base frame, plus the tool frame last.
 *
 * Returns `joints.length + 1` transforms: the Jacobian needs every joint's
 * origin and axis in the base frame, and they all come out of this one walk.
 */
export function chainFrames(chain: Chain, angles: readonly number[]): Mat4[] {
  const frames: Mat4[] = []
  let current: Mat4 = IDENTITY
  for (let i = 0; i < chain.joints.length; i++) {
    const joint = chain.joints[i]
    current = multiply(current, joint.origin)
    frames.push(current)
    current = multiply(current, fromAxisAngle(joint.axis, angles[i] ?? 0))
  }
  frames.push(multiply(current, chain.tool))
  return frames
}

/** Tool pose in the base frame, for a set of joint angles. */
export function forwardKinematics(chain: Chain, angles: readonly number[]): Mat4 {
  const frames = chainFrames(chain, angles)
  return frames[frames.length - 1]
}

/**
 * Geometric Jacobian, 6 rows by one column per joint.
 *
 * Rows 0-2 are how the tool's position moves, rows 3-5 how its orientation
 * turns, both in the base frame and both per radian of that joint.
 */
export function jacobian(chain: Chain, angles: readonly number[]): number[][] {
  const frames = chainFrames(chain, angles)
  const tip = translationOf(frames[frames.length - 1])
  const rows: number[][] = [[], [], [], [], [], []]

  for (let i = 0; i < chain.joints.length; i++) {
    const frame = frames[i]
    const axis = rotate(frame, chain.joints[i].axis)
    const origin = translationOf(frame)
    const arm: Vec3 = [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]]
    const linear = cross(axis, arm)
    for (let r = 0; r < 3; r++) rows[r].push(linear[r])
    for (let r = 0; r < 3; r++) rows[3 + r].push(axis[r])
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * Inverse kinematics                                                  *
 * ------------------------------------------------------------------ */

export interface IkOptions {
  maxIterations?: number
  /**
   * What a radian of orientation error is worth, as the position error it
   * trades against, in metres.
   *
   * This is the one number that decides what the arm gives up when a target is
   * out of reach, and something has to: five joints cannot generally hold an
   * orientation *and* hit a position, so a pure translation command will pull
   * the wrist off the angle it was holding. The default says a radian of
   * orientation is worth two centimetres of position, which keeps position
   * tracking well under a millimetre — what a translation key is asking for —
   * while still turning the wrist when a rotation key asks it to.
   */
  orientationScale?: number
  /** Damping, which trades exactness for stability near a singularity. */
  damping?: number
  /** Ceiling on one iteration's joint movement, in radians. */
  maxStep?: number
  positionTolerance?: number
  orientationTolerance?: number
}

export interface IkSolution {
  angles: number[]
  /** Distance from the solved tool position to the target, in metres. */
  positionError: number
  /** Angle between the solved tool orientation and the target, in radians. */
  orientationError: number
  iterations: number
  /** Both errors are inside tolerance — the pose was actually reachable. */
  converged: boolean
  /** Joints the solution had to hold at one of their end stops. */
  clamped: string[]
}

const IK_DEFAULTS: Required<IkOptions> = {
  maxIterations: 40,
  orientationScale: 0.02,
  damping: 0.005,
  maxStep: 0.25,
  positionTolerance: 0.0002,
  orientationTolerance: 0.004
}

/**
 * Joint angles that put the tool as close to `target` as the arm can manage.
 *
 * Damped least squares, seeded from where the arm is now: every iteration solves
 * `(J' W J + k^2 I) dq = J' W e` for a joint step, which is the normal-equations
 * form of the damped pseudo-inverse and only ever a 5x5 system. Seeding from the
 * current pose is what makes it usable for teleoperation — consecutive frames
 * ask for a target a millimetre away, so it converges in two or three
 * iterations and never jumps to a different arm configuration between frames.
 */
export function solveIk(
  chain: Chain,
  target: Mat4,
  seed: readonly number[],
  options: IkOptions = {}
): IkSolution {
  const opts = { ...IK_DEFAULTS, ...options }
  const n = chain.joints.length
  const angles = chain.joints.map((joint, i) => clamp(seed[i] ?? 0, joint.lower, joint.upper))
  const targetPosition = translationOf(target)

  let positionError = Infinity
  let orientationError = Infinity
  let iterations = 0

  for (; iterations < opts.maxIterations; iterations++) {
    const current = forwardKinematics(chain, angles)
    const position = translationOf(current)
    // Orientation error as a rotation in the base frame: target * current^-1,
    // which for a rotation is target * current-transposed.
    const twist = toRotationVector(multiply(target, transposeRotation(current)))
    const error = [
      targetPosition[0] - position[0],
      targetPosition[1] - position[1],
      targetPosition[2] - position[2],
      twist[0],
      twist[1],
      twist[2]
    ]
    positionError = Math.hypot(error[0], error[1], error[2])
    orientationError = Math.hypot(error[3], error[4], error[5])
    if (
      positionError <= opts.positionTolerance &&
      orientationError <= opts.orientationTolerance
    ) {
      break
    }

    const j = jacobian(chain, angles)
    // Position rows count in metres and orientation rows in radians, so the
    // orientation ones are weighted by the square of their exchange rate —
    // squared because these are the weights on a sum of squared residuals.
    const turn = opts.orientationScale * opts.orientationScale
    const weights = [1, 1, 1, turn, turn, turn]

    // Normal equations, n by n. Weights are applied once, to the rows.
    const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const b = new Array<number>(n).fill(0)
    for (let row = 0; row < 6; row++) {
      const w = weights[row]
      for (let p = 0; p < n; p++) {
        b[p] += w * j[row][p] * error[row]
        for (let q = p; q < n; q++) a[p][q] += w * j[row][p] * j[row][q]
      }
    }
    for (let p = 0; p < n; p++) {
      a[p][p] += opts.damping * opts.damping
      for (let q = 0; q < p; q++) a[p][q] = a[q][p]
    }

    const step = solveLinear(a, b)
    if (!step) break

    // Scale the whole step rather than clipping each joint, so a long step keeps
    // its direction and the arm moves along the line it was asked to.
    const longest = step.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    const scale = longest > opts.maxStep ? opts.maxStep / longest : 1
    let moved = 0
    for (let p = 0; p < n; p++) {
      const before = angles[p]
      angles[p] = clamp(before + step[p] * scale, chain.joints[p].lower, chain.joints[p].upper)
      moved = Math.max(moved, Math.abs(angles[p] - before))
    }
    // Every joint is against a stop, or the step was numerically nothing: more
    // iterations cannot improve on this.
    if (moved < 1e-9) break
  }

  return {
    angles,
    positionError,
    orientationError,
    iterations,
    converged:
      positionError <= opts.positionTolerance && orientationError <= opts.orientationTolerance,
    clamped: chain.joints
      .filter((joint, i) => angles[i] <= joint.lower + 1e-6 || angles[i] >= joint.upper - 1e-6)
      .map((joint) => joint.name)
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Transpose of a transform's rotation, with the translation dropped. */
function transposeRotation(m: Mat4): Mat4 {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1]
}

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * Null when the matrix is singular to working precision, which the caller reads
 * as "no step available" rather than as an error — damping normally prevents it,
 * but a chain folded exactly onto itself can still get there.
 */
export function solveLinear(matrix: readonly number[][], vector: readonly number[]): number[] | null {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]]

    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col]
      if (factor === 0) continue
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k]
    }
  }

  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n]
    for (let col = row + 1; col < n; col++) sum -= a[row][col] * x[col]
    x[row] = sum / a[row][row]
  }
  return x.every(Number.isFinite) ? x : null
}
