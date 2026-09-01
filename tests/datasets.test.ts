import type { CalibrationFile, DeviceProfile } from '@shared/types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  calibrationFromMotors,
  calibrationPathFor,
  readCalibrationFile,
  snapshotFromCalibration,
  snapshotFromDefaults,
  splitCalibrationPath,
  writeCalibrationFile
} from '../src/main/calibration'
import { inferRepoId, isDatasetRoot, readDatasetMeta } from '../src/main/datasets'

const tmp = mkdtempSync(join(tmpdir(), 'lerobot-gui-test-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const profile: DeviceProfile = {
  uid: 'f1',
  id: 'my_follower',
  role: 'robot',
  model: 'SO101',
  port: '/dev/ttyACM0',
  calibrationDir: join(tmp, 'calibration'),
  cameras: []
}

/** Real LeRobot calibration content: dict[motor, MotorCalibration]. */
const calibration: CalibrationFile = {
  shoulder_pan: { id: 1, drive_mode: 0, homing_offset: 1024, range_min: 785, range_max: 3264 },
  shoulder_lift: { id: 2, drive_mode: 0, homing_offset: -1002, range_min: 843, range_max: 3227 },
  elbow_flex: { id: 3, drive_mode: 0, homing_offset: 132, range_min: 907, range_max: 3072 },
  wrist_flex: { id: 4, drive_mode: 0, homing_offset: -48, range_min: 767, range_max: 3283 },
  wrist_roll: { id: 5, drive_mode: 0, homing_offset: 986, range_min: 0, range_max: 4095 },
  gripper: { id: 6, drive_mode: 0, homing_offset: -1013, range_min: 2029, range_max: 3476 }
}

describe('calibration files', () => {
  it('addresses a file as <calibration_dir>/<id>.json, matching LeRobot', () => {
    expect(calibrationPathFor(profile)).toBe(join(tmp, 'calibration', 'my_follower.json'))
  })

  it('round-trips a file through write and read', () => {
    const path = calibrationPathFor(profile)
    writeCalibrationFile(path, calibration)
    expect(readCalibrationFile(path)).toEqual(calibration)
  })

  it('writes with indent 4, so diffs against LeRobot-written files stay clean', () => {
    const path = join(tmp, 'calibration', 'indent.json')
    writeCalibrationFile(path, calibration)
    const text = readCalibrationFile(path)
    expect(text).not.toBeNull()
    // Reconstruct the exact formatting LeRobot's draccus dump produces.
    const onDisk = require('node:fs').readFileSync(path, 'utf8') as string
    expect(onDisk.startsWith('{\n    "shoulder_pan": {\n        "id": 1,')).toBe(true)
  })

  it('returns null for a file that does not exist', () => {
    expect(readCalibrationFile(join(tmp, 'calibration', 'nope.json'))).toBeNull()
  })

  it('rejects a JSON file that is not a calibration map', () => {
    const path = join(tmp, 'calibration', 'array.json')
    writeFileSync(path, '[1,2,3]')
    expect(() => readCalibrationFile(path)).toThrow(/not a LeRobot calibration file/i)
  })

  it('splits a browsed file path back into a folder and an id', () => {
    const split = splitCalibrationPath(join(tmp, 'calibration', 'other_arm.json'))
    expect(split.calibrationDir).toBe(join(tmp, 'calibration'))
    expect(split.id).toBe('other_arm')
  })

  it('builds the motor table from a calibration file', () => {
    const snap = snapshotFromCalibration(profile, 'x.json', calibration)
    expect(snap.source).toBe('calibration-file')
    expect(snap.connected).toBe(false)
    expect(snap.motors).toHaveLength(6)
    expect(snap.motors[0]).toMatchObject({ name: 'shoulder_pan', id: 1, rangeMin: 785, rangeMax: 3264 })
    // Position is unknown offline — the UI shows a dash rather than a stale value.
    expect(snap.motors.every((m) => m.position === null)).toBe(true)
    expect(snap.warning).toBeUndefined()
  })

  it('warns about motors the calibration file is missing', () => {
    const partial = { ...calibration }
    delete (partial as Record<string, unknown>).gripper
    const snap = snapshotFromCalibration(profile, 'x.json', partial)
    expect(snap.warning).toMatch(/gripper/)
  })

  it('reports the SO-101 leader gear ratios, which differ per joint', () => {
    const snap = snapshotFromDefaults({ ...profile, role: 'teleop' })
    const ratios = Object.fromEntries(snap.motors.map((m) => [m.name, m.gearRatio]))
    expect(ratios.shoulder_pan).toBe('1/191')
    expect(ratios.shoulder_lift).toBe('1/345')
    expect(ratios.wrist_roll).toBe('1/147')
  })

  it('falls back to factory IDs with a clear warning', () => {
    const snap = snapshotFromDefaults(profile)
    expect(snap.source).toBe('defaults')
    expect(snap.motors.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(snap.warning).toMatch(/not calibrated/i)
  })

  it('converts the live table back into a calibration file', () => {
    const snap = snapshotFromCalibration(profile, 'x.json', calibration)
    expect(calibrationFromMotors(snap.motors)).toEqual(calibration)
  })

  it('skips motors with unknown limits when building a calibration file', () => {
    const snap = snapshotFromDefaults(profile)
    expect(calibrationFromMotors(snap.motors)).toEqual({})
  })
})

describe('datasets', () => {
  const root = join(tmp, 'datasets', 'me', 'record-test')

  it('detects a dataset root by its meta/info.json', () => {
    expect(isDatasetRoot(root)).toBe(false)
    mkdirSync(join(root, 'meta'), { recursive: true })
    writeFileSync(
      join(root, 'meta', 'info.json'),
      JSON.stringify({
        codebase_version: 'v3.0',
        robot_type: 'so101_follower',
        total_episodes: 3,
        total_frames: 1800,
        fps: 30
      })
    )
    expect(isDatasetRoot(root)).toBe(true)
  })

  it('infers owner/name from the folder layout LeRobot uses', () => {
    expect(inferRepoId(root)).toBe('me/record-test')
  })

  it('reads fps, counts and robot type, and lists the episodes', () => {
    const meta = readDatasetMeta(root)
    expect(meta.repoId).toBe('me/record-test')
    expect(meta.fps).toBe(30)
    expect(meta.totalEpisodes).toBe(3)
    expect(meta.totalFrames).toBe(1800)
    expect(meta.robotType).toBe('so101_follower')
    expect(meta.episodes).toEqual([0, 1, 2])
    expect(meta.warning).toBeUndefined()
  })

  it('explains what to pick when the folder is not a dataset root', () => {
    const meta = readDatasetMeta(join(tmp, 'datasets'))
    expect(meta.warning).toMatch(/meta\/info\.json/)
    expect(meta.episodes).toEqual([])
  })

  it('flags an empty dataset rather than offering episode 0', () => {
    const empty = join(tmp, 'datasets', 'me', 'empty')
    mkdirSync(join(empty, 'meta'), { recursive: true })
    writeFileSync(join(empty, 'meta', 'info.json'), JSON.stringify({ total_episodes: 0, fps: 30 }))
    const meta = readDatasetMeta(empty)
    expect(meta.episodes).toEqual([])
    expect(meta.warning).toMatch(/no episodes/i)
  })

  it('reports a parse failure instead of throwing', () => {
    const broken = join(tmp, 'datasets', 'me', 'broken')
    mkdirSync(join(broken, 'meta'), { recursive: true })
    writeFileSync(join(broken, 'meta', 'info.json'), '{not json')
    expect(readDatasetMeta(broken).warning).toMatch(/could not be parsed/i)
  })
})
