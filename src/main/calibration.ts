import { GEAR_RATIOS, SO_ARM_MOTORS } from '@shared/devices'
import type {
  BusSnapshot,
  CalibrationFile,
  DeviceProfile,
  MotorState
} from '@shared/types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Calibration file helpers.
 *
 * LeRobot writes `<calibration_dir>/<id>.json` as
 * `dict[motor_name, MotorCalibration]` with indent=4 (robots/robot.py:151-171,
 * motors_bus.py:174-180), so files round-trip cleanly through JSON.stringify.
 */

export function calibrationPathFor(profile: DeviceProfile): string {
  return join(profile.calibrationDir, `${profile.id}.json`)
}

/** Browsing to a file gives us both halves of LeRobot's addressing scheme. */
export function splitCalibrationPath(filePath: string): { calibrationDir: string; id: string } {
  return {
    calibrationDir: dirname(filePath),
    id: basename(filePath).replace(/\.json$/i, '')
  }
}

export function readCalibrationFile(filePath: string): CalibrationFile | null {
  if (!existsSync(filePath)) return null
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as CalibrationFile
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a LeRobot calibration file.`)
  }
  return parsed
}

export function writeCalibrationFile(filePath: string, data: CalibrationFile): void {
  mkdirSync(dirname(filePath), { recursive: true })
  // Match LeRobot's own indent so a diff against a freshly written file is clean.
  writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`, 'utf8')
}

/**
 * Build the Configure panel's table from a calibration file. Used as the offline
 * fallback so motor IDs and limits still display when no arm is plugged in.
 */
export function snapshotFromCalibration(
  profile: DeviceProfile,
  filePath: string,
  calibration: CalibrationFile
): BusSnapshot {
  const ratios = GEAR_RATIOS[profile.model][profile.role]
  const motors: MotorState[] = SO_ARM_MOTORS.map((spec) => {
    const entry = calibration[spec.name]
    return {
      name: spec.name,
      label: spec.label,
      id: entry?.id ?? spec.defaultId,
      position: null,
      rangeMin: entry?.range_min ?? null,
      rangeMax: entry?.range_max ?? null,
      homingOffset: entry?.homing_offset ?? null,
      driveMode: entry?.drive_mode ?? null,
      model: spec.model,
      gearRatio: ratios[spec.name] ?? null,
      online: false
    }
  })

  const missing = SO_ARM_MOTORS.filter((s) => !calibration[s.name]).map((s) => s.name)
  return {
    source: 'calibration-file',
    connected: false,
    port: profile.port || null,
    baudrate: null,
    motors,
    calibrationPath: filePath,
    warning: missing.length
      ? `The calibration file has no entry for: ${missing.join(', ')}.`
      : undefined
  }
}

/** Last-resort table when there is neither a bus nor a calibration file. */
export function snapshotFromDefaults(profile: DeviceProfile): BusSnapshot {
  const ratios = GEAR_RATIOS[profile.model][profile.role]
  return {
    source: 'defaults',
    connected: false,
    port: profile.port || null,
    baudrate: null,
    motors: SO_ARM_MOTORS.map((spec) => ({
      name: spec.name,
      label: spec.label,
      id: spec.defaultId,
      position: null,
      rangeMin: null,
      rangeMax: null,
      homingOffset: null,
      driveMode: null,
      model: spec.model,
      gearRatio: ratios[spec.name] ?? null,
      online: false
    })),
    warning: 'Not calibrated yet — showing factory motor IDs.'
  }
}

/** Shape a bridge `bus.state` reply into the renderer's snapshot type. */
export function snapshotFromBridge(
  profile: DeviceProfile,
  state: {
    port: string | null
    baudrate: number | null
    motors: {
      name: string
      id: number
      position: number | null
      rangeMin: number | null
      rangeMax: number | null
      homingOffset: number | null
      driveMode: number | null
      online: boolean
      error?: string | null
    }[]
  }
): BusSnapshot {
  const ratios = GEAR_RATIOS[profile.model][profile.role]
  const byName = new Map(state.motors.map((m) => [m.name, m]))
  const motors: MotorState[] = SO_ARM_MOTORS.map((spec) => {
    const live = byName.get(spec.name)
    return {
      name: spec.name,
      label: spec.label,
      id: live?.id ?? spec.defaultId,
      position: live?.position ?? null,
      rangeMin: live?.rangeMin ?? null,
      rangeMax: live?.rangeMax ?? null,
      homingOffset: live?.homingOffset ?? null,
      driveMode: live?.driveMode ?? null,
      model: spec.model,
      gearRatio: ratios[spec.name] ?? null,
      online: live?.online ?? false
    }
  })
  const offline = motors.filter((m) => !m.online).map((m) => m.name)
  return {
    source: 'live',
    connected: true,
    port: state.port,
    baudrate: state.baudrate,
    motors,
    warning: offline.length
      ? `No response from: ${offline.join(', ')}. Check the daisy-chain and motor IDs.`
      : undefined
  }
}

/** Convert the live table back into a calibration file for saving. */
export function calibrationFromMotors(motors: MotorState[]): CalibrationFile {
  const out: CalibrationFile = {}
  for (const m of motors) {
    if (m.rangeMin === null || m.rangeMax === null || m.homingOffset === null) continue
    out[m.name] = {
      id: m.id,
      drive_mode: m.driveMode ?? 0,
      homing_offset: m.homingOffset,
      range_min: m.rangeMin,
      range_max: m.rangeMax
    }
  }
  return out
}
