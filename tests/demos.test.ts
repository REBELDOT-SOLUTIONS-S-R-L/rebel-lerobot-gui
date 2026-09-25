import type { Demo, DemoDraft } from '@shared/demos'
import {
  DEMO_NAME_MAX,
  demoEnv,
  deviceLabels,
  emptyDemo,
  missingDeviceUids,
  validateDemo
} from '@shared/demos'
import type { DeviceProfile } from '@shared/types'
import { describe, expect, it } from 'vitest'

function device(over: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    uid: 'p-1',
    id: 'follower',
    role: 'robot',
    model: 'SO101',
    port: '/dev/ttyACM0',
    calibrationDir: '/tmp/calib',
    cameras: [],
    ...over
  }
}

function demo(over: Partial<Demo> = {}): Demo {
  return {
    uid: 'd-1',
    name: 'Pick and place',
    deviceUids: [],
    script: 'echo hi',
    description: '',
    thumbnail: null,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

describe('validateDemo', () => {
  const draft = (over: Partial<DemoDraft> = {}): DemoDraft => ({ ...emptyDemo(), name: 'A', script: 'echo', ...over })

  it('accepts a named demo with a script', () => {
    expect(validateDemo(draft())).toBeNull()
  })

  it('requires a name and a script', () => {
    expect(validateDemo(draft({ name: '   ' }))).toMatch(/name/i)
    expect(validateDemo(draft({ script: '  \n ' }))).toMatch(/script/i)
  })

  it('refuses a name longer than the card can show', () => {
    expect(validateDemo(draft({ name: 'x'.repeat(DEMO_NAME_MAX + 1) }))).toMatch(/under/i)
  })

  /**
   * Names are how demos are told apart on the grid, so a duplicate is refused —
   * but only against *other* demos, or saving an edit would reject itself.
   */
  it('refuses a duplicate name, case-insensitively, but not its own', () => {
    const existing = [demo({ uid: 'd-9', name: 'Wave' })]
    expect(validateDemo(draft({ name: 'wave' }), existing)).toMatch(/already called/i)
    expect(validateDemo(draft({ uid: 'd-9', name: 'Wave' }), existing)).toBeNull()
  })

  /**
   * A demo that hard-codes its ports is legitimate; requiring a device would be
   * the app inventing a rule LeRobot does not have.
   */
  it('does not require any devices', () => {
    expect(validateDemo(draft({ deviceUids: [] }))).toBeNull()
  })
})

describe('demoEnv', () => {
  const robot = device({ uid: 'p-r', id: 'follower', role: 'robot', port: '/dev/robot' })
  const leader = device({ uid: 'p-l', id: 'leader', role: 'teleop', port: '/dev/leader' })

  it('numbers every selected device in the order it was picked', () => {
    const env = demoEnv(demo({ deviceUids: ['p-l', 'p-r'] }), [robot, leader])
    expect(env.DEMO_DEVICE_COUNT).toBe('2')
    expect(env.DEMO_DEVICE_0_ID).toBe('leader')
    expect(env.DEMO_DEVICE_1_ID).toBe('follower')
    expect(env.DEMO_DEVICE_1_PORT).toBe('/dev/robot')
  })

  it('aliases the first of each role, using LeRobot device types', () => {
    const env = demoEnv(demo({ deviceUids: ['p-r', 'p-l'] }), [robot, leader])
    expect(env.DEMO_ROBOT_PORT).toBe('/dev/robot')
    expect(env.DEMO_LEADER_PORT).toBe('/dev/leader')
    expect(env.DEMO_ROBOT_TYPE).toBe('so101_follower')
    expect(env.DEMO_LEADER_TYPE).toBe('so101_leader')
  })

  it('omits an alias for a role that was not selected', () => {
    const env = demoEnv(demo({ deviceUids: ['p-r'] }), [robot, leader])
    expect(env.DEMO_LEADER_PORT).toBeUndefined()
  })

  /**
   * A script checking `-z "$DEMO_ROBOT_PORT"` must be able to tell "not
   * selected" from "selected but since deleted"; the panel warns about the
   * latter separately, so here the device simply is not exported.
   */
  it('skips a device that no longer exists rather than exporting it empty', () => {
    const env = demoEnv(demo({ deviceUids: ['p-r', 'p-gone'] }), [robot])
    expect(env.DEMO_DEVICE_COUNT).toBe('1')
    expect(env.DEMO_DEVICE_1_ID).toBeUndefined()
    expect(env.DEMO_ROBOT_ID).toBe('follower')
  })

  it('carries the whole selection as JSON', () => {
    const env = demoEnv(demo({ deviceUids: ['p-r'] }), [robot, leader])
    expect(JSON.parse(env.DEMO_DEVICES)).toEqual([
      {
        id: 'follower',
        role: 'robot',
        model: 'SO101',
        port: '/dev/robot',
        type: 'so101_follower',
        calibrationDir: '/tmp/calib'
      }
    ])
  })

  it('always exports the demo it belongs to', () => {
    const env = demoEnv(demo({ name: 'Wave', uid: 'd-7' }), [])
    expect(env).toMatchObject({ DEMO_NAME: 'Wave', DEMO_UID: 'd-7', DEMO_DEVICE_COUNT: '0' })
  })
})

describe('missing devices', () => {
  it('names the uids that no longer resolve', () => {
    const d = demo({ deviceUids: ['p-1', 'p-gone'] })
    expect(missingDeviceUids(d, [device()])).toEqual(['p-gone'])
  })

  it('labels a missing device rather than dropping it from the card', () => {
    const d = demo({ deviceUids: ['p-1', 'p-gone'] })
    expect(deviceLabels(d, [device()])).toEqual(['follower', 'p-gone (missing)'])
  })
})

describe('emptyDemo', () => {
  it('produces a distinct uid each time', () => {
    expect(emptyDemo().uid).not.toBe(emptyDemo().uid)
  })
})
