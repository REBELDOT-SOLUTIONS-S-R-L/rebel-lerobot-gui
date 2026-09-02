import type { AppSettings, DeviceProfile } from '@shared/types'
import { VIRTUAL_ID, isVirtual, virtualProfile } from '@shared/virtual'
import { defaultCalibrationDir, defaultDatasetRoot } from '../paths'
import { JsonStore } from './json-store'

let settingsStore: JsonStore<AppSettings> | null = null
let profilesStore: JsonStore<{ profiles: DeviceProfile[] }> | null = null

function defaults(): AppSettings {
  return {
    pythonPath: null,
    venvPath: null,
    lerobotSourcePath: null,
    defaultCalibrationDir: defaultCalibrationDir(),
    defaultDatasetRoot: defaultDatasetRoot(),
    preferUv: false,
    theme: 'dark',
    sidebarWidths: { configure: 380, view3d: 340, teleoperate: 420, replay: 420, infer: 420 }
  }
}

/** Lazily constructed: `app.getPath('userData')` is only valid after `ready`. */
export function settings(): JsonStore<AppSettings> {
  settingsStore ??= new JsonStore<AppSettings>('settings', defaults())
  return settingsStore
}

export function profiles(): JsonStore<{ profiles: DeviceProfile[] }> {
  profilesStore ??= new JsonStore<{ profiles: DeviceProfile[] }>('profiles', { profiles: [] })
  return profilesStore
}

/**
 * Every device the app offers, the virtual arm first.
 *
 * The virtual arm is synthesised on every read rather than written into the
 * store: it has to exist before anything has been configured, it must not be
 * editable, and it must not be one of the profiles a user can delete. Putting it
 * at the front of the same list means every panel picks it up without knowing it
 * is special.
 */
export function listProfiles(): DeviceProfile[] {
  const dir = settings().get().defaultCalibrationDir || defaultCalibrationDir()
  return [virtualProfile(dir), ...profiles().get().profiles]
}

export function getProfile(uid: string | null | undefined): DeviceProfile | null {
  if (!uid) return null
  return listProfiles().find((p) => p.uid === uid) ?? null
}

export function upsertProfile(profile: DeviceProfile): DeviceProfile[] {
  if (isVirtual(profile.uid)) {
    throw new Error('The virtual arm is fixed — its name, model and port cannot be changed.')
  }
  const list = [...profiles().get().profiles]
  const idx = list.findIndex((p) => p.uid === profile.uid)
  if (idx >= 0) list[idx] = profile
  else list.push(profile)
  profiles().replace({ profiles: list })
  return listProfiles()
}

export function deleteProfile(uid: string): DeviceProfile[] {
  if (isVirtual(uid)) throw new Error('The virtual arm cannot be deleted.')
  const list = profiles().get().profiles.filter((p) => p.uid !== uid)
  profiles().replace({ profiles: list })
  return listProfiles()
}

/** LeRobot ids become filenames (`<dir>/<id>.json`), so keep them boring. */
export function isValidDeviceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
}

/** The virtual arm's name is taken, so a real device cannot claim it. */
export function isReservedDeviceId(id: string): boolean {
  return id === VIRTUAL_ID
}
