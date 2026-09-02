/**
 * Just enough URDF to build a kinematic chain.
 *
 * The app already ships the arms' URDFs in `assets/simulation` — they are what
 * `tools/blender/build_sim_scene.py` turns into the 3D view's glb — and they are
 * the only place the joint origins are written down. The generated manifest
 * keeps each joint's axis and limits but not its origin, because posing a rig
 * needs no origins; solving inverse kinematics does.
 *
 * So this reads the joints straight out of the XML. Deliberately a parser for
 * *these* files rather than for URDF in general: `<joint>` elements with an
 * origin, an axis and a limit, which is all onshape-to-robot ever emits.
 */

export type Vec3 = [number, number, number]

export type UrdfJointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar'

export interface UrdfJoint {
  name: string
  type: UrdfJointType
  parent: string
  child: string
  /** Transform from the parent link's frame to this joint's frame. */
  origin: { xyz: Vec3; rpy: Vec3 }
  /** Rotation axis in the joint's own frame. URDF's default is +X. */
  axis: Vec3
  /** Present on revolute and prismatic joints; `continuous` ones have none. */
  limit: { lower: number; upper: number } | null
}

const JOINT_TYPES: readonly string[] = [
  'revolute',
  'continuous',
  'prismatic',
  'fixed',
  'floating',
  'planar'
]

function attr(text: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(text)
  return match ? match[1] : null
}

/** `"0 -0.045 0.0165"` -> `[0, -0.045, 0.0165]`. Missing components read as 0. */
export function parseVec3(text: string | null, fallback: Vec3): Vec3 {
  if (text === null) return fallback
  const parts = text.trim().split(/\s+/).map(Number)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** First child element of the given name inside one element's body. */
function child(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b([^>]*)/?>`).exec(body)
  return match ? match[1] : null
}

/**
 * Every `<joint>` in a URDF document, in document order.
 *
 * Comments and `<transmission>` blocks are stripped first: a transmission
 * carries its own `<joint name="…">` element naming the joint it drives, which
 * would otherwise parse as a second, typeless copy of a real joint.
 */
export function parseUrdfJoints(xml: string): UrdfJoint[] {
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<transmission\b[\s\S]*?<\/transmission>/g, '')

  const joints: UrdfJoint[] = []
  const pattern = /<joint\b([^>]*)>([\s\S]*?)<\/joint>/g
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const [, attrs, inner] = match
    const name = attr(attrs, 'name')
    const type = attr(attrs, 'type')
    if (!name || !type || !JOINT_TYPES.includes(type)) continue

    const parent = attr(child(inner, 'parent') ?? '', 'link')
    const childLink = attr(child(inner, 'child') ?? '', 'link')
    if (!parent || !childLink) continue

    const origin = child(inner, 'origin')
    const axis = child(inner, 'axis')
    const limit = child(inner, 'limit')
    const lower = limit ? Number(attr(limit, 'lower')) : NaN
    const upper = limit ? Number(attr(limit, 'upper')) : NaN

    joints.push({
      name,
      type: type as UrdfJointType,
      parent,
      child: childLink,
      origin: {
        xyz: parseVec3(origin ? attr(origin, 'xyz') : null, [0, 0, 0]),
        rpy: parseVec3(origin ? attr(origin, 'rpy') : null, [0, 0, 0])
      },
      axis: parseVec3(axis ? attr(axis, 'xyz') : null, [1, 0, 0]),
      limit:
        Number.isFinite(lower) && Number.isFinite(upper) && upper > lower ? { lower, upper } : null
    })
  }
  return joints
}

/** The link no joint has as its child — the root of the tree. */
export function rootLink(joints: readonly UrdfJoint[]): string | null {
  const children = new Set(joints.map((j) => j.child))
  for (const joint of joints) {
    if (!children.has(joint.parent)) return joint.parent
  }
  return null
}

/**
 * Joints connecting two links, parent-first.
 *
 * A URDF is a tree, so the path is unique when it exists. Only ever walked
 * downwards here (`from` is an ancestor of `to`), which is what a kinematic
 * chain from the base outwards means.
 */
export function jointPath(
  joints: readonly UrdfJoint[],
  from: string,
  to: string
): UrdfJoint[] | null {
  if (from === to) return []
  const byParent = new Map<string, UrdfJoint[]>()
  for (const joint of joints) {
    const list = byParent.get(joint.parent)
    if (list) list.push(joint)
    else byParent.set(joint.parent, [joint])
  }

  const walk = (link: string, trail: UrdfJoint[]): UrdfJoint[] | null => {
    for (const joint of byParent.get(link) ?? []) {
      if (joint.child === to) return [...trail, joint]
      const found = walk(joint.child, [...trail, joint])
      if (found) return found
    }
    return null
  }
  return walk(from, [])
}

/**
 * The tip of a chain: follow fixed joints down from `link` while there is
 * exactly one to follow.
 *
 * SO-101's URDF ends in a `gripper_frame_link` bolted to the wrist by a fixed
 * joint — the frame LeRobot's own kinematics treats as the tool. SO-100's has no
 * such link, so the tool frame is the last moving link itself. Following fixed
 * joints covers both without a per-model table.
 */
export function toolLink(joints: readonly UrdfJoint[], link: string): string {
  let current = link
  for (;;) {
    const fixed = joints.filter((j) => j.parent === current && j.type === 'fixed')
    if (fixed.length !== 1) return current
    current = fixed[0].child
  }
}
