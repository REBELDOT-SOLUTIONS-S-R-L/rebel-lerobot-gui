/**
 * Feetech STS/SMS telemetry, in the units the motor reports it.
 *
 * The bridge reads these registers raw (`normalize=False`) and passes the
 * numbers through untouched, so every conversion to a human unit lives here.
 * Raw is what gets stored and sent: it is what the motor actually said, it
 * survives a round trip through the calibration file unchanged, and it keeps the
 * scaling factors in one place instead of spread across the panels.
 *
 * Sign-magnitude registers (`Present_Load`, `Present_Velocity`) arrive already
 * signed — `MotorsBus.read` applies `_decode_sign` before it applies `normalize`
 * (motors_bus.py:1024-1029), so there is nothing to undo on this side.
 *
 * Ref: lerobot/src/lerobot/motors/feetech/tables.py:41-101 (control table),
 *      :207-216 (sign-magnitude encodings), :242-247 (model numbers).
 */

/** `Present_Voltage` counts 0.1 V per unit. */
const VOLTAGE_STEP_V = 0.1

/**
 * `Present_Current` counts ~6.5 mA per unit on the sts3215.
 *
 * Feetech documents this per model rather than per series, so it is only right
 * for the motors the SO arms actually use. Both SO-100 and SO-101 are sts3215
 * throughout (devices.ts:85-92), which is why one constant covers the arm.
 */
const CURRENT_STEP_MA = 6.5

/** `Present_Load` counts 0.1% of maximum torque per unit, signed. */
const LOAD_STEP_PERCENT = 0.1

/** `Model_Number` values, keyed by the model string LeRobot uses. */
export const FEETECH_MODEL_NUMBERS: Readonly<Record<number, string>> = {
  777: 'sts3215',
  2825: 'sts3250',
  11272: 'sm8512bl',
  1284: 'scs0009'
}

/**
 * One motor's live readings, exactly as the registers report them.
 *
 * Every field is null when that register could not be read, which is the normal
 * case for a motor that did not answer — one dead joint must not blank the rest.
 */
export interface MotorTelemetry {
  /** `Present_Temperature` (63) in whole °C. */
  temperature: number | null
  /** `Present_Voltage` (62) in 0.1 V units. */
  voltage: number | null
  /** `Present_Load` (60), signed, in 0.1% of maximum torque. */
  load: number | null
  /** `Present_Current` (69) in ~6.5 mA units. */
  current: number | null
  /** `Present_Velocity` (58), signed, in ticks per second. */
  velocity: number | null
  /** `Moving` (66). */
  moving: boolean | null
  /** `Status` (65) — the hardware error bitfield. */
  status: number | null
}

/** Identity read out of the motor's EEPROM, rather than assumed from the model table. */
export interface MotorIdentity {
  /** `Model_Number` (3). Null when it could not be read. */
  modelNumber: number | null
  /** `Firmware_Major_Version` (0). */
  firmwareMajor: number | null
  /** `Firmware_Minor_Version` (1). */
  firmwareMinor: number | null
}

/* ------------------------------------------------------------------ *
 * Unit conversion                                                     *
 * ------------------------------------------------------------------ */

export function voltageVolts(raw: number): number {
  return raw * VOLTAGE_STEP_V
}

export function currentMilliamps(raw: number): number {
  return raw * CURRENT_STEP_MA
}

export function loadPercent(raw: number): number {
  return raw * LOAD_STEP_PERCENT
}

/* ------------------------------------------------------------------ *
 * Status register                                                     *
 * ------------------------------------------------------------------ */

/**
 * Bits of the `Status` register (65).
 *
 * Feetech's own manual is the only authority on these and it disagrees with
 * itself between revisions, so only the bits that are consistent across the
 * SCS/STS documentation are named. Anything else is reported as an unknown bit
 * rather than guessed at — a wrong label on a fault light is worse than none.
 */
export const STATUS_BITS: readonly { bit: number; label: string }[] = [
  { bit: 0, label: 'Voltage out of range' },
  { bit: 1, label: 'Angle sensor' },
  { bit: 2, label: 'Overheated' },
  { bit: 5, label: 'Overloaded' }
] as const

/** Human-readable faults currently latched in `Status`. Empty when healthy. */
export function decodeStatus(status: number): string[] {
  if (!Number.isInteger(status) || status <= 0) return []
  const out: string[] = []
  let unnamed = 0
  for (let bit = 0; bit < 8; bit += 1) {
    if ((status & (1 << bit)) === 0) continue
    const known = STATUS_BITS.find((f) => f.bit === bit)
    if (known) out.push(known.label)
    else unnamed |= 1 << bit
  }
  if (unnamed) out.push(`Unknown fault (0x${unnamed.toString(16).padStart(2, '0')})`)
  return out
}

/* ------------------------------------------------------------------ *
 * Display                                                             *
 * ------------------------------------------------------------------ */

/** Em dash for a register that could not be read, so the panels stay aligned. */
const NONE = '—'

export function formatTemperature(raw: number | null): string {
  return raw === null ? NONE : `${raw} °C`
}

export function formatVoltage(raw: number | null): string {
  return raw === null ? NONE : `${voltageVolts(raw).toFixed(1)} V`
}

export function formatCurrent(raw: number | null): string {
  if (raw === null) return NONE
  const ma = currentMilliamps(raw)
  return ma >= 1000 ? `${(ma / 1000).toFixed(2)} A` : `${Math.round(ma)} mA`
}

export function formatLoad(raw: number | null): string {
  return raw === null ? NONE : `${loadPercent(raw).toFixed(1)} %`
}

export function formatVelocity(raw: number | null): string {
  return raw === null ? NONE : `${raw} ticks/s`
}

/** `Firmware_Major_Version.Firmware_Minor_Version`, or an em dash. */
export function formatFirmware(major: number | null, minor: number | null): string {
  if (major === null || minor === null) return NONE
  return `${major}.${minor}`
}

/**
 * The model number, named when it is one we know.
 *
 * Worth showing next to the assumed model: the panels take `sts3215` from the
 * device table, so a swapped-in sts3250 would otherwise go unnoticed.
 */
export function formatModelNumber(modelNumber: number | null): string {
  if (modelNumber === null) return NONE
  const known = FEETECH_MODEL_NUMBERS[modelNumber]
  return known ? `${known} (${modelNumber})` : String(modelNumber)
}

/**
 * True when the motor reports a model other than the one the device table assumes.
 *
 * Unknown model numbers do not count as a mismatch: the table above only lists
 * the Feetech models LeRobot itself knows, so an unrecognised number means the
 * app is out of date, not that the arm is wired wrong.
 */
export function modelMismatch(modelNumber: number | null, expected: string): boolean {
  if (modelNumber === null) return false
  const actual = FEETECH_MODEL_NUMBERS[modelNumber]
  return actual !== undefined && actual !== expected
}

/* ------------------------------------------------------------------ *
 * Thresholds                                                          *
 * ------------------------------------------------------------------ */

/**
 * Where a reading stops being routine.
 *
 * Deliberately conservative and advisory only — nothing here stops a movement.
 * The sts3215 is rated to 12 V and its own `Max_Temperature_Limit` ships at
 * 70 °C, so warning well below that leaves room to react.
 */
export const TEMPERATURE_WARN_C = 55
export const TEMPERATURE_HOT_C = 65
/** Below this the supply is sagging enough to cause dropouts: 10.0 V. */
export const VOLTAGE_LOW_RAW = 100
/** Above this the supply is over the 12 V the arm expects: 12.6 V. */
export const VOLTAGE_HIGH_RAW = 126

export type TelemetryTone = 'ok' | 'warn' | 'error'

export function temperatureTone(raw: number | null): TelemetryTone {
  if (raw === null) return 'ok'
  if (raw >= TEMPERATURE_HOT_C) return 'error'
  return raw >= TEMPERATURE_WARN_C ? 'warn' : 'ok'
}

export function voltageTone(raw: number | null): TelemetryTone {
  if (raw === null) return 'ok'
  return raw < VOLTAGE_LOW_RAW || raw > VOLTAGE_HIGH_RAW ? 'warn' : 'ok'
}
