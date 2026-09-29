import type { ArmModel } from '@shared/devices'
import type { MotorTelemetry } from '@shared/feetech'
import { DEFAULT_ROSBRIDGE_URL, urdfWithAbsoluteMeshes } from '@shared/ros'
import { SIM_MANIFESTS, type SimManifest } from '@shared/sim'
import { isVirtual } from '@shared/virtual'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridge } from '../bridge/bridge-client'
import { assetsDir } from '../paths'
import { getProfile, settings } from '../stores/settings'
import { RosPublisher } from './publisher'
import { RosbridgeClient } from './rosbridge-client'

/** The app's one publisher, reading its models out of the assets folder. */

const manifests = new Map<ArmModel, SimManifest>()
const descriptions = new Map<ArmModel, string>()

function loadManifest(model: ArmModel): SimManifest {
  let manifest = manifests.get(model)
  if (!manifest) {
    manifest = JSON.parse(readFileSync(join(assetsDir(), SIM_MANIFESTS[model]), 'utf8')) as SimManifest
    manifests.set(model, manifest)
  }
  return manifest
}

function loadDescription(model: ArmModel): string {
  let urdf = descriptions.get(model)
  if (!urdf) {
    // The manifest names it from the project root, as the 3D view also allows for.
    const path = join(assetsDir(), loadManifest(model).urdf.replace(/^assets\//, ''))
    urdf = urdfWithAbsoluteMeshes(readFileSync(path, 'utf8'), dirname(path))
    descriptions.set(model, urdf)
  }
  return urdf
}

export const rosClient = new RosbridgeClient()

export const rosPublisher = new RosPublisher({
  client: rosClient,
  url: () => settings().get().rosbridgeUrl || DEFAULT_ROSBRIDGE_URL,
  resolveDevice: (uid) => {
    const profile = getProfile(uid)
    if (!profile) throw new Error('That device profile no longer exists.')
    return { id: profile.id, model: profile.model, virtual: isVirtual(uid) }
  },
  loadManifest,
  loadDescription,
  readTelemetry: async (uid) => {
    // The simulation has no thermometers; say so rather than go quiet, which
    // a monitor would show as a stale device.
    if (isVirtual(uid)) {
      const motors: Record<string, Partial<MotorTelemetry>> = {}
      for (const joint of loadManifest('SO101').joints) motors[joint.name] = { status: 0 }
      return motors
    }
    if (!bridge.running) return null
    const res = await bridge.request<{ motors: Record<string, Partial<MotorTelemetry>> }>(
      'bus.telemetry',
      {},
      5_000
    )
    return res.motors
  }
})
