/**
 * Keyboard and gamepad control of the end effector.
 *
 * A leader arm hands over a whole pose, joint by joint. A keyboard and a gamepad
 * only have axes, so they drive the tool instead: six of them for where the tool
 * is and which way it points, plus the jaws. Inverse kinematics turns that back
 * into joint angles (`@shared/kinematics`), which is the only reason a five-joint
 * arm can be flown this way at all.
 *
 * Everything here is a pure function of which keys are down or where the sticks
 * are, so the mapping is testable without a browser and the panel can render the
 * same table it obeys. Rates come out in -1..1; the speeds they scale are at the
 * bottom of this file.
 */

import type { TeleopController } from './types'
import { isVirtual } from './virtual'

/**
 * Whether the app drives this run itself, instead of starting a LeRobot process.
 *
 * `lerobot-teleoperate` is the right tool for a leader driving a real follower
 * and nothing here replaces it. It cannot help with the other two cases: it has
 * no device for the virtual arm, and its keyboard and gamepad teleoperators emit
 * three-axis position deltas that nothing in the shipped release turns into
 * joint angles. Both are then run from here — read a pose or a command, solve,
 * write goals — which is also why recording is only offered on the CLI path.
 */
export function drivenInApp(opts: {
  controller: TeleopController
  robotUid: string | null
}): boolean {
  return opts.controller !== 'leader' || isVirtual(opts.robotUid)
}

/** The tool's six degrees of freedom, in the order the UI lists them. */
export const EE_AXES = ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const

export type EeAxis = (typeof EE_AXES)[number]

/**
 * One frame of command. Each axis is a rate, not a position: hold a key and the
 * tool keeps going, let go and it stops where it is.
 */
export interface EeCommand {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
  /** -1 closes the jaws, +1 opens them. */
  gripper: number
  /** Precision modifier — everything moves at `EE_FINE_SCALE`. */
  fine: boolean
}

export const IDLE_COMMAND: EeCommand = {
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  gripper: 0,
  fine: false
}

/** Nothing is being asked for, so there is nothing to send. */
export function isIdle(command: EeCommand): boolean {
  return (
    command.gripper === 0 && EE_AXES.every((axis) => command[axis] === 0)
  )
}

/**
 * What each axis means, in the arm's own base frame.
 *
 * Translation is in the base frame, so "forward" stays forward however the wrist
 * is turned. Rotation is in the tool frame, so a roll is a roll of the jaws
 * rather than of the room — the split `lerobot`'s own end-effector pipeline uses
 * (`EEReferenceAndDelta` in `robots/so_follower/robot_kinematic_processor.py`).
 */
export const AXIS_LABELS: Record<EeAxis, { short: string; sense: string }> = {
  x: { short: 'X', sense: 'forward, away from the base' },
  y: { short: 'Y', sense: "to the arm's left" },
  z: { short: 'Z', sense: 'up' },
  rx: { short: 'RX', sense: 'roll the jaws clockwise' },
  ry: { short: 'RY', sense: 'pitch the jaws up' },
  rz: { short: 'RZ', sense: 'yaw the jaws left' }
}

/* ------------------------------------------------------------------ *
 * Keyboard                                                            *
 * ------------------------------------------------------------------ */

export interface KeyBinding {
  target: EeAxis | 'gripper'
  /** `KeyboardEvent.code` values, so the layout under the keycaps is irrelevant. */
  positive: readonly string[]
  negative: readonly string[]
  /** What the positive direction does, for the on-screen legend. */
  sense: string
}

/**
 * Two hands: the left one flies the tool around, the right one turns it.
 *
 * Arrow and page keys are aliases for the translation axes because they are the
 * first thing anyone tries. `KeyboardEvent.code` throughout, so the same
 * physical keys work on a non-QWERTY layout.
 */
export const KEYBOARD_BINDINGS: readonly KeyBinding[] = [
  {
    target: 'x',
    positive: ['KeyW', 'ArrowUp'],
    negative: ['KeyS', 'ArrowDown'],
    sense: 'forward / back'
  },
  {
    target: 'y',
    positive: ['KeyA', 'ArrowLeft'],
    negative: ['KeyD', 'ArrowRight'],
    sense: 'left / right'
  },
  { target: 'z', positive: ['KeyR', 'PageUp'], negative: ['KeyF', 'PageDown'], sense: 'up / down' },
  { target: 'rx', positive: ['KeyI'], negative: ['KeyK'], sense: 'roll' },
  { target: 'ry', positive: ['KeyJ'], negative: ['KeyL'], sense: 'pitch' },
  { target: 'rz', positive: ['KeyU'], negative: ['KeyO'], sense: 'yaw' },
  { target: 'gripper', positive: ['Period'], negative: ['Comma'], sense: 'open / close jaws' }
] as const

/** Held down, everything crawls — for the last millimetre onto an object. */
export const FINE_KEYS: readonly string[] = ['ShiftLeft', 'ShiftRight']

/** Drive every joint back to the middle of its range. */
export const HOME_KEYS: readonly string[] = ['Digit0', 'Numpad0']

/**
 * Every key the controller consumes.
 *
 * The panel swallows these while it has the controller engaged: arrow and page
 * keys would otherwise scroll the panel out from under the arm, and a stray
 * keystroke that both moves the arm and does something else is worse than
 * either on its own.
 */
export const KEYBOARD_CODES: ReadonlySet<string> = new Set([
  ...KEYBOARD_BINDINGS.flatMap((binding) => [...binding.positive, ...binding.negative]),
  ...FINE_KEYS,
  ...HOME_KEYS
])

function held(pressed: ReadonlySet<string>, codes: readonly string[]): number {
  return codes.some((code) => pressed.has(code)) ? 1 : 0
}

/** The command for a set of held keys. Opposing keys cancel out. */
export function commandFromKeys(pressed: ReadonlySet<string>): EeCommand {
  const command: EeCommand = { ...IDLE_COMMAND, fine: held(pressed, FINE_KEYS) === 1 }
  for (const binding of KEYBOARD_BINDINGS) {
    command[binding.target] = held(pressed, binding.positive) - held(pressed, binding.negative)
  }
  return command
}

export function homeFromKeys(pressed: ReadonlySet<string>): boolean {
  return held(pressed, HOME_KEYS) === 1
}

/** `'KeyW'` -> `'W'`, `'ArrowUp'` -> `'↑'`. For the legend, not for matching. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Comma: ',',
    Period: '.',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    Numpad0: 'Num 0'
  }
  if (named[code]) return named[code]
  return code.replace(/^(Key|Digit)/, '')
}

/* ------------------------------------------------------------------ *
 * Gamepad                                                            *
 * ------------------------------------------------------------------ */

/**
 * A gamepad reduced to numbers, so the mapping below never touches the DOM.
 *
 * Button values rather than booleans: triggers are analog on every controller
 * worth using, and reading them as a rate is what makes the vertical axis feel
 * like the sticks.
 */
export interface PadSnapshot {
  axes: readonly number[]
  buttons: readonly number[]
  /** The browser recognised the layout, so the indices below mean what they say. */
  standard: boolean
}

/**
 * Standard-mapping indices, from the Gamepad API's own layout.
 * https://w3c.github.io/gamepad/#remapping
 */
const PAD = {
  leftStickX: 0,
  leftStickY: 1,
  rightStickX: 2,
  rightStickY: 3,
  fine: 0,
  home: 3,
  closeJaws: 4,
  openJaws: 5,
  down: 6,
  up: 7,
  rollNegative: 14,
  rollPositive: 15
} as const

/** Below this a stick is treated as centred; above it the rest is rescaled. */
export const PAD_DEADZONE = 0.12

export function applyDeadzone(value: number, deadzone = PAD_DEADZONE): number {
  const magnitude = Math.abs(value)
  if (magnitude <= deadzone) return 0
  const scaled = (magnitude - deadzone) / (1 - deadzone)
  return Math.sign(value) * Math.min(1, scaled)
}

function axis(pad: PadSnapshot, index: number): number {
  return applyDeadzone(pad.axes[index] ?? 0)
}

function button(pad: PadSnapshot, index: number): number {
  return applyDeadzone(pad.buttons[index] ?? 0, 0.05)
}

/**
 * What each control does. Both sticks point the natural way: push away to send
 * the tool away, push right to send it right — which is why the Y axes are
 * negated, the API reporting up as -1.
 */
export const GAMEPAD_BINDINGS: readonly { control: string; sense: string }[] = [
  { control: 'Left stick', sense: 'X / Y — fly the tool around' },
  { control: 'Triggers', sense: 'Z — right raises, left lowers' },
  { control: 'Right stick', sense: 'RY / RZ — pitch and yaw the jaws' },
  { control: 'D-pad ← →', sense: 'RX — roll the jaws' },
  { control: 'Bumpers', sense: 'right opens the jaws, left closes them' },
  { control: 'A / cross', sense: 'hold for fine control' },
  { control: 'Y / triangle', sense: 'return to the middle of every range' }
] as const

export function commandFromPad(pad: PadSnapshot): EeCommand {
  return {
    x: -axis(pad, PAD.leftStickY),
    y: -axis(pad, PAD.leftStickX),
    z: button(pad, PAD.up) - button(pad, PAD.down),
    rx: button(pad, PAD.rollPositive) - button(pad, PAD.rollNegative),
    ry: -axis(pad, PAD.rightStickY),
    rz: -axis(pad, PAD.rightStickX),
    gripper: button(pad, PAD.openJaws) - button(pad, PAD.closeJaws),
    fine: button(pad, PAD.fine) > 0.5
  }
}

export function homeFromPad(pad: PadSnapshot): boolean {
  return button(pad, PAD.home) > 0.5
}

/* ------------------------------------------------------------------ *
 * Speeds                                                             *
 * ------------------------------------------------------------------ */

/**
 * How fast full deflection moves the tool.
 *
 * Chosen to be slow: 6 cm/s crosses the SO-101's whole reach in about five
 * seconds, which is fast enough to get somewhere and slow enough that a key held
 * a moment too long does not put the arm into the table. The panel's speed
 * setting scales all three.
 */
export const EE_LINEAR_SPEED = 0.06

/** Radians per second, about 57 degrees. */
export const EE_ANGULAR_SPEED = 1

/** Fractions of the jaws' travel per second. */
export const EE_GRIPPER_SPEED = 0.8

export const EE_FINE_SCALE = 0.25

/** The rate at which commands are integrated and inverse kinematics is solved. */
export const EE_LOOP_HZ = 50

