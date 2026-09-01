/**
 * Device tables mirrored from LeRobot.
 *
 * The motor dict order in `so_follower.py` / `so_leader.py` drives everything
 * downstream: observation keys, action keys, calibration JSON key order and the
 * reverse order used by `lerobot-setup-motors`. Keep this list in that order.
 *
 * Ref: lerobot/src/lerobot/robots/so_follower/so_follower.py:51-62
 *      lerobot/src/lerobot/teleoperators/so_leader/so_leader.py:43-54
 */

export type DeviceRole = 'robot' | 'teleop'
export type ArmModel = 'SO100' | 'SO101'

export type MotorNormMode = 'degrees' | 'range_m100_100' | 'range_0_100'

export interface MotorSpec {
  /** Motor name, exactly as LeRobot keys it. */
  name: string
  /** Human label for the UI. */
  label: string
  /** Factory motor ID on the bus. */
  defaultId: number
  /** Feetech model string. */
  model: string
  normMode: MotorNormMode
}

/** Encoder resolution for sts3215 — MODEL_RESOLUTION in feetech/tables.py:186. */
export const STS3215_RESOLUTION = 4096
export const STS3215_MAX_TICK = STS3215_RESOLUTION - 1

/** DEFAULT_BAUDRATE in feetech/feetech.py:44. */
export const FEETECH_DEFAULT_BAUDRATE = 1_000_000

/** Highest assignable Feetech motor ID. */
export const MAX_MOTOR_ID = 253

export interface MotorIdWriteCheck {
  /** Rejected outright — forcing cannot help. */
  invalid: boolean
  /** Refused unless the write is forced. */
  needsForce: boolean
  reason: string | null
}

/**
 * Judge a motor-ID write before it goes out.
 *
 * Mirrors the refusals in the bridge's `BusSession.write_id`, so the UI can
 * explain what would be rejected — and offer the force override — without a
 * round trip. The bridge still re-checks against what is physically on the bus;
 * this only knows what the app has on screen.
 */
export function checkMotorIdWrite(opts: {
  toId: number
  fromId: number
  /** Label of another motor already holding `toId`, when there is one. */
  takenBy?: string | null
}): MotorIdWriteCheck {
  const { toId, fromId, takenBy } = opts
  if (!Number.isInteger(toId) || toId < 0 || toId > MAX_MOTOR_ID) {
    return {
      invalid: true,
      needsForce: false,
      reason: `Must be a whole number between 0 and ${MAX_MOTOR_ID}.`
    }
  }
  if (toId === fromId) {
    return { invalid: false, needsForce: true, reason: `This motor already has ID ${toId}.` }
  }
  if (takenBy) {
    return {
      invalid: false,
      needsForce: true,
      reason: `ID ${toId} is already used by ${takenBy}. Both would answer to it until that one is moved too.`
    }
  }
  return { invalid: false, needsForce: false, reason: null }
}

/**
 * SO-100 and SO-101 share this table verbatim; only the physical gear ratios
 * differ, which is why the model selector changes labels/diagram but not the
 * motor list.
 */
export const SO_ARM_MOTORS: readonly MotorSpec[] = [
  { name: 'shoulder_pan', label: 'Shoulder Pan', defaultId: 1, model: 'sts3215', normMode: 'degrees' },
  { name: 'shoulder_lift', label: 'Shoulder Lift', defaultId: 2, model: 'sts3215', normMode: 'degrees' },
  { name: 'elbow_flex', label: 'Elbow Flex', defaultId: 3, model: 'sts3215', normMode: 'degrees' },
  { name: 'wrist_flex', label: 'Wrist Flex', defaultId: 4, model: 'sts3215', normMode: 'degrees' },
  { name: 'wrist_roll', label: 'Wrist Roll', defaultId: 5, model: 'sts3215', normMode: 'degrees' },
  { name: 'gripper', label: 'Gripper', defaultId: 6, model: 'sts3215', normMode: 'range_0_100' }
] as const

export const MOTOR_NAMES: readonly string[] = SO_ARM_MOTORS.map((m) => m.name)

/**
 * Gear ratios, shown as read-only info in the Configure panel.
 * SO-101 leader mixes three gearings — docs/source/so101.mdx:34-45.
 */
export const GEAR_RATIOS: Record<ArmModel, Record<DeviceRole, Record<string, string>>> = {
  SO101: {
    robot: {
      shoulder_pan: '1/345',
      shoulder_lift: '1/345',
      elbow_flex: '1/345',
      wrist_flex: '1/345',
      wrist_roll: '1/345',
      gripper: '1/345'
    },
    teleop: {
      shoulder_pan: '1/191',
      shoulder_lift: '1/345',
      elbow_flex: '1/191',
      wrist_flex: '1/147',
      wrist_roll: '1/147',
      gripper: '1/147'
    }
  },
  SO100: {
    robot: {
      shoulder_pan: '1/345',
      shoulder_lift: '1/345',
      elbow_flex: '1/345',
      wrist_flex: '1/345',
      wrist_roll: '1/345',
      gripper: '1/345'
    },
    teleop: {
      shoulder_pan: '1/345',
      shoulder_lift: '1/345',
      elbow_flex: '1/345',
      wrist_flex: '1/345',
      wrist_roll: '1/345',
      gripper: '1/345'
    }
  }
}

/** The string passed to `--robot.type=` / `--teleop.type=`. */
export function lerobotDeviceType(model: ArmModel, role: DeviceRole): string {
  const suffix = role === 'robot' ? 'follower' : 'leader'
  return `${model.toLowerCase()}_${suffix}`
}

/** Bimanual variants — `bi_so_follower` / `bi_so_leader`. */
export function lerobotBimanualType(role: DeviceRole): string {
  return role === 'robot' ? 'bi_so_follower' : 'bi_so_leader'
}

/** The draccus flag namespace: robots use `--robot.*`, teleoperators `--teleop.*`. */
export function flagNamespace(role: DeviceRole): 'robot' | 'teleop' {
  return role === 'robot' ? 'robot' : 'teleop'
}

export const CAMERA_TYPES = ['opencv', 'intelrealsense'] as const
export type CameraType = (typeof CAMERA_TYPES)[number]

export const COMMON_RESOLUTIONS = [
  { width: 640, height: 480 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 }
]

export const COMMON_FPS = [15, 30, 60]

/** Minimum Python version current LeRobot supports (docs: Installation, Step 2). */
export const MIN_PYTHON = { major: 3, minor: 12 }

/**
 * Highest Python minor LeRobot's CLI is known to start on.
 *
 * Python 3.14 made `X | None` a `typing.Union` instance, which is not callable.
 * draccus — LeRobot's config parser, pinned to `>=0.11.6,<0.12` — hands a
 * field's annotation straight to `argparse.add_argument(type=...)`, and 3.14's
 * argparse rejects a non-callable type. Every command with an optional field
 * therefore dies before it does any work:
 *   TypeError: str | None is not callable
 * On 3.13 and older draccus first canonicalises the union to
 * `typing.Optional[str]`, which is callable, so the same code parses fine.
 * Lift this cap once draccus ships a 3.14 fix.
 */
export const MAX_PYTHON = { major: 3, minor: 13 }

const fmt = (v: { major: number; minor: number }): string => `${v.major}.${v.minor}`

/** Human-readable version window, e.g. "3.12–3.13". */
export const PYTHON_RANGE = `${fmt(MIN_PYTHON)}–${fmt(MAX_PYTHON)}`

export interface PythonSupport {
  supported: boolean
  /** Why the interpreter is unusable; null when it is fine. */
  reason: string | null
}

/** Judge an interpreter against the version window LeRobot actually runs in. */
export function pythonSupport(version: readonly [number, number, number]): PythonSupport {
  const [major, minor] = version
  if (major < MIN_PYTHON.major || (major === MIN_PYTHON.major && minor < MIN_PYTHON.minor)) {
    return { supported: false, reason: `too old — LeRobot needs Python ${PYTHON_RANGE}` }
  }
  if (major > MAX_PYTHON.major || (major === MAX_PYTHON.major && minor > MAX_PYTHON.minor)) {
    return {
      supported: false,
      reason: `too new — LeRobot's command-line parser cannot start on ${major}.${minor}; use Python ${PYTHON_RANGE}`
    }
  }
  return { supported: true, reason: null }
}
