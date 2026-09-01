import type { AppSettings, DeviceProfile } from '@shared/types'
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

export function getProfile(uid: string | null | undefined): DeviceProfile | null {
  if (!uid) return null
  return profiles().get().profiles.find((p) => p.uid === uid) ?? null
}

export function upsertProfile(profile: DeviceProfile): DeviceProfile[] {
  const list = [...profiles().get().profiles]
  const idx = list.findIndex((p) => p.uid === profile.uid)
  if (idx >= 0) list[idx] = profile
  else list.push(profile)
  return profiles().replace({ profiles: list }).profiles
}

export function deleteProfile(uid: string): DeviceProfile[] {
  const list = profiles().get().profiles.filter((p) => p.uid !== uid)
  return profiles().replace({ profiles: list }).profiles
}

/** LeRobot ids become filenames (`<dir>/<id>.json`), so keep them boring. */
export function isValidDeviceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
}
