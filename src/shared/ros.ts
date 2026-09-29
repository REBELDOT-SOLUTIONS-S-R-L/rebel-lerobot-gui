/**
 * ROS 2 telemetry: what the app publishes, and how a motor reading becomes a
 * ROS message.
 *
 * The app talks to ROS through rosbridge — JSON over a websocket — so nothing
 * ROS has to be installed next to it, and it runs the same on every OS. The
 * messages are standard types, laid out the way ROS tools already expect, so a
 * visualizer, a simulator or a digital twin can subscribe without knowing this
 * app exists:
 *
 *   /<ns>/joint_states       sensor_msgs/JointState    every position frame
 *   /<ns>/joint_command      sensor_msgs/JointState    every goal the app writes
 *   /<ns>/robot_description  std_msgs/String, latched  the URDF, once
 *   /<ns>/diagnostics        diagnostic_msgs/DiagnosticArray, 1 Hz
 *   /<ns>/session            std_msgs/String (JSON), latched
 *
 * `<ns>` is the device profile's name made into a valid ROS name. Joint names
 * are the URDF's, which are LeRobot's motor names, and angles are the URDF's
 * radians — the same conversion the 3D view poses its model with, so what ROS
 * sees and what the app draws cannot disagree.
 *
 * Pure: the websocket lives in the main process, this only builds frames.
 */

import type { ArmModel } from './devices'
import type { MotorTelemetry } from './feetech'
import type { TickRange } from './normalize'
import { jointAngleRad, jointTuning, type SimManifest } from './sim'

/* ------------------------------------------------------------------ *
 * Topics                                                              *
 * ------------------------------------------------------------------ */

export const ROS_TOPICS = {
  jointStates: { name: 'joint_states', type: 'sensor_msgs/msg/JointState', latch: false },
  jointCommand: { name: 'joint_command', type: 'sensor_msgs/msg/JointState', latch: false },
  robotDescription: { name: 'robot_description', type: 'std_msgs/msg/String', latch: true },
  diagnostics: { name: 'diagnostics', type: 'diagnostic_msgs/msg/DiagnosticArray', latch: false },
  session: { name: 'session', type: 'std_msgs/msg/String', latch: true }
} as const

export type RosTopicKey = keyof typeof ROS_TOPICS

export const DEFAULT_ROSBRIDGE_URL = 'ws://localhost:9090'

/** How often motor health goes out. Temperatures do not change faster than this. */
export const DIAGNOSTICS_HZ = 1

/**
 * A device name made into a ROS namespace.
 *
 * ROS names are `[A-Za-z0-9_]` tokens that must not start with a digit and must
 * not contain `__` — profile names are filename-safe, which is looser. Anything
 * else becomes `_`, so `my-follower` publishes under `/my_follower`.
 */
export function rosNamespace(id: string): string {
  let name = id
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!name) name = 'arm'
  if (/^[0-9]/.test(name)) name = `arm_${name}`
  return name
}

export function topicPath(namespace: string, key: RosTopicKey): string {
  return `/${namespace}/${ROS_TOPICS[key].name}`
}

/* ------------------------------------------------------------------ *
 * Sessions                                                            *
 * ------------------------------------------------------------------ */

/** What is driving the arm, so a twin can tell a person from a policy. */
export type RosSessionMode = 'control' | 'teleoperate' | 'replay' | 'calibrate' | 'monitor'

/** A panel asking for one device to be published while it drives it. */
export interface RosAttachRequest {
  uid: string
  mode: RosSessionMode
  /** Calibrated ranges from the panel's snapshot; ticks mean nothing without them. */
  ranges: Record<string, TickRange>
}

export type RosConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

export interface RosSessionStatus {
  uid: string
  namespace: string
  mode: RosSessionMode
  /** joint_states messages per second, over the last couple of seconds. */
  rate: number
}

export interface RosStatus {
  state: RosConnectionState
  url: string
  /** Why the last attempt failed; null once connected. */
  error: string | null
  sessions: RosSessionStatus[]
}

/* ------------------------------------------------------------------ *
 * Messages                                                            *
 * ------------------------------------------------------------------ */

export interface RosTime {
  sec: number
  nanosec: number
}

export interface RosHeader {
  stamp: RosTime
  frame_id: string
}

export interface JointStateMsg {
  header: RosHeader
  name: string[]
  position: number[]
  velocity: number[]
  effort: number[]
}

export interface DiagnosticStatusMsg {
  level: number
  name: string
  message: string
  hardware_id: string
  values: { key: string; value: string }[]
}

export interface DiagnosticArrayMsg {
  header: RosHeader
  status: DiagnosticStatusMsg[]
}

/** DiagnosticStatus levels. */
export const DIAG_OK = 0
export const DIAG_WARN = 1
export const DIAG_ERROR = 2
export const DIAG_STALE = 3

/** Wall-clock milliseconds as a ROS time. The app has no ROS clock to follow. */
export function rosTime(ms: number): RosTime {
  const sec = Math.floor(ms / 1000)
  return { sec, nanosec: Math.round((ms - sec * 1000) * 1e6) }
}

function header(ms: number): RosHeader {
  return { stamp: rosTime(ms), frame_id: '' }
}

/**
 * Joint angles for one set of ticks, in the URDF's radians.
 *
 * Joints with no reading or no calibrated range are left out rather than
 * reported at a made-up angle: `jointAngleRad` falls back to the rest pose for
 * the 3D view, which is right for a picture and wrong for a subscriber that
 * would take it as a measurement.
 */
export function jointStateMsg(
  manifest: SimManifest,
  model: ArmModel,
  ticks: Record<string, number>,
  ranges: Record<string, TickRange>,
  ms: number
): JointStateMsg {
  const name: string[] = []
  const position: number[] = []
  for (const joint of manifest.joints) {
    const tick = ticks[joint.name]
    const range = ranges[joint.name]
    if (typeof tick !== 'number' || !range || range.max <= range.min) continue
    name.push(joint.name)
    position.push(
      jointAngleRad(
        joint,
        { position: tick, rangeMin: range.min, rangeMax: range.max },
        jointTuning(model, joint.name)
      )
    )
  }
  return { header: header(ms), name, position, velocity: [], effort: [] }
}

/** Above this a Feetech servo is getting hot enough to be worth a look. */
const TEMP_WARN_C = 55
/** And above this it is about to protect itself by dropping torque. */
const TEMP_ERROR_C = 65

/** `Status` register bits, as the STS3215 manual names them. */
const STATUS_BITS: [number, string][] = [
  [0x01, 'voltage'],
  [0x02, 'sensor'],
  [0x04, 'temperature'],
  [0x08, 'current'],
  [0x20, 'overload']
]

/**
 * One DiagnosticStatus per motor, named `<ns>/<motor>`.
 *
 * Values are converted out of the register units (`@shared/feetech`) so a
 * monitor can show them as they are. A motor with no readings is STALE — it did
 * not answer, which is different from answering with a problem.
 */
export function diagnosticsMsg(
  namespace: string,
  motors: Record<string, Partial<MotorTelemetry> | undefined>,
  ms: number
): DiagnosticArrayMsg {
  const status: DiagnosticStatusMsg[] = []
  for (const [motor, t] of Object.entries(motors)) {
    const values: { key: string; value: string }[] = []
    const put = (key: string, value: number | null | undefined, scale = 1, digits = 0): void => {
      if (value === null || value === undefined) return
      values.push({ key, value: (value * scale).toFixed(digits) })
    }
    put('temperature_c', t?.temperature)
    put('voltage_v', t?.voltage, 0.1, 1)
    put('load_percent', t?.load, 0.1, 1)
    put('current_ma', t?.current, 6.5, 0)
    if (t?.status !== null && t?.status !== undefined) values.push({ key: 'status', value: String(t.status) })

    let level = DIAG_OK
    const problems: string[] = []
    if (values.length === 0) {
      level = DIAG_STALE
      problems.push('no reading')
    }
    const faults = STATUS_BITS.filter(([bit]) => ((t?.status ?? 0) & bit) !== 0).map(([, label]) => label)
    if (faults.length > 0) {
      level = DIAG_ERROR
      problems.push(`fault: ${faults.join(', ')}`)
    }
    const temp = t?.temperature
    if (typeof temp === 'number' && temp >= TEMP_ERROR_C) {
      level = DIAG_ERROR
      problems.push(`${temp} °C`)
    } else if (typeof temp === 'number' && temp >= TEMP_WARN_C) {
      level = Math.max(level, DIAG_WARN)
      problems.push(`${temp} °C`)
    }

    status.push({
      level,
      name: `${namespace}/${motor}`,
      message: problems.length > 0 ? problems.join('; ') : 'OK',
      hardware_id: namespace,
      values
    })
  }
  return { header: header(ms), status }
}

/**
 * The URDF with every mesh pointing at an absolute `file://` URL.
 *
 * The URDFs in the assets folder name their meshes relative to themselves,
 * which no subscriber can resolve. An absolute file URL works for RViz and
 * Foxglove on the same machine; a remote one needs the meshes served to it.
 */
export function urdfWithAbsoluteMeshes(urdf: string, urdfDir: string): string {
  const base = urdfDir.replace(/\\/g, '/').replace(/\/$/, '')
  const root = base.startsWith('/') ? `file://${base}` : `file:///${base}`
  return urdf.replace(/(<mesh\b[^>]*\bfilename=")([^"]+)(")/g, (whole, open, file: string, close) =>
    /^[a-z]+:\/\//i.test(file) || file.startsWith('/') ? whole : `${open}${root}/${file}${close}`
  )
}

/* ------------------------------------------------------------------ *
 * rosbridge protocol v2                                               *
 * ------------------------------------------------------------------ */

export type RosbridgeOp =
  | { op: 'advertise'; topic: string; type: string; latch?: boolean; queue_size?: number }
  | { op: 'unadvertise'; topic: string }
  | { op: 'publish'; topic: string; msg: unknown }

export function advertiseOp(topic: string, key: RosTopicKey): RosbridgeOp {
  const spec = ROS_TOPICS[key]
  return spec.latch
    ? { op: 'advertise', topic, type: spec.type, latch: true }
    : { op: 'advertise', topic, type: spec.type, queue_size: 10 }
}
