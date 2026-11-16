import {
  gamepadIndex,
  lerobotUnsupported,
  sideCamera,
  sidePrefix,
  teleopSides,
  validateSides,
  type TeleopSideSpec
} from '@shared/rig'
import { normalizeTicks } from '@shared/normalize'
import type { DeviceProfile, TeleoperateOptions } from '@shared/types'
import { VIRTUAL_UID } from '@shared/virtual'
import { describe, expect, it, vi } from 'vitest'

// The coordinator's conversions are pure, but its module pulls in Electron-side
// singletons; stub those so only the arithmetic is under test.
vi.mock('../src/main/bridge/bridge-client', () => ({ bridge: { running: false } }))
vi.mock('../src/main/ros', () => ({ rosPublisher: {} }))
vi.mock('../src/main/stores/settings', () => ({ getProfile: () => null, settings: () => ({ get: () => ({}) }) }))
vi.mock('../src/main/virtual-bus', () => ({ virtualBus: {} }))
vi.mock('../src/main/paths', () => ({ venvExists: () => false }))
vi.mock('../src/main/calibration', () => ({ snapshotFromBridge: () => null }))
const { fromNormalized, toNormalized } = await import('../src/main/rig')

function side(patch: Partial<TeleopSideSpec>): TeleopSideSpec {
  return {
    side: 'single',
    controller: 'leader',
    robotUid: 'f1',
    leaderUid: 'l1',
    cameraKey: null,
    showCamera: false,
    ...patch
  }
}

function options(patch: Partial<TeleoperateOptions>): TeleoperateOptions {
  return {
    setup: 'single',
    runner: 'app',
    controller: 'keyboard',
    robotUid: 'f1',
    leaderUid: null,
    cameraKey: 'front',
    showCamera: true,
    leftController: 'leader',
    rightController: 'gamepad',
    leftRobotUid: 'fl',
    rightRobotUid: 'fr',
    leftLeaderUid: 'll',
    rightLeaderUid: null,
    leftCameraKey: 'wrist',
    rightCameraKey: null,
    leftShowCamera: false,
    rightShowCamera: false,
    armSpacingCm: 30,
    autoRecord: false,
    bimanualRobotId: 'b',
    bimanualLeaderId: 'bl',
    fps: 30,
    displayData: false,
    useCameras: false,
    record: false,
    datasetRepoId: '',
    datasetRoot: '',
    singleTask: '',
    numEpisodes: 1,
    episodeTimeS: 1,
    resetTimeS: 0,
    pushToHub: false,
    resume: false,
    ...patch
  }
}

describe('teleopSides', () => {
  it('reads one side for a single setup', () => {
    expect(teleopSides(options({}))).toEqual([
      { side: 'single', controller: 'keyboard', robotUid: 'f1', leaderUid: null, cameraKey: 'front', showCamera: true }
    ])
  })
  it('reads a left and a right side, each with its own controller', () => {
    const [left, right] = teleopSides(options({ setup: 'dual' }))
    expect(left).toMatchObject({ side: 'left', controller: 'leader', robotUid: 'fl', leaderUid: 'll', cameraKey: 'wrist' })
    expect(right).toMatchObject({ side: 'right', controller: 'gamepad', robotUid: 'fr' })
  })
})

describe('validateSides', () => {
  it('accepts a complete setup', () => {
    expect(validateSides([side({})])).toBeNull()
    expect(validateSides([side({ controller: 'keyboard', leaderUid: null })])).toBeNull()
  })
  it('names the side that is missing an arm', () => {
    expect(validateSides([side({ side: 'left', robotUid: null }), side({ side: 'right' })])).toBe(
      'Left: select the follower arm.'
    )
    expect(validateSides([side({ leaderUid: null })])).toBe('select the leader arm.')
  })
  it('refuses the same arm on both sides', () => {
    expect(validateSides([side({ side: 'left' }), side({ side: 'right', leaderUid: 'l2' })])).toMatch(/different follower/)
    expect(validateSides([side({ side: 'left' }), side({ side: 'right', robotUid: 'f2' })])).toMatch(/different leader/)
  })
  it('lets the keyboard drive only one side', () => {
    const kb = { controller: 'keyboard' as const, leaderUid: null }
    expect(validateSides([side({ side: 'left', ...kb }), side({ side: 'right', robotUid: 'f2', ...kb })])).toMatch(
      /keyboard can drive only one side/
    )
  })
})

describe('gamepadIndex', () => {
  it('hands out pads in side order, counting only gamepad sides', () => {
    const sides = [side({ side: 'left', controller: 'gamepad' }), side({ side: 'right', controller: 'gamepad' })]
    expect(gamepadIndex(sides, 'left')).toBe(0)
    expect(gamepadIndex(sides, 'right')).toBe(1)
    expect(gamepadIndex([side({ side: 'left' }), side({ side: 'right', controller: 'gamepad' })], 'right')).toBe(0)
  })
})

describe('sidePrefix', () => {
  it("matches LeRobot's bimanual feature names", () => {
    expect(sidePrefix('single')).toBe('')
    expect(sidePrefix('left')).toBe('left_')
    expect(sidePrefix('right')).toBe('right_')
  })
})

describe('lerobotUnsupported', () => {
  it('only hands leader-driven real followers to LeRobot', () => {
    expect(lerobotUnsupported([side({})])).toBeNull()
    expect(lerobotUnsupported([side({ controller: 'gamepad' })])).toMatch(/leader arms/)
    expect(lerobotUnsupported([side({ robotUid: VIRTUAL_UID })])).toMatch(/virtual arm/)
  })
})

describe('sideCamera', () => {
  const profile = {
    cameras: [{ key: 'front', type: 'opencv', identifier: '0', width: 640, height: 480, fps: 30 }]
  } as DeviceProfile
  it('finds the chosen camera on the follower', () => {
    expect(sideCamera(profile, 'front')?.identifier).toBe('0')
    expect(sideCamera(profile, 'wrist')).toBeNull()
    expect(sideCamera(profile, null)).toBeNull()
  })
})

describe('virtual arm conversions', () => {
  const ranges = {
    shoulder_pan: { min: 1000, max: 3000 },
    gripper: { min: 2000, max: 3000 }
  }
  it('turns ticks into the `<motor>.pos` units LeRobot records', () => {
    expect(toNormalized({ shoulder_pan: 2000, gripper: 2500, elbow_flex: 100 }, ranges)).toEqual({
      'shoulder_pan.pos': normalizeTicks('degrees', 2000, ranges.shoulder_pan),
      'gripper.pos': 50
    })
  })
  it('round-trips an action back to ticks', () => {
    const action = toNormalized({ shoulder_pan: 2400, gripper: 2750 }, ranges)
    expect(fromNormalized(action, ranges)).toEqual({ shoulder_pan: 2400, gripper: 2750 })
  })
})
