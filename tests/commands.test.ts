import type { DeviceProfile, InferOptions, ReplayOptions, TeleoperateOptions } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  buildCalibrateCommand,
  buildInferCommand,
  buildRecordCommand,
  buildReplayCommand,
  buildSetupMotorsCommand,
  buildTeleoperateCommand,
  ensureEvalPrefix,
  serializeCameras,
  type ScriptResolver
} from '../src/main/runner/commands'

/**
 * These tests pin the draccus flag nesting against the commands published in the
 * LeRobot docs. Getting a flag name wrong is the single easiest way to break this
 * app, and it is the one class of bug we can catch without an arm attached.
 */
const resolve: ScriptResolver = (script) => `/venv/bin/${script}`

const follower: DeviceProfile = {
  uid: 'f1',
  id: 'my_awesome_follower_arm',
  role: 'robot',
  model: 'SO101',
  port: '/dev/tty.usbmodem58760431541',
  calibrationDir: '/project/calibration',
  cameras: []
}

const leader: DeviceProfile = {
  uid: 'l1',
  id: 'my_awesome_leader_arm',
  role: 'teleop',
  model: 'SO101',
  port: '/dev/tty.usbmodem58760431551',
  calibrationDir: '/project/calibration',
  cameras: []
}

const withCameras: DeviceProfile = {
  ...follower,
  cameras: [
    { key: 'front', type: 'opencv', identifier: '0', width: 640, height: 480, fps: 30 },
    {
      key: 'side',
      type: 'intelrealsense',
      identifier: '233522074606',
      width: 640,
      height: 480,
      fps: 30,
      useDepth: true
    }
  ]
}

function teleopOptions(patch: Partial<TeleoperateOptions> = {}): TeleoperateOptions {
  return {
    controller: 'leader',
    setup: 'single',
    robotUid: 'f1',
    leaderUid: 'l1',
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
    datasetRepoId: 'me/record-test',
    datasetRoot: '/project/samples',
    singleTask: 'Grab the black cube',
    numEpisodes: 5,
    episodeTimeS: 60,
    resetTimeS: 15,
    pushToHub: false,
    resume: false,
    ...patch
  }
}

const singleDevices = {
  robot: follower,
  leader,
  leftRobot: null,
  rightRobot: null,
  leftLeader: null,
  rightLeader: null
}

describe('calibrate', () => {
  it('uses --robot.* for a follower and includes the calibration dir', () => {
    const cmd = buildCalibrateCommand(resolve, follower)
    expect(cmd.file).toBe('/venv/bin/lerobot-calibrate')
    expect(cmd.args).toEqual([
      '--robot.type=so101_follower',
      '--robot.port=/dev/tty.usbmodem58760431541',
      '--robot.id=my_awesome_follower_arm',
      '--robot.calibration_dir=/project/calibration'
    ])
  })

  it('uses --teleop.* for a leader', () => {
    const cmd = buildCalibrateCommand(resolve, leader)
    expect(cmd.args).toEqual([
      '--teleop.type=so101_leader',
      '--teleop.port=/dev/tty.usbmodem58760431551',
      '--teleop.id=my_awesome_leader_arm',
      '--teleop.calibration_dir=/project/calibration'
    ])
  })

  it('maps SO100 to the so100_* device types', () => {
    const cmd = buildCalibrateCommand(resolve, { ...follower, model: 'SO100' })
    expect(cmd.args[0]).toBe('--robot.type=so100_follower')
  })
})

describe('setup-motors', () => {
  it('omits id and calibration_dir, which the wizard does not use', () => {
    const cmd = buildSetupMotorsCommand(resolve, follower)
    expect(cmd.args).toEqual([
      '--robot.type=so101_follower',
      '--robot.port=/dev/tty.usbmodem58760431541'
    ])
  })
})

describe('teleoperate', () => {
  it('matches the documented single-arm invocation', () => {
    const cmd = buildTeleoperateCommand(resolve, teleopOptions(), singleDevices)
    expect(cmd.file).toBe('/venv/bin/lerobot-teleoperate')
    expect(cmd.args).toEqual([
      '--robot.type=so101_follower',
      '--robot.port=/dev/tty.usbmodem58760431541',
      '--robot.id=my_awesome_follower_arm',
      '--robot.calibration_dir=/project/calibration',
      '--teleop.type=so101_leader',
      '--teleop.port=/dev/tty.usbmodem58760431551',
      '--teleop.id=my_awesome_leader_arm',
      '--teleop.calibration_dir=/project/calibration',
      '--fps=30',
      '--display_data=false'
    ])
  })

  it('emits booleans as --flag=true, never bare', () => {
    const cmd = buildTeleoperateCommand(resolve, teleopOptions({ displayData: true }), singleDevices)
    expect(cmd.args).toContain('--display_data=true')
    expect(cmd.args).not.toContain('--display_data')
  })

  it('attaches cameras to the robot only', () => {
    const cmd = buildTeleoperateCommand(resolve, teleopOptions({ useCameras: true }), {
      ...singleDevices,
      robot: withCameras
    })
    const cameraArgs = cmd.args.filter((a) => a.includes('.cameras='))
    expect(cameraArgs).toHaveLength(1)
    expect(cameraArgs[0]).toMatch(/^--robot\.cameras=/)
  })

  it('nests bimanual ports under left_arm_config / right_arm_config', () => {
    const cmd = buildTeleoperateCommand(
      resolve,
      teleopOptions({ setup: 'dual' }),
      {
        robot: null,
        leader: null,
        leftRobot: { ...follower, uid: 'lf', id: 'left_follower', port: '/dev/ttyACM0' },
        rightRobot: { ...follower, uid: 'rf', id: 'right_follower', port: '/dev/ttyACM1' },
        leftLeader: { ...leader, uid: 'll', id: 'left_leader', port: '/dev/ttyACM2' },
        rightLeader: { ...leader, uid: 'rl', id: 'right_leader', port: '/dev/ttyACM3' }
      }
    )
    expect(cmd.args).toContain('--robot.type=bi_so_follower')
    expect(cmd.args).toContain('--robot.left_arm_config.port=/dev/ttyACM0')
    expect(cmd.args).toContain('--robot.right_arm_config.port=/dev/ttyACM1')
    expect(cmd.args).toContain('--robot.id=bimanual_follower')
    expect(cmd.args).toContain('--teleop.type=bi_so_leader')
    expect(cmd.args).toContain('--teleop.left_arm_config.port=/dev/ttyACM2')

    // The form used in lerobot_replay.py's docstring does not exist and would be
    // rejected by draccus — make sure we never emit it.
    expect(cmd.args.some((a) => a.startsWith('--robot.left_arm_port'))).toBe(false)
    expect(cmd.args.some((a) => a.startsWith('--robot.right_arm_port'))).toBe(false)
  })

  it('refuses a dual setup with missing arms', () => {
    expect(() =>
      buildTeleoperateCommand(resolve, teleopOptions({ setup: 'dual' }), singleDevices)
    ).toThrow(/left and right/i)
  })
})

describe('record', () => {
  it('emits the documented dataset flags and silences text-to-speech', () => {
    const cmd = buildRecordCommand(resolve, teleopOptions({ record: true }), singleDevices)
    expect(cmd.file).toBe('/venv/bin/lerobot-record')
    expect(cmd.args).toContain('--dataset.repo_id=me/record-test')
    expect(cmd.args).toContain('--dataset.single_task=Grab the black cube')
    expect(cmd.args).toContain('--dataset.num_episodes=5')
    expect(cmd.args).toContain('--dataset.episode_time_s=60')
    expect(cmd.args).toContain('--dataset.reset_time_s=15')
    expect(cmd.args).toContain('--dataset.fps=30')
    expect(cmd.args).toContain('--dataset.push_to_hub=false')
    expect(cmd.args).toContain('--dataset.root=/project/samples')
    expect(cmd.args).toContain('--play_sounds=false')
    expect(cmd.args).not.toContain('--resume=true')
  })

  it('adds --resume=true when resuming', () => {
    const cmd = buildRecordCommand(resolve, teleopOptions({ record: true, resume: true }), singleDevices)
    expect(cmd.args).toContain('--resume=true')
  })

  it('requires a dataset name and a task', () => {
    expect(() =>
      buildRecordCommand(resolve, teleopOptions({ record: true, datasetRepoId: '  ' }), singleDevices)
    ).toThrow(/dataset name/i)
    expect(() =>
      buildRecordCommand(resolve, teleopOptions({ record: true, singleTask: '' }), singleDevices)
    ).toThrow(/task description/i)
  })
})

describe('replay', () => {
  const opts: ReplayOptions = {
    robotUid: 'f1',
    datasetRoot: '/project/samples/me/record-test',
    repoId: 'me/record-test',
    episode: 0,
    fps: 30
  }

  it('matches the documented invocation', () => {
    const cmd = buildReplayCommand(resolve, opts, follower)
    expect(cmd.file).toBe('/venv/bin/lerobot-replay')
    expect(cmd.args).toEqual([
      '--robot.type=so101_follower',
      '--robot.port=/dev/tty.usbmodem58760431541',
      '--robot.id=my_awesome_follower_arm',
      '--robot.calibration_dir=/project/calibration',
      '--dataset.repo_id=me/record-test',
      '--dataset.episode=0',
      '--play_sounds=false',
      '--dataset.root=/project/samples/me/record-test'
    ])
  })

  it('refuses to run without a device', () => {
    expect(() => buildReplayCommand(resolve, opts, null)).toThrow(/select the device/i)
  })
})

describe('infer', () => {
  const opts: InferOptions = {
    robotUid: 'f1',
    policyPath: 'me/my_policy',
    task: 'Put lego brick into the transparent box',
    duration: 60,
    useCameras: true,
    displayData: false,
    evalRepoId: 'my_run',
    evalDatasetRoot: '/project/samples'
  }

  it('uses lerobot-rollout when the installed version has it', () => {
    const cmd = buildInferCommand(resolve, { hasRollout: true }, opts, withCameras)
    expect(cmd.file).toBe('/venv/bin/lerobot-rollout')
    expect(cmd.args).toContain('--strategy.type=base')
    expect(cmd.args).toContain('--policy.path=me/my_policy')
    expect(cmd.args).toContain('--task=Put lego brick into the transparent box')
    expect(cmd.args).toContain('--duration=60')
    expect(cmd.args.some((a) => a.startsWith('--robot.cameras='))).toBe(true)
  })

  it('omits --duration when set to run indefinitely', () => {
    const cmd = buildInferCommand(resolve, { hasRollout: true }, { ...opts, duration: 0 }, withCameras)
    expect(cmd.args.some((a) => a.startsWith('--duration'))).toBe(false)
  })

  it('falls back to lerobot-record with the mandatory eval_ prefix', () => {
    const cmd = buildInferCommand(resolve, { hasRollout: false }, opts, withCameras)
    expect(cmd.file).toBe('/venv/bin/lerobot-record')
    expect(cmd.args).toContain('--policy.path=me/my_policy')
    expect(cmd.args).toContain('--dataset.repo_id=eval_my_run')
    expect(cmd.args).toContain('--dataset.push_to_hub=false')
  })
})

describe('ensureEvalPrefix', () => {
  it('adds the prefix to a bare name', () => {
    expect(ensureEvalPrefix('my_run')).toBe('eval_my_run')
  })

  it('adds it after the owner in an owner/name id', () => {
    expect(ensureEvalPrefix('me/my_run')).toBe('me/eval_my_run')
  })

  it('leaves an already-prefixed name alone', () => {
    expect(ensureEvalPrefix('me/eval_my_run')).toBe('me/eval_my_run')
    expect(ensureEvalPrefix('eval_my_run')).toBe('eval_my_run')
  })

  it('falls back to a usable default when empty', () => {
    expect(ensureEvalPrefix('   ')).toBe('eval_policy_run')
  })
})

describe('serializeCameras', () => {
  it('formats an opencv camera with all three mandatory stream fields', () => {
    const out = serializeCameras([
      { key: 'front', type: 'opencv', identifier: '0', width: 640, height: 480, fps: 30 }
    ])
    expect(out).toBe('{ front: {type: opencv, index_or_path: 0, width: 640, height: 480, fps: 30} }')
  })

  it('passes a Linux device path through unquoted', () => {
    const out = serializeCameras([
      { key: 'up', type: 'opencv', identifier: '/dev/video10', width: 640, height: 480, fps: 30 }
    ])
    expect(out).toContain('index_or_path: /dev/video10')
  })

  it('quotes a RealSense serial so an all-digit value stays a string', () => {
    const out = serializeCameras([
      {
        key: 'side',
        type: 'intelrealsense',
        identifier: '233522074606',
        width: 640,
        height: 480,
        fps: 30,
        useDepth: true
      }
    ])
    expect(out).toContain('serial_number_or_name: "233522074606"')
    expect(out).toContain('use_depth: true')
  })

  it('joins multiple cameras into one dict', () => {
    const out = serializeCameras(withCameras.cameras)
    expect(out.startsWith('{ front:')).toBe(true)
    expect(out).toContain('}, side: {')
    expect(out.endsWith('} }')).toBe(true)
  })
})
