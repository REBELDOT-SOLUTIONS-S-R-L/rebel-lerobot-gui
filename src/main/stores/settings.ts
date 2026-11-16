import { DEFAULT_ROSBRIDGE_URL } from '@shared/ros'
import type { AppSettings, DeviceProfile } from '@shared/types'
import { VIRTUAL_ID, isVirtual, virtualProfile } from '@shared/virtual'
import {
  CALIBRATION_FOLDER,
  DATASET_FOLDER,
  fromProjectRelative,
  projectRoot,
  relocateProjectFolder,
  toProjectRelative
} from '../paths'
import { JsonStore } from './json-store'

/**
 * Settings and device profiles, with their folders kept relative to the project.
 *
 * On disk, a folder inside the project is stored relative to it (`calibration`,
 * `data`), so the defaults follow the project when it is moved or cloned again.
 * Everything that reads these stores still gets absolute paths: the conversion
 * happens here and nowhere else.
 */

type Profiles = { profiles: DeviceProfile[] }

/** Where datasets went before `data/` existed. */
const OLD_DATASET_FOLDERS = ['samples'] as const

function defaults(): AppSettings {
  return {
    pythonPath: null,
    venvPath: null,
    lerobotSourcePath: null,
    defaultCalibrationDir: CALIBRATION_FOLDER,
    defaultDatasetRoot: DATASET_FOLDER,
    preferUv: false,
    theme: 'dark',
    sidebarWidths: { configure: 380, view3d: 340, teleoperate: 420, replay: 420, infer: 420 },
    rosbridgeUrl: DEFAULT_ROSBRIDGE_URL
  }
}

class SettingsStore {
  constructor(private readonly store: JsonStore<AppSettings>) {
    // Repair, once, folders stored as absolute paths into where the project used to be.
    const raw = store.get()
    const root = projectRoot()
    const repaired = {
      defaultCalibrationDir: relocateProjectFolder(raw.defaultCalibrationDir, root, CALIBRATION_FOLDER),
      defaultDatasetRoot: relocateProjectFolder(
        raw.defaultDatasetRoot,
        root,
        DATASET_FOLDER,
        undefined,
        OLD_DATASET_FOLDERS
      )
    }
    if (
      repaired.defaultCalibrationDir !== raw.defaultCalibrationDir ||
      repaired.defaultDatasetRoot !== raw.defaultDatasetRoot
    ) {
      store.set(repaired)
    }
  }

  get(): AppSettings {
    const raw = this.store.get()
    const root = projectRoot()
    return {
      ...raw,
      defaultCalibrationDir: fromProjectRelative(raw.defaultCalibrationDir || CALIBRATION_FOLDER, root),
      defaultDatasetRoot: fromProjectRelative(raw.defaultDatasetRoot || DATASET_FOLDER, root)
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const root = projectRoot()
    const stored = { ...patch }
    if (patch.defaultCalibrationDir !== undefined) {
      stored.defaultCalibrationDir = toProjectRelative(patch.defaultCalibrationDir, root)
    }
    if (patch.defaultDatasetRoot !== undefined) {
      stored.defaultDatasetRoot = toProjectRelative(patch.defaultDatasetRoot, root)
    }
    this.store.set(stored)
    return this.get()
  }
}

class ProfilesStore {
  constructor(private readonly store: JsonStore<Profiles>) {
    const root = projectRoot()
    const raw = store.get().profiles
    const repaired = raw.map((p) => ({
      ...p,
      calibrationDir: relocateProjectFolder(p.calibrationDir, root, CALIBRATION_FOLDER)
    }))
    if (repaired.some((p, i) => p.calibrationDir !== raw[i].calibrationDir)) {
      store.replace({ profiles: repaired })
    }
  }

  get(): Profiles {
    const root = projectRoot()
    return {
      profiles: this.store
        .get()
        .profiles.map((p) => ({ ...p, calibrationDir: fromProjectRelative(p.calibrationDir, root) }))
    }
  }

  replace(next: Profiles): Profiles {
    const root = projectRoot()
    this.store.replace({
      profiles: next.profiles.map((p) => ({ ...p, calibrationDir: toProjectRelative(p.calibrationDir, root) }))
    })
    return this.get()
  }
}

let settingsStore: SettingsStore | null = null
let profilesStore: ProfilesStore | null = null

/** Lazily constructed: `app.getPath('userData')` is only valid after `ready`. */
export function settings(): SettingsStore {
  settingsStore ??= new SettingsStore(new JsonStore<AppSettings>('settings', defaults()))
  return settingsStore
}

export function profiles(): ProfilesStore {
  profilesStore ??= new ProfilesStore(new JsonStore<Profiles>('profiles', { profiles: [] }))
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
  const dir = settings().get().defaultCalibrationDir
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
