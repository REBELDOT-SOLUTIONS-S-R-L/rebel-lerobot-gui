import { assetUrl } from '@shared/assets'
import { MOTOR_NAMES, type ArmModel } from '@shared/devices'
import { buildChain, fromAxisAngle, type Chain } from '@shared/kinematics'
import { BASE_YAW, type SimManifest } from '@shared/sim'
import { parseUrdfJoints } from '@shared/urdf'
import { loadSimManifest } from './arm-scene'

/**
 * A model's kinematics, loaded out of the assets folder.
 *
 * The 3D view already fetches a scene manifest per model; this fetches the URDF
 * that manifest was built from as well, because the joint origins the solver
 * needs are only written down there. Both come over the app's own `arm://`
 * scheme, so this works the same in dev and once packaged.
 */
export interface ArmKinematics {
  manifest: SimManifest
  chain: Chain
}

/**
 * The joints inverse kinematics may move, base outwards.
 *
 * Every motor but the jaws: the gripper hangs off the end of the chain and
 * changes nothing about where the tool is, so it is driven on its own.
 */
export const IK_JOINTS: readonly string[] = MOTOR_NAMES.filter((name) => name !== 'gripper')

const cache = new Map<ArmModel, Promise<ArmKinematics>>()

export function loadArmKinematics(model: ArmModel): Promise<ArmKinematics> {
  const cached = cache.get(model)
  if (cached) return cached
  // A failed load is not cached: the panel offers a retry, and a transient fetch
  // failure should not make the model permanently unavailable.
  const pending = build(model).catch((err: unknown) => {
    cache.delete(model)
    throw err
  })
  cache.set(model, pending)
  return pending
}

async function build(model: ArmModel): Promise<ArmKinematics> {
  const manifest = await loadSimManifest(model)
  // The manifest records the URDF path from the repository root, while `arm://`
  // is rooted at the assets folder itself.
  const url = assetUrl(manifest.urdf.replace(/^assets\//, ''))
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  const chain = buildChain(
    parseUrdfJoints(await response.text()),
    IK_JOINTS,
    fromAxisAngle([0, 0, 1], BASE_YAW[model])
  )
  return { manifest, chain }
}
