/**
 * The teleoperation rig: one or two arms the app drives itself, and what it
 * records from them.
 *
 * A setup is a list of sides. Single has one; dual has a left and a right, and
 * each side picks its own controller, arms and camera. The Python sidecar runs
 * the loop for whatever is real hardware — reading leaders, writing followers,
 * grabbing camera frames — and writes the dataset with LeRobot's own writer, so
 * a recording is the same format `lerobot-record` produces. The keyboard,
 * gamepad and virtual arm stay in the app and feed the same loop.
 *
 * Pure: the types and rules every process agrees on.
 */

import type {
  BusSnapshot,
  CameraBinding,
  DeviceProfile,
  TeleopController,
  TeleoperateOptions
} from './types'
import { isVirtual } from './virtual'

export type RigSideId = 'single' | 'left' | 'right'

/** One side of a setup, read out of the panel's options. */
export interface TeleopSideSpec {
  side: RigSideId
  controller: TeleopController
  robotUid: string | null
  leaderUid: string | null
  cameraKey: string | null
  showCamera: boolean
}

/** Distance between the two arms' bases in the 3D view, in centimetres. */
export const ARM_SPACING_CM = { min: 10, max: 80, default: 30 } as const

/** The sides a setup is made of, in left-to-right order. */
export function teleopSides(opts: TeleoperateOptions): TeleopSideSpec[] {
  if (opts.setup === 'single') {
    return [
      {
        side: 'single',
        controller: opts.controller,
        robotUid: opts.robotUid,
        leaderUid: opts.leaderUid,
        cameraKey: opts.cameraKey,
        showCamera: opts.showCamera
      }
    ]
  }
  return [
    {
      side: 'left',
      controller: opts.leftController,
      robotUid: opts.leftRobotUid,
      leaderUid: opts.leftLeaderUid,
      cameraKey: opts.leftCameraKey,
      showCamera: opts.leftShowCamera
    },
    {
      side: 'right',
      controller: opts.rightController,
      robotUid: opts.rightRobotUid,
      leaderUid: opts.rightLeaderUid,
      cameraKey: opts.rightCameraKey,
      showCamera: opts.rightShowCamera
    }
  ]
}

/** The option keys that hold one side's fields, so a side can be edited by name. */
export const SIDE_FIELDS = {
  single: {
    controller: 'controller',
    robotUid: 'robotUid',
    leaderUid: 'leaderUid',
    cameraKey: 'cameraKey',
    showCamera: 'showCamera'
  },
  left: {
    controller: 'leftController',
    robotUid: 'leftRobotUid',
    leaderUid: 'leftLeaderUid',
    cameraKey: 'leftCameraKey',
    showCamera: 'leftShowCamera'
  },
  right: {
    controller: 'rightController',
    robotUid: 'rightRobotUid',
    leaderUid: 'rightLeaderUid',
    cameraKey: 'rightCameraKey',
    showCamera: 'rightShowCamera'
  }
} as const satisfies Record<RigSideId, Record<Exclude<keyof TeleopSideSpec, 'side'>, keyof TeleoperateOptions>>

export function sideLabel(side: RigSideId): string {
  return side === 'single' ? 'Arm' : side === 'left' ? 'Left' : 'Right'
}

/**
 * What a side's features are called in the dataset.
 *
 * LeRobot's bimanual robots prefix every key with the arm's side
 * (`left_shoulder_pan.pos`, `right_front`), and a single arm uses none. Matching
 * that is what lets a policy trained on either kind of recording run on the
 * other's hardware.
 */
export function sidePrefix(side: RigSideId): string {
  return side === 'single' ? '' : `${side}_`
}

/**
 * Which gamepad a side reads, by connection order.
 *
 * The first side that uses a gamepad gets the first pad, the next one the
 * second — so one pad in a mixed setup is always pad 0, wherever it is used.
 */
export function gamepadIndex(sides: readonly TeleopSideSpec[], side: RigSideId): number {
  const pads = sides.filter((s) => s.controller === 'gamepad')
  return Math.max(0, pads.findIndex((s) => s.side === side))
}

/** Why a setup cannot be driven by the app yet, or null when it can. */
export function validateSides(sides: readonly TeleopSideSpec[]): string | null {
  for (const s of sides) {
    const name = s.side === 'single' ? '' : `${sideLabel(s.side)}: `
    if (!s.robotUid) return `${name}select the follower arm.`
    if (s.controller === 'leader' && !s.leaderUid) return `${name}select the leader arm.`
  }
  const robots = sides.map((s) => s.robotUid)
  if (new Set(robots).size !== robots.length) return 'Pick a different follower for each side.'
  const leaders = sides.filter((s) => s.controller === 'leader').map((s) => s.leaderUid)
  if (new Set(leaders).size !== leaders.length) return 'Pick a different leader for each side.'
  if (sides.filter((s) => s.controller === 'keyboard').length > 1) {
    return 'The keyboard can drive only one side. Give the other a gamepad or a leader arm.'
  }
  return null
}

/**
 * Why a setup cannot be handed to `lerobot-teleoperate`, or null when it can.
 *
 * LeRobot's own commands drive real arms from real leaders, the same controller
 * on both sides of a pair; everything else is the app's.
 */
export function lerobotUnsupported(sides: readonly TeleopSideSpec[]): string | null {
  if (sides.some((s) => s.controller !== 'leader')) {
    return 'LeRobot commands only drive followers from leader arms.'
  }
  if (sides.some((s) => isVirtual(s.robotUid))) {
    return 'LeRobot has no device for the virtual arm.'
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Messages between the panel, the main process and the sidecar        *
 * ------------------------------------------------------------------ */

/** Calibrated range of one motor, as the sidecar reports and the panel needs. */
export interface RigMotorRange {
  min: number
  max: number
  driveMode?: number | null
}

export interface RigStartRequest {
  setup: TeleoperateOptions['setup']
  fps: number
  sides: TeleopSideSpec[]
}

/** One side of a running rig, as the panel needs it to draw and drive. */
export interface RigSideInfo {
  side: RigSideId
  robotUid: string
  leaderUid: string | null
  simulated: boolean
  /** Snapshot of the follower: positions and calibrated ranges. */
  follower: BusSnapshot
  /** Snapshot of the leader, when one drives this side. */
  leader: BusSnapshot | null
}

export interface RigStartResult {
  sides: RigSideInfo[]
  /** Recording needs the sidecar, which needs the Python environment. */
  canRecord: boolean
  /** Why it cannot, when it cannot. */
  recordReason: string | null
}

/** Positions from one tick of the loop, raw encoder ticks. */
export interface RigFrame {
  side: RigSideId
  follower?: Record<string, number>
  leader?: Record<string, number>
}

export interface RecordRequest {
  repoId: string
  /** Folder datasets live in; this one is written to `<root>/<repoId>`. */
  root: string
  task: string
}

export type RecordPhase = 'idle' | 'recording' | 'saving'

export interface RigStatus {
  running: boolean
  phase: RecordPhase
  /** Episodes in the open dataset, including any saved this session. */
  episodes: number
  /** Frames in the episode being recorded. */
  frames: number
  /** Where the open dataset is on disk. */
  datasetPath: string | null
  error: string | null
}

export const IDLE_RIG_STATUS: RigStatus = {
  running: false,
  phase: 'idle',
  episodes: 0,
  frames: 0,
  datasetPath: null,
  error: null
}

/** A camera preview frame, pushed by the sidecar while a feed is shown. */
export interface CameraFrame {
  /**
   * Which preview this is. Not `id`: on the sidecar's wire that field marks a
   * reply to a request, and a frame carrying one would be taken for a reply.
   */
  preview: string
  /** JPEG, base64. */
  jpeg: string
  width: number
  height: number
}

/** The camera a side has chosen, looked up on its follower's profile. */
export function sideCamera(profile: DeviceProfile | null | undefined, key: string | null): CameraBinding | null {
  if (!profile || !key) return null
  return profile.cameras.find((c) => c.key === key) ?? null
}
