import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOTOR_NAMES, type ArmModel } from '@shared/devices'
import { SIM_MANIFESTS, type SimManifest } from '@shared/sim'
import {
  jointPath,
  parseUrdfJoints,
  parseVec3,
  rootLink,
  toolLink,
  type UrdfJoint
} from '@shared/urdf'
import { describe, expect, it } from 'vitest'

const MODELS: ArmModel[] = ['SO100', 'SO101']

function manifestFor(model: ArmModel): SimManifest {
  return JSON.parse(readFileSync(resolve('assets', SIM_MANIFESTS[model]), 'utf8')) as SimManifest
}

/** The URDF each generated scene was built from — the manifest records it. */
function jointsFor(model: ArmModel): UrdfJoint[] {
  return parseUrdfJoints(readFileSync(resolve(manifestFor(model).urdf), 'utf8'))
}

describe('parseVec3', () => {
  it('reads a three-component vector', () => {
    expect(parseVec3('0 -0.0452 0.0165', [0, 0, 0])).toEqual([0, -0.0452, 0.0165])
  })

  it('reads scientific notation, which onshape-to-robot emits freely', () => {
    expect(parseVec3('8.32667e-17 -0.000218214 0.000949706', [0, 0, 0])).toEqual([
      8.32667e-17,
      -0.000218214,
      0.000949706
    ])
  })

  it('pads a short vector and falls back on a missing or unreadable one', () => {
    expect(parseVec3('1', [9, 9, 9])).toEqual([1, 0, 0])
    expect(parseVec3(null, [1, 0, 0])).toEqual([1, 0, 0])
    expect(parseVec3('up a bit', [1, 0, 0])).toEqual([1, 0, 0])
  })
})

describe.each(MODELS)('%s URDF', (model) => {
  const joints = jointsFor(model)

  it('has one joint per motor, all revolute', () => {
    for (const name of MOTOR_NAMES) {
      const joint = joints.find((j) => j.name === name)
      expect(joint, `joint '${name}'`).toBeDefined()
      expect(joint!.type).toBe('revolute')
      expect(joint!.limit).not.toBeNull()
    }
  })

  /**
   * A `<transmission>` names the joint it drives with a nested `<joint
   * name="...">` that carries no type. Parsing those as joints would give every
   * motor a second, origin-less copy.
   */
  it('ignores the joints named inside transmission blocks', () => {
    const duplicates = MOTOR_NAMES.filter((name) => joints.filter((j) => j.name === name).length > 1)
    expect(duplicates).toEqual([])
  })

  it('agrees with the generated scene about every limit', () => {
    for (const scene of manifestFor(model).joints) {
      const joint = joints.find((j) => j.name === scene.name)
      expect(joint?.limit?.lower).toBeCloseTo(scene.lower, 4)
      expect(joint?.limit?.upper).toBeCloseTo(scene.upper, 4)
    }
  })

  it('is a tree with one root, reachable to every motor in order', () => {
    const root = rootLink(joints)
    expect(root).not.toBeNull()

    let link = root!
    for (const name of MOTOR_NAMES.filter((n) => n !== 'gripper')) {
      const joint = joints.find((j) => j.name === name)!
      const lead = jointPath(joints, link, joint.parent)
      expect(lead, `path to '${name}'`).not.toBeNull()
      // Nothing actuated may sit between two motors, or the chain would be wrong.
      expect(lead!.every((step) => step.type === 'fixed')).toBe(true)
      link = joint.child
    }
  })

  it('ends at a tool frame reached only through fixed joints', () => {
    const wristRoll = joints.find((j) => j.name === 'wrist_roll')!
    const tool = toolLink(joints, wristRoll.child)
    const lead = jointPath(joints, wristRoll.child, tool)
    expect(lead).not.toBeNull()
    expect(lead!.every((step) => step.type === 'fixed')).toBe(true)
  })
})

describe('jointPath', () => {
  const joints = jointsFor('SO101')

  it('is empty between a link and itself', () => {
    expect(jointPath(joints, 'base_link', 'base_link')).toEqual([])
  })

  it('is null when there is no way down to the target', () => {
    expect(jointPath(joints, 'gripper_link', 'base_link')).toBeNull()
    expect(jointPath(joints, 'base_link', 'no_such_link')).toBeNull()
  })
})
