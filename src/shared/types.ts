import type { ArmModel, CameraType, DeviceRole } from './devices'

/* ------------------------------------------------------------------ *
 * Device profiles                                                     *
 * ------------------------------------------------------------------ */

export interface CameraBinding {
  /** Key used in the `--robot.cameras="{ <key>: {...} }"` dict. */
  key: string
  type: CameraType
  /** OpenCV: index (macOS/Windows) or /dev/videoN path (Linux). RealSense: serial number. */
  identifier: string
  width: number
  height: number
  fps: number
  useDepth?: boolean
}

export interface DeviceProfile {
  /** Stable internal key. */
  uid: string
  /**
   * Passed as `--robot.id` / `--teleop.id` and used as the calibration
   * filename (`<calibrationDir>/<id>.json`). Must be filename-safe.
   */
  id: string
  role: DeviceRole
  model: ArmModel
  port: string
  /** Passed as `--robot.calibration_dir` / `--teleop.calibration_dir`. */
  calibrationDir: string
  cameras: CameraBinding[]
  notes?: string
}

/* ------------------------------------------------------------------ *
 * Settings                                                            *
 * ------------------------------------------------------------------ */

/** Panels laid out as a resizable two-column split. */
export type SplitPanelId = 'configure' | 'view3d' | 'teleoperate' | 'replay' | 'infer'

/** `system` follows the OS setting and keeps following it while the app runs. */
export type ThemeChoice = 'system' | 'light' | 'dark'

export interface AppSettings {
  /** Interpreter used to create the venv. */
  pythonPath: string | null
  /** Root of the virtualenv/conda env that has lerobot installed. */
  venvPath: string | null
  /** Optional lerobot source checkout, for editable installs. */
  lerobotSourcePath: string | null
  /** Default directory offered when picking a calibration file. */
  defaultCalibrationDir: string
  /** Where recorded datasets go by default (`--dataset.root`). */
  defaultDatasetRoot: string
  /** Prefer `uv` over `python -m venv` / `pip` when uv is on PATH. */
  preferUv: boolean
  /** Colour theme. Defaults to `dark`, which is what the app has always looked like. */
  theme: ThemeChoice
  /** Width in px of each panel's right column, set by dragging its splitter. */
  sidebarWidths: Record<SplitPanelId, number>
}

/* ------------------------------------------------------------------ *
 * Python environment discovery                                        *
 * ------------------------------------------------------------------ */

export interface PythonCandidate {
  path: string
  version: string
  versionTuple: [number, number, number]
  /** Inside the version window LeRobot runs in (see `pythonSupport`). */
  supported: boolean
  /** Why it is unusable — set only when `supported` is false. */
  unsupportedReason?: string
  /** Where we found it: PATH, conda, pyenv, uv, py-launcher, venv. */
  source: string
  label: string
}

export interface InstalledPackage {
  name: string
  version: string
}

/**
 * Result of probing the configured venv. Deliberately tolerant: the app must
 * work against several LeRobot releases, so anything version-dependent is
 * discovered rather than assumed.
 */
export interface LerobotCapabilities {
  ok: boolean
  error?: string
  venvPath: string
  pythonVersion: string
  lerobotVersion: string | null
  /** Console scripts actually present in the env's bin/Scripts dir. */
  scripts: string[]
  /** Newer releases ship `lerobot-rollout`; 0.5.x does on-robot eval via lerobot-record. */
  hasRollout: boolean
  hasReplay: boolean
  hasCalibrate: boolean
  hasSetupMotors: boolean
  hasTeleoperate: boolean
  hasRecord: boolean
  /** Importable python deps we rely on for the bridge. */
  hasPyserial: boolean
  hasFeetech: boolean
  hasOpencv: boolean
  hasRerun: boolean
  /**
   * Directory segment LeRobot uses under its default calibration root.
   * `so_follower` since PR #2763, `so101_follower` on older installs.
   */
  calibrationSegments: { robot: string | null; teleop: string | null }
  defaultCalibrationRoot: string | null
  /** The env's interpreter is inside LeRobot's supported version window. */
  pythonSupported: boolean
  /** Why that interpreter will not work — set only when `pythonSupported` is false. */
  pythonSupportReason?: string
}

/* ------------------------------------------------------------------ *
 * Bridge (Python sidecar) payloads                                    *
 * ------------------------------------------------------------------ */

export interface SerialPortInfo {
  device: string
  description: string
  hwid: string
  manufacturer: string | null
  serialNumber: string | null
  vid: number | null
  pid: number | null
  /** Heuristic: looks like a Feetech/USB-serial adapter rather than a pty. */
  likelyMotorBus: boolean
}

export interface CameraInfo {
  name: string
  type: string
  id: string
  backendApi?: string
  defaultStreamProfile?: {
    width?: number
    height?: number
    fps?: number
    format?: string | number
  }
}

/** One motor's live + configured state, as shown in the Configure panel. */
export interface MotorState {
  name: string
  label: string
  /** ID currently reported by / assigned on the bus. */
  id: number
  /** Raw encoder ticks, 0..4095. Null when offline. */
  position: number | null
  rangeMin: number | null
  rangeMax: number | null
  homingOffset: number | null
  driveMode: number | null
  model: string
  gearRatio: string | null
  /** True when the motor answered a ping on the bus. */
  online: boolean
}

export type BusSource = 'live' | 'calibration-file' | 'defaults'

export interface BusSnapshot {
  source: BusSource
  connected: boolean
  port: string | null
  baudrate: number | null
  motors: MotorState[]
  /** Populated when source === 'calibration-file'. */
  calibrationPath?: string
  warning?: string
}

export interface MotorIdWriteRequest {
  /** ID to write. */
  toId: number
  /** ID the motor answers to today. Defaults to the profile's ID for `motor`. */
  fromId?: number
  /** Profile motor name, when the write targets one. */
  motor?: string
  /** Serial port, so the write works with no bus session open. */
  port?: string
  /** Waive the same-ID and already-taken refusals. */
  force?: boolean
}

export interface BusPresence {
  port: string | null
  baudrate: number
  /** IDs that answered a ping and a model-number read. */
  ids: number[]
  /** `{ id: modelNumber }`, keyed as strings because it crosses JSON. */
  models: Record<string, number>
}

export interface MotorIdWriteResult {
  motor: string | null
  fromId: number
  toId: number
  forced: boolean
  /** The new ID answered a ping after the write. */
  verified: boolean
  presentBefore: number[]
  presentAfter: number[]
  /** Everything that was overridden or looked wrong but did not stop the write. */
  warnings: string[]
  motorIds: Record<string, number>
}

/* ------------------------------------------------------------------ *
 * Motion test                                                         *
 * ------------------------------------------------------------------ */

export type MotionTestPhase =
  | 'countdown'
  | 'centering'
  | 'settle'
  | 'joint'
  | 'homing'
  | 'done'
  | 'cancelled'
  | 'error'

/** Progress frames the bridge pushes while a motion test runs. */
export interface MotionTestFrame {
  phase: MotionTestPhase
  /** countdown: seconds left before the arm moves. */
  remaining?: number
  /** settle: length of the pause. */
  seconds?: number
  /** joint: whose turn it is. Differs from `motor` inside a paired plan. */
  group?: string
  /** joint: which joint is actually moving, and where to. */
  motor?: string
  target?: 'min' | 'max' | 'mid'
  position?: number
  index?: number
  total?: number
  /** cancelled: whether the arm had already started moving. */
  moved?: boolean
  /** error: what went wrong. */
  message?: string
  home?: Record<string, number>
}

export interface MotionTestStart {
  started: boolean
  /** Where the arm was when the button was pressed; it returns here at the end. */
  home: Record<string, number>
  limits: Record<string, { min: number; max: number }>
  countdownS: number
}

/* ------------------------------------------------------------------ *
 * Auto-calibration                                                    *
 * ------------------------------------------------------------------ */

export type AutoCalPhase =
  | 'preparing'
  | 'seeking'
  | 'found'
  | 'moving'
  | 'writing'
  | 'parking'
  | 'done'
  | 'cancelled'
  | 'error'

export interface AutoCalFrame {
  phase: AutoCalPhase
  /** Whose turn it is; differs from `motor` inside the paired plan. */
  group?: string
  motor?: string
  /** `mid` only ever appears on a `moving` frame; a search is min or max. */
  target?: 'min' | 'max' | 'mid'
  /** found: the tick the motor reported when it stopped moving. */
  position?: number
  /** found: how far the joint actually travelled to get there. */
  travel?: number
  index?: number
  total?: number
  message?: string
  /** preparing / writing: the joints being measured. */
  motors?: string[]
  /** cancelled / error: the previous limits were put back. */
  restored?: boolean
  /** done: what was discovered, and written to the motors. */
  ranges?: Record<string, { min: number; max: number }>
  /** done: whether the arm reached its park pose, or was stopped on the way. */
  parked?: boolean
  startPose?: Record<string, number>
}

export interface AutoCalStart {
  started: boolean
  /** The mid pose the user set by hand before pressing Continue. */
  startPose: Record<string, number>
  /** Joints this run measures; the rest keep the limits they already hold. */
  measures: string[]
  /** Limits the motors held beforehand, restored if the run does not finish. */
  previous: Record<string, { min: number; max: number }>
}

export interface ScanResult {
  /** `{ baudrate: [motorId, ...] }` — from FeetechMotorsBus.scan_port. */
  found: Record<string, number[]>
}

export interface CalibrationEntry {
  id: number
  drive_mode: number
  homing_offset: number
  range_min: number
  range_max: number
}

/** The on-disk calibration file: dict[motor_name, MotorCalibration]. */
export type CalibrationFile = Record<string, CalibrationEntry>

/* ------------------------------------------------------------------ *
 * Process runs                                                        *
 * ------------------------------------------------------------------ */

export type RunKind =
  | 'calibrate'
  | 'setup-motors'
  | 'teleoperate'
  | 'record'
  | 'replay'
  | 'infer'
  | 'install'
  | 'venv'
  | 'pip-list'

export type RunStatus = 'starting' | 'running' | 'paused' | 'exited' | 'failed'

export interface RunInfo {
  runId: string
  kind: RunKind
  /** argv[0] plus args, for display and for the "copy command" button. */
  command: string
  status: RunStatus
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** Set when the child is blocked on an interactive prompt. */
  prompt: PromptInfo | null
  canPause: boolean
}

export interface PromptInfo {
  /** Raw prompt text matched from the child's output. */
  raw: string
  /** Plain-language instruction for the user. */
  title: string
  detail: string
  /** Choices to offer; each sends `send` to the child's stdin. */
  choices: { label: string; send: string; primary?: boolean }[]
}

export interface RunOutputChunk {
  runId: string
  data: string
}

/* ------------------------------------------------------------------ *
 * Command specs — built in main, previewed in the renderer            *
 * ------------------------------------------------------------------ */

export interface CommandSpec {
  /** Absolute path to the executable (a venv console script or python). */
  file: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** Shell-quoted, for display/copy only. Never executed. */
  display: string
}

export interface TeleoperateOptions {
  setup: 'single' | 'dual'
  /** Single setup. */
  robotUid: string | null
  leaderUid: string | null
  /** Dual setup — left/right pairs. */
  leftRobotUid: string | null
  rightRobotUid: string | null
  leftLeaderUid: string | null
  rightLeaderUid: string | null
  /** Shared id for the bimanual device (children become `<id>_left` / `_right`). */
  bimanualRobotId: string
  bimanualLeaderId: string
  fps: number
  displayData: boolean
  useCameras: boolean
  record: boolean
  datasetRepoId: string
  datasetRoot: string
  singleTask: string
  numEpisodes: number
  episodeTimeS: number
  resetTimeS: number
  pushToHub: boolean
  resume: boolean
}

export interface ReplayOptions {
  robotUid: string | null
  /** Dataset root directory the user browsed to. */
  datasetRoot: string
  repoId: string
  episode: number
  fps: number | null
}

export interface InferOptions {
  robotUid: string | null
  policyPath: string
  task: string
  duration: number
  useCameras: boolean
  displayData: boolean
  /** Only used on the lerobot-record fallback path. */
  evalRepoId: string
  evalDatasetRoot: string
}

export interface DatasetMeta {
  root: string
  repoId: string
  fps: number | null
  totalEpisodes: number | null
  totalFrames: number | null
  robotType: string | null
  episodes: number[]
  warning?: string
}

/* ------------------------------------------------------------------ *
 * IPC surface                                                         *
 * ------------------------------------------------------------------ */

/** Host facts the renderer needs to shape its UI. */
export interface AppInfo {
  platform: string
  /** node-pty loaded. Without it, record's arrow-key episode controls do not work. */
  ptyAvailable: boolean
  ptyError: string | null
  defaultCalibrationDir: string
  /** Pause uses SIGSTOP, which Windows has no equivalent for. */
  canPause: boolean
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface Ok<T> {
  ok: true
  value: T
}
export interface Err {
  ok: false
  error: string
  detail?: string
}
export type Result<T> = Ok<T> | Err
