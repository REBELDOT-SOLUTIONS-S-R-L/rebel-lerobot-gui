import { lerobotBimanualType, lerobotDeviceType } from '@shared/devices'
import type {
  CameraBinding,
  CommandSpec,
  DeviceProfile,
  InferOptions,
  LerobotCapabilities,
  ReplayOptions,
  TeleoperateOptions
} from '@shared/types'

/**
 * Pure builders: DeviceProfile -> argv.
 *
 * Deliberately free of Electron and fs so they can be unit-tested against the
 * exact command strings in the LeRobot docs. `resolve` maps a console-script
 * name to an absolute path inside the configured venv.
 */
export type ScriptResolver = (script: string) => string

/* ------------------------------------------------------------------ *
 * Formatting helpers                                                  *
 * ------------------------------------------------------------------ */

/**
 * Shell-quote for *display only*. Commands are spawned with an argv array, so
 * nothing here is ever handed to a shell.
 */
export function quoteForDisplay(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function displayOf(file: string, args: string[]): string {
  return [file, ...args].map(quoteForDisplay).join(' ')
}

function spec(file: string, args: string[], extra: Partial<CommandSpec> = {}): CommandSpec {
  return { file, args, display: displayOf(file, args), ...extra }
}

/** draccus/argparse booleans are `--flag=true` / `--flag=false`, never bare. */
function bool(value: boolean): string {
  return value ? 'true' : 'false'
}

/**
 * Serialize a camera dict for `--robot.cameras=`.
 *
 * width/height/fps are mandatory for robot cameras — RobotConfig.__post_init__
 * raises if any is None. RealSense serials are quoted so an all-digit serial is
 * parsed as a string rather than an int.
 */
export function serializeCameras(cameras: CameraBinding[]): string {
  const entries = cameras.map((cam) => {
    const fields: string[] = [`type: ${cam.type}`]
    if (cam.type === 'intelrealsense') {
      fields.push(`serial_number_or_name: "${cam.identifier}"`)
      if (cam.useDepth) fields.push(`use_depth: true`)
    } else {
      fields.push(`index_or_path: ${cam.identifier}`)
    }
    fields.push(`width: ${cam.width}`, `height: ${cam.height}`, `fps: ${cam.fps}`)
    return `${cam.key}: {${fields.join(', ')}}`
  })
  return `{ ${entries.join(', ')} }`
}

/* ------------------------------------------------------------------ *
 * Device flag groups                                                  *
 * ------------------------------------------------------------------ */

/** Flag namespace for a profile: robots use `--robot.*`, leaders `--teleop.*`. */
function ns(profile: DeviceProfile): 'robot' | 'teleop' {
  return profile.role === 'robot' ? 'robot' : 'teleop'
}

export interface DeviceFlagOptions {
  /** Emit `--<ns>.type=`. */
  includeType?: boolean
  /** Emit `--<ns>.id=` (omitted by setup-motors, which touches no calibration). */
  includeId?: boolean
  /** Emit `--<ns>.calibration_dir=`. */
  includeCalibrationDir?: boolean
  /** Emit `--<ns>.cameras=` when the profile has any. */
  includeCameras?: boolean
  /** Override the namespace (bimanual children live under a parent). */
  namespace?: string
}

/**
 * `--robot.calibration_dir=<dir>` + `--robot.id=<id>` makes LeRobot read/write
 * `<dir>/<id>.json` (robots/robot.py:46-56), which is exactly the
 * "choose where the calibration file lives" behaviour the app promises.
 */
export function deviceFlags(profile: DeviceProfile, opts: DeviceFlagOptions = {}): string[] {
  const {
    includeType = true,
    includeId = true,
    includeCalibrationDir = true,
    includeCameras = false,
    namespace = ns(profile)
  } = opts

  const args: string[] = []
  if (includeType) args.push(`--${namespace}.type=${lerobotDeviceType(profile.model, profile.role)}`)
  args.push(`--${namespace}.port=${profile.port}`)
  if (includeId) args.push(`--${namespace}.id=${profile.id}`)
  if (includeCalibrationDir) args.push(`--${namespace}.calibration_dir=${profile.calibrationDir}`)
  if (includeCameras && profile.cameras.length > 0) {
    args.push(`--${namespace}.cameras=${serializeCameras(profile.cameras)}`)
  }
  return args
}

/* ------------------------------------------------------------------ *
 * Calibrate / setup-motors                                            *
 * ------------------------------------------------------------------ */

export function buildCalibrateCommand(resolve: ScriptResolver, profile: DeviceProfile): CommandSpec {
  return spec(resolve('lerobot-calibrate'), deviceFlags(profile))
}

/**
 * `lerobot-setup-motors` writes IDs + baudrate to EEPROM one motor at a time.
 * It takes no `--*.id` because it never touches calibration files.
 */
export function buildSetupMotorsCommand(resolve: ScriptResolver, profile: DeviceProfile): CommandSpec {
  return spec(
    resolve('lerobot-setup-motors'),
    deviceFlags(profile, { includeId: false, includeCalibrationDir: false })
  )
}

/* ------------------------------------------------------------------ *
 * Teleoperate / record                                                *
 * ------------------------------------------------------------------ */

export interface TeleoperateResolved {
  robot: DeviceProfile | null
  leader: DeviceProfile | null
  leftRobot: DeviceProfile | null
  rightRobot: DeviceProfile | null
  leftLeader: DeviceProfile | null
  rightLeader: DeviceProfile | null
}

/**
 * Bimanual devices take ONE `--robot.id` / `--robot.calibration_dir`; the child
 * arms become `<id>_left` and `<id>_right` (bi_so_follower.py:42-63). Per-arm
 * settings nest under `left_arm_config` / `right_arm_config` — note that the
 * `--robot.left_arm_port` form used in lerobot_replay.py's docstring does not
 * exist and would be rejected.
 */
function bimanualFlags(
  namespace: 'robot' | 'teleop',
  role: 'robot' | 'teleop',
  left: DeviceProfile,
  right: DeviceProfile,
  id: string,
  calibrationDir: string,
  includeCameras: boolean
): string[] {
  const args = [
    `--${namespace}.type=${lerobotBimanualType(role)}`,
    `--${namespace}.left_arm_config.port=${left.port}`,
    `--${namespace}.right_arm_config.port=${right.port}`,
    `--${namespace}.id=${id}`,
    `--${namespace}.calibration_dir=${calibrationDir}`
  ]
  if (includeCameras) {
    if (left.cameras.length > 0) {
      args.push(`--${namespace}.left_arm_config.cameras=${serializeCameras(left.cameras)}`)
    }
    if (right.cameras.length > 0) {
      args.push(`--${namespace}.right_arm_config.cameras=${serializeCameras(right.cameras)}`)
    }
  }
  return args
}

function teleopDeviceArgs(
  opts: TeleoperateOptions,
  devices: TeleoperateResolved,
  includeRobotCameras: boolean
): string[] {
  if (opts.setup === 'dual') {
    const { leftRobot, rightRobot, leftLeader, rightLeader } = devices
    if (!leftRobot || !rightRobot || !leftLeader || !rightLeader) {
      throw new Error('Dual setup needs a left and right profile for both the leader and the robot.')
    }
    return [
      ...bimanualFlags(
        'robot',
        'robot',
        leftRobot,
        rightRobot,
        opts.bimanualRobotId,
        leftRobot.calibrationDir,
        includeRobotCameras
      ),
      ...bimanualFlags(
        'teleop',
        'teleop',
        leftLeader,
        rightLeader,
        opts.bimanualLeaderId,
        leftLeader.calibrationDir,
        false
      )
    ]
  }

  const { robot, leader } = devices
  if (!robot || !leader) throw new Error('Select both a robot and a leader profile.')
  return [
    ...deviceFlags(robot, { includeCameras: includeRobotCameras }),
    ...deviceFlags(leader)
  ]
}

export function buildTeleoperateCommand(
  resolve: ScriptResolver,
  opts: TeleoperateOptions,
  devices: TeleoperateResolved
): CommandSpec {
  const args = [
    ...teleopDeviceArgs(opts, devices, opts.useCameras),
    `--fps=${opts.fps}`,
    `--display_data=${bool(opts.displayData)}`
  ]
  return spec(resolve('lerobot-teleoperate'), args)
}

export function buildRecordCommand(
  resolve: ScriptResolver,
  opts: TeleoperateOptions,
  devices: TeleoperateResolved
): CommandSpec {
  if (!opts.datasetRepoId.trim()) throw new Error('A dataset name is required to record.')
  if (!opts.singleTask.trim()) throw new Error('A task description is required to record.')

  const args = [
    ...teleopDeviceArgs(opts, devices, opts.useCameras),
    `--dataset.repo_id=${opts.datasetRepoId}`,
    `--dataset.single_task=${opts.singleTask}`,
    `--dataset.num_episodes=${opts.numEpisodes}`,
    `--dataset.episode_time_s=${opts.episodeTimeS}`,
    `--dataset.reset_time_s=${opts.resetTimeS}`,
    `--dataset.fps=${opts.fps}`,
    `--dataset.push_to_hub=${bool(opts.pushToHub)}`,
    `--display_data=${bool(opts.displayData)}`,
    // log_say() shells out to text-to-speech otherwise, which is noise in a GUI.
    `--play_sounds=false`
  ]
  if (opts.datasetRoot.trim()) args.push(`--dataset.root=${opts.datasetRoot}`)
  // On resume, num_episodes means *additional* episodes and root is required.
  if (opts.resume) args.push('--resume=true')

  return spec(resolve('lerobot-record'), args)
}

/* ------------------------------------------------------------------ *
 * Replay                                                              *
 * ------------------------------------------------------------------ */

export function buildReplayCommand(
  resolve: ScriptResolver,
  opts: ReplayOptions,
  robot: DeviceProfile | null
): CommandSpec {
  if (!robot) throw new Error('Select the device to replay on.')
  if (!opts.repoId.trim()) throw new Error('A dataset is required to replay.')

  const args = [
    ...deviceFlags(robot),
    `--dataset.repo_id=${opts.repoId}`,
    `--dataset.episode=${opts.episode}`,
    `--play_sounds=false`
  ]
  if (opts.datasetRoot.trim()) args.push(`--dataset.root=${opts.datasetRoot}`)
  return spec(resolve('lerobot-replay'), args)
}

/* ------------------------------------------------------------------ *
 * Inference                                                           *
 * ------------------------------------------------------------------ */

/**
 * On-robot inference moved between releases: newer builds ship
 * `lerobot-rollout`, while 0.5.x runs a policy through `lerobot-record`
 * (which additionally *requires* the dataset repo_id to start with `eval_`).
 * The shape is chosen from the capability probe, never assumed.
 */
export function buildInferCommand(
  resolve: ScriptResolver,
  caps: Pick<LerobotCapabilities, 'hasRollout'>,
  opts: InferOptions,
  robot: DeviceProfile | null
): CommandSpec {
  if (!robot) throw new Error('Select the device to run the policy on.')
  if (!opts.policyPath.trim()) throw new Error('A policy path or Hugging Face repo id is required.')

  const cameraFlags = deviceFlags(robot, { includeCameras: opts.useCameras })

  if (caps.hasRollout) {
    const args = [
      '--strategy.type=base',
      `--policy.path=${opts.policyPath}`,
      ...cameraFlags,
      `--task=${opts.task}`
    ]
    if (opts.duration > 0) args.push(`--duration=${opts.duration}`)
    return spec(resolve('lerobot-rollout'), args)
  }

  const repoId = ensureEvalPrefix(opts.evalRepoId)
  const args = [
    ...cameraFlags,
    `--policy.path=${opts.policyPath}`,
    `--dataset.repo_id=${repoId}`,
    `--dataset.single_task=${opts.task}`,
    `--dataset.push_to_hub=false`,
    `--display_data=${bool(opts.displayData)}`,
    `--play_sounds=false`
  ]
  if (opts.evalDatasetRoot.trim()) args.push(`--dataset.root=${opts.evalDatasetRoot}`)
  return spec(resolve('lerobot-record'), args)
}

/** `sanity_check_dataset_name` rejects a policy run whose repo_id lacks `eval_`. */
export function ensureEvalPrefix(repoId: string): string {
  const trimmed = repoId.trim() || 'eval_policy_run'
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return trimmed.startsWith('eval_') ? trimmed : `eval_${trimmed}`
  const owner = trimmed.slice(0, slash)
  const name = trimmed.slice(slash + 1)
  return name.startsWith('eval_') ? trimmed : `${owner}/eval_${name}`
}

/* ------------------------------------------------------------------ *
 * Discovery helpers that still make sense as CLI runs                  *
 * ------------------------------------------------------------------ */

/**
 * The interactive unplug-diff flow. The bridge's `ports.list` is better for
 * populating dropdowns, but this is the reliable way to learn *which* arm is on
 * which port, so it stays available as a guided run.
 */
export function buildFindPortCommand(resolve: ScriptResolver): CommandSpec {
  return spec(resolve('lerobot-find-port'), [])
}
