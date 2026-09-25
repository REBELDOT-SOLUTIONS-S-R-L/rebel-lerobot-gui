/**
 * Demos: a saved shell script, the devices it needs, and how it reaches them.
 *
 * A demo is deliberately just a script rather than another command builder. The
 * panels elsewhere in the app exist to get one specific LeRobot invocation
 * right; a demo is for everything else someone has already worked out at a
 * prompt and wants a button for.
 *
 * The script runs in the OS's own shell, so what is portable is what the user
 * writes — the app does not pretend a bash demo will run on Windows. What the
 * app does guarantee is the environment: the venv's scripts are on PATH, and
 * every selected device is exported as `DEMO_*` variables, so a script never has
 * to hard-code a serial port that changes between machines.
 */

import type { DeviceProfile } from './types'
import { lerobotDeviceType } from './devices'

/** Longest a demo name may be — it has to stay readable on a card. */
export const DEMO_NAME_MAX = 60

export interface Demo {
  /** Stable internal key. */
  uid: string
  name: string
  /** `DeviceProfile.uid`s this demo runs against, in the order they were picked. */
  deviceUids: string[]
  /** Shell script, run by the OS's default shell. */
  script: string
  description: string
  /**
   * Filename of the card's background image inside the app's thumbnails
   * directory. Null means the card falls back to a plain tint.
   *
   * A filename rather than a path: the image is copied into the app's own data
   * directory when it is chosen, so a demo keeps its thumbnail even after the
   * file it came from is moved or deleted.
   */
  thumbnail: string | null
  createdAt: number
  updatedAt: number
}

/** A demo as the form collects it, before the store stamps the timestamps. */
export type DemoDraft = Omit<Demo, 'createdAt' | 'updatedAt'>

export function newDemoUid(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function emptyDemo(): DemoDraft {
  return { uid: newDemoUid(), name: '', deviceUids: [], script: '', description: '', thumbnail: null }
}

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

/**
 * Why this demo cannot be saved, or null when it can.
 *
 * Devices are deliberately not required: a demo that only calls `lerobot-*`
 * tools with hard-coded flags is legitimate, and refusing to save it would be
 * the app inventing a rule LeRobot does not have.
 */
export function validateDemo(demo: DemoDraft, others: readonly Demo[] = []): string | null {
  const name = demo.name.trim()
  if (!name) return 'Give the demo a name.'
  if (name.length > DEMO_NAME_MAX) return `Keep the name under ${DEMO_NAME_MAX} characters.`
  if (others.some((d) => d.uid !== demo.uid && d.name.trim().toLowerCase() === name.toLowerCase())) {
    return `Another demo is already called '${name}'.`
  }
  if (!demo.script.trim()) return 'The demo needs a script to run.'
  return null
}

/* ------------------------------------------------------------------ *
 * Device environment                                                  *
 * ------------------------------------------------------------------ */

/**
 * The `DEMO_*` variables a script can read.
 *
 * Three overlapping views of the same devices, because scripts want different
 * ones: numbered variables cover any selection, `DEMO_ROBOT_*` / `DEMO_LEADER_*`
 * cover the common one-follower-one-leader case without the script counting
 * indices, and `DEMO_DEVICES` carries the lot as JSON for anything that wants to
 * parse it.
 *
 * Devices that were selected and have since been deleted are skipped rather than
 * exported empty: a script that checks `-z "$DEMO_ROBOT_PORT"` should see the
 * difference between "not selected" and "selected but gone", and the panel warns
 * about the latter separately.
 */
export function demoEnv(demo: Demo, devices: readonly DeviceProfile[]): Record<string, string> {
  const selected = demo.deviceUids
    .map((uid) => devices.find((d) => d.uid === uid))
    .filter((d): d is DeviceProfile => d !== undefined)

  const env: Record<string, string> = {
    DEMO_NAME: demo.name,
    DEMO_UID: demo.uid,
    DEMO_DEVICE_COUNT: String(selected.length)
  }

  selected.forEach((device, index) => {
    for (const [suffix, value] of Object.entries(deviceFields(device))) {
      env[`DEMO_DEVICE_${index}_${suffix}`] = value
    }
  })

  // `robot` is LeRobot's follower and `teleop` its leader, so name the aliases
  // the way the docs and the rest of this app talk about them.
  const firstRobot = selected.find((d) => d.role === 'robot')
  const firstLeader = selected.find((d) => d.role === 'teleop')
  if (firstRobot) {
    for (const [suffix, value] of Object.entries(deviceFields(firstRobot))) {
      env[`DEMO_ROBOT_${suffix}`] = value
    }
  }
  if (firstLeader) {
    for (const [suffix, value] of Object.entries(deviceFields(firstLeader))) {
      env[`DEMO_LEADER_${suffix}`] = value
    }
  }

  env.DEMO_DEVICES = JSON.stringify(
    selected.map((d) => ({
      id: d.id,
      role: d.role,
      model: d.model,
      port: d.port,
      type: lerobotDeviceType(d.model, d.role),
      calibrationDir: d.calibrationDir
    }))
  )

  return env
}

function deviceFields(device: DeviceProfile): Record<string, string> {
  return {
    ID: device.id,
    ROLE: device.role,
    MODEL: device.model,
    PORT: device.port,
    TYPE: lerobotDeviceType(device.model, device.role),
    CALIBRATION_DIR: device.calibrationDir
  }
}

/**
 * Selected devices that no longer exist.
 *
 * Deleting a profile does not rewrite every demo that referenced it — the demo
 * is still the thing the user wrote, and a re-created profile with the same uid
 * would make it whole again. The panel surfaces this instead.
 */
export function missingDeviceUids(demo: Demo, devices: readonly DeviceProfile[]): string[] {
  return demo.deviceUids.filter((uid) => !devices.some((d) => d.uid === uid))
}

/** Device names for a demo, in the order they were picked, for the card's subtitle. */
export function deviceLabels(demo: Demo, devices: readonly DeviceProfile[]): string[] {
  return demo.deviceUids.map((uid) => devices.find((d) => d.uid === uid)?.id ?? `${uid} (missing)`)
}

/* ------------------------------------------------------------------ *
 * Thumbnails                                                          *
 * ------------------------------------------------------------------ */

/** Image formats Chromium renders and the file dialog therefore offers. */
export const THUMBNAIL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] as const

/**
 * The card's shape, as a CSS `aspect-ratio` value.
 *
 * The grid sizes cards at `minmax(230px, 1fr)` by `h-44`, so 230x176 is the
 * narrowest a card ever gets. The form's preview is given the same ratio and the
 * same `object-cover` crop, so what it shows is what the grid will show — at
 * least at the point where the crop is tightest.
 *
 * A style value rather than a Tailwind class: Tailwind only extracts class names
 * from files it scans as templates, and it does not scan this one, so a class
 * written here would silently never be generated.
 */
export const CARD_ASPECT = '230 / 176'

/**
 * How dark the card's thumbnail is dimmed.
 *
 * The overlay is drawn over the image, so the image reads at 30% — a card has to
 * carry white text over an arbitrary photo, and nothing else guarantees the
 * contrast.
 */
export const THUMBNAIL_DIM = 0.7
