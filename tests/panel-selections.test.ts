import type { InferOptions, ReplayOptions, TeleoperateOptions } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  forgetDevice,
  type PanelSelections
} from '../src/renderer/lib/panel-selections'

/**
 * A panel's selections outlive the panel, so they can outlive the profile they
 * name: pick a follower in Teleoperate, delete it in Configure, come back. The
 * pruning below is what stops the app holding a uid nothing answers to, and it
 * has to keep working as panels gain fields.
 */

function teleoperate(patch: Partial<TeleoperateOptions> = {}): TeleoperateOptions {
  return {
    controller: 'leader',
    setup: 'single',
    robotUid: null,
    leaderUid: null,
    leftRobotUid: null,
    rightRobotUid: null,
    leftLeaderUid: null,
    rightLeaderUid: null,
    bimanualRobotId: 'bimanual_follower',
    bimanualLeaderId: 'bimanual_leader',
    fps: 30,
    displayData: false,
    useCameras: false,
    record: false,
    datasetRepoId: '',
    datasetRoot: '/samples',
    singleTask: '',
    numEpisodes: 5,
    episodeTimeS: 60,
    resetTimeS: 15,
    pushToHub: false,
    resume: false,
    ...patch
  }
}

const replay = (robotUid: string | null): ReplayOptions => ({
  robotUid,
  datasetRoot: '/samples/me/pick',
  repoId: 'me/pick',
  episode: 3,
  fps: 30
})

const infer = (robotUid: string | null): InferOptions => ({
  robotUid,
  policyPath: 'me/policy',
  task: 'Pick it up',
  duration: 60,
  useCameras: true,
  displayData: false,
  evalRepoId: 'eval_policy_run',
  evalDatasetRoot: '/samples'
})

describe('forgetDevice', () => {
  it('clears a panel that had the deleted device selected', () => {
    const next = forgetDevice({ 'configure.device': 'p-1', 'view3d.device': 'p-2' }, 'p-1')
    expect(next['configure.device']).toBeNull()
    expect(next['view3d.device']).toBe('p-2')
  })

  it('clears the device out of a panel’s options, field by field', () => {
    const next = forgetDevice(
      { 'teleoperate.options': teleoperate({ robotUid: 'p-1', leaderUid: 'p-2' }) },
      'p-1'
    )
    expect(next['teleoperate.options']?.robotUid).toBeNull()
    expect(next['teleoperate.options']?.leaderUid).toBe('p-2')
  })

  it('reaches every uid a bimanual setup holds', () => {
    const options = teleoperate({
      setup: 'dual',
      leftRobotUid: 'p-1',
      rightRobotUid: 'p-1',
      leftLeaderUid: 'p-2',
      rightLeaderUid: 'p-1'
    })
    const next = forgetDevice({ 'teleoperate.options': options }, 'p-1')?.['teleoperate.options']
    expect(next?.leftRobotUid).toBeNull()
    expect(next?.rightRobotUid).toBeNull()
    expect(next?.rightLeaderUid).toBeNull()
    expect(next?.leftLeaderUid).toBe('p-2')
  })

  it('clears the same device from every panel at once', () => {
    const next = forgetDevice(
      {
        'configure.device': 'p-1',
        'view3d.device': 'p-1',
        'teleoperate.options': teleoperate({ robotUid: 'p-1' }),
        'replay.options': replay('p-1'),
        'infer.options': infer('p-1')
      },
      'p-1'
    )
    expect(next['configure.device']).toBeNull()
    expect(next['view3d.device']).toBeNull()
    expect(next['teleoperate.options']?.robotUid).toBeNull()
    expect(next['replay.options']?.robotUid).toBeNull()
    expect(next['infer.options']?.robotUid).toBeNull()
  })

  /** Everything not naming that device has to come through untouched. */
  it('leaves the rest of a panel’s options alone', () => {
    const before = replay('p-1')
    const after = forgetDevice({ 'replay.options': before }, 'p-1')['replay.options']
    expect(after).toEqual({ ...before, robotUid: null })
  })

  it('keeps the other selections, including ones that are not devices', () => {
    const sticky: Partial<PanelSelections> = {
      'configure.device': 'p-1',
      'configure.motor': 'elbow_flex',
      'configure.controller': 'gamepad',
      'configure.speed': 1.5
    }
    const next = forgetDevice(sticky, 'p-1')
    expect(next['configure.motor']).toBe('elbow_flex')
    expect(next['configure.controller']).toBe('gamepad')
    expect(next['configure.speed']).toBe(1.5)
  })

  /**
   * Returned by reference when there is nothing to do, so deleting a profile no
   * panel had selected does not re-render every panel that reads this.
   */
  it('returns the same object when the device was not selected anywhere', () => {
    const sticky: Partial<PanelSelections> = {
      'configure.device': 'p-2',
      'replay.options': replay('p-2')
    }
    expect(forgetDevice(sticky, 'p-1')).toBe(sticky)
  })

  it('does not mutate what it was given', () => {
    const options = teleoperate({ robotUid: 'p-1' })
    const sticky: Partial<PanelSelections> = {
      'configure.device': 'p-1',
      'teleoperate.options': options
    }
    forgetDevice(sticky, 'p-1')
    expect(sticky['configure.device']).toBe('p-1')
    expect(options.robotUid).toBe('p-1')
  })

  it('has nothing to do with an empty set of selections', () => {
    expect(forgetDevice({}, 'p-1')).toEqual({})
  })
})
