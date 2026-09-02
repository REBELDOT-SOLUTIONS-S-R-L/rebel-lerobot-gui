import { GEAR_RATIOS, SO_ARM_MOTORS, STS3215_MAX_TICK } from '@shared/devices'
import type { BusSnapshot, CalibrationFile, MotorState } from '@shared/types'
import { VIRTUAL_MODEL, VIRTUAL_ROLE, virtualRange } from '@shared/virtual'
import { EventEmitter } from 'node:events'

/**
 * The virtual arm's motor bus.
 *
 * Stands in for `BusSession` in the Python bridge and answers the same questions
 * — what are the motors, where are they, what are their limits — so the panels
 * that read a real arm read this one through the same calls. It needs no serial
 * port, no LeRobot and no Python: a fresh install can drive it before anything is
 * set up, which is the point of it existing.
 *
 * The motors are simulated rather than assigned: a goal position is travelled
 * to at a fixed rate, and only while torque is on. That is what makes the 3D
 * view show a movement rather than a jump, and it means switching torque off
 * does what it does on the bench — the arm stops holding a goal and stays put.
 */

/**
 * How fast a joint travels, in ticks per second.
 *
 * Rather slower than an unloaded sts3215, and in the same ballpark as the rate
 * the bridge glides a real arm at during a motion test (`_glide`, 800 ticks/s),
 * so a virtual arm and a real one take comparable time to cross their range.
 */
const MAX_SPEED = 1500

/** Simulation step. Above the 50 Hz the teleoperation loop commands at. */
const PHYSICS_HZ = 60

interface VirtualMotor {
  name: string
  id: number
  position: number
  goal: number
  rangeMin: number
  rangeMax: number
  homingOffset: number
  driveMode: number
  torque: boolean
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

function factoryMotors(): VirtualMotor[] {
  return SO_ARM_MOTORS.map((spec) => {
    const range = virtualRange(VIRTUAL_MODEL, spec.name)
    const centre = Math.round((range.min + range.max) / 2)
    return {
      name: spec.name,
      id: spec.defaultId,
      position: centre,
      goal: centre,
      rangeMin: range.min,
      rangeMax: range.max,
      homingOffset: 0,
      driveMode: 0,
      // Torque on from the start: a virtual arm has no weight to drop under, and
      // it means a pose can be commanded without switching anything on first.
      torque: true
    }
  })
}

export class VirtualBus extends EventEmitter {
  private motors = factoryMotors()
  private physics: NodeJS.Timeout | null = null
  private stream: NodeJS.Timeout | null = null

  /* -- reads -------------------------------------------------------- */

  /** The Configure panel's table, in the shape a bus snapshot takes. */
  snapshot(): BusSnapshot {
    const ratios = GEAR_RATIOS[VIRTUAL_MODEL][VIRTUAL_ROLE]
    const motors: MotorState[] = SO_ARM_MOTORS.map((spec) => {
      const motor = this.require(spec.name)
      return {
        name: spec.name,
        label: spec.label,
        id: motor.id,
        position: motor.position,
        rangeMin: motor.rangeMin,
        rangeMax: motor.rangeMax,
        homingOffset: motor.homingOffset,
        driveMode: motor.driveMode,
        model: spec.model,
        gearRatio: ratios[spec.name] ?? null,
        online: true
      }
    })
    return {
      source: 'live',
      connected: true,
      port: null,
      baudrate: null,
      simulated: true,
      motors
    }
  }

  positions(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const motor of this.motors) out[motor.name] = motor.position
    return out
  }

  calibration(): CalibrationFile {
    const out: CalibrationFile = {}
    for (const motor of this.motors) {
      out[motor.name] = {
        id: motor.id,
        drive_mode: motor.driveMode,
        homing_offset: motor.homingOffset,
        range_min: motor.rangeMin,
        range_max: motor.rangeMax
      }
    }
    return out
  }

  /* -- writes ------------------------------------------------------- */

  setLimits(name: string, rangeMin: number, rangeMax: number): { motor: string; rangeMin: number; rangeMax: number } {
    const motor = this.require(name)
    const min = Math.round(rangeMin)
    const max = Math.round(rangeMax)
    if (!(min >= 0 && min < max && max <= STS3215_MAX_TICK)) {
      throw new Error(`Limits must satisfy 0 <= min < max <= ${STS3215_MAX_TICK}.`)
    }
    motor.rangeMin = min
    motor.rangeMax = max
    motor.position = clamp(motor.position, min, max)
    motor.goal = clamp(motor.goal, min, max)
    return { motor: name, rangeMin: min, rangeMax: max }
  }

  setHoming(name: string, offset: number): { motor: string; homingOffset: number } {
    const motor = this.require(name)
    motor.homingOffset = Math.round(offset)
    return { motor: name, homingOffset: motor.homingOffset }
  }

  /**
   * Switch holding on or off.
   *
   * Releasing a joint also drops its goal onto where it currently is, so
   * switching torque back on does not make the arm lunge back to a goal it was
   * given minutes ago.
   */
  torque(enabled: boolean, name?: string | null): { enabled: boolean } {
    for (const motor of this.motors) {
      if (name && motor.name !== name) continue
      motor.torque = enabled
      if (!enabled) motor.goal = motor.position
    }
    if (enabled) this.startPhysics()
    return { enabled }
  }

  move(name: string, position: number): { motor: string; goal: number } {
    const motor = this.require(name)
    motor.goal = clamp(Math.round(position), motor.rangeMin, motor.rangeMax)
    this.startPhysics()
    return { motor: name, goal: motor.goal }
  }

  /** One goal per joint, as the teleoperation and replay loops write them. */
  moveMany(positions: Record<string, number>): { written: string[] } {
    const written: string[] = []
    for (const [name, position] of Object.entries(positions)) {
      const motor = this.motors.find((m) => m.name === name)
      if (!motor || !Number.isFinite(position)) continue
      motor.goal = clamp(Math.round(position), motor.rangeMin, motor.rangeMax)
      written.push(name)
    }
    if (written.length > 0) this.startPhysics()
    return { written }
  }

  applyCalibration(calibration: CalibrationFile): { applied: string[] } {
    const applied: string[] = []
    for (const [name, entry] of Object.entries(calibration)) {
      const motor = this.motors.find((m) => m.name === name)
      if (!motor) continue
      motor.id = entry.id
      motor.driveMode = entry.drive_mode
      motor.homingOffset = entry.homing_offset
      motor.rangeMin = entry.range_min
      motor.rangeMax = entry.range_max
      motor.position = clamp(motor.position, entry.range_min, entry.range_max)
      motor.goal = clamp(motor.goal, entry.range_min, entry.range_max)
      applied.push(name)
    }
    return { applied: applied.sort() }
  }

  /** Back to the middle of every factory range, as if freshly powered up. */
  reset(): { reset: true } {
    this.motors = factoryMotors()
    return { reset: true }
  }

  /* -- streaming ---------------------------------------------------- */

  streamStart(hz = 10): { hz: number } {
    const rate = Math.max(1, Math.min(hz, 60))
    this.streamStop()
    this.stream = setInterval(() => this.notify(), 1000 / rate)
    this.startPhysics()
    return { hz: rate }
  }

  streamStop(): { stopped: boolean } {
    if (this.stream) clearInterval(this.stream)
    this.stream = null
    return { stopped: true }
  }

  /** Stop everything. Called on quit, and when the panel lets the arm go. */
  close(): { closed: boolean } {
    this.streamStop()
    if (this.physics) clearInterval(this.physics)
    this.physics = null
    return { closed: true }
  }

  /* -- internals ---------------------------------------------------- */

  private require(name: string): VirtualMotor {
    const motor = this.motors.find((m) => m.name === name)
    if (!motor) throw new Error(`The virtual arm has no motor named '${name}'.`)
    return motor
  }

  /**
   * The frame the panels listen for.
   *
   * `source` is what tells a panel watching both a real leader and the virtual
   * follower which arm a frame is about. The bridge sends no such field, so
   * anything without one is the serial bus.
   */
  private notify(): void {
    this.emit('notification', {
      type: 'positions',
      source: 'virtual',
      positions: this.positions()
    })
  }

  private startPhysics(): void {
    if (this.physics) return
    let last = Date.now()
    this.physics = setInterval(() => {
      const now = Date.now()
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now
      if (!this.step(dt) && this.stream === null) {
        // Everything has arrived and nobody is watching: stop burning a timer.
        if (this.physics) clearInterval(this.physics)
        this.physics = null
      }
    }, 1000 / PHYSICS_HZ)
  }

  /** Advance every joint towards its goal. True while anything is still moving. */
  private step(dt: number): boolean {
    const budget = MAX_SPEED * dt
    let moving = false
    for (const motor of this.motors) {
      if (!motor.torque || motor.position === motor.goal) continue
      const remaining = motor.goal - motor.position
      const travel = Math.min(Math.abs(remaining), budget)
      motor.position = Math.round(motor.position + Math.sign(remaining) * travel)
      if (motor.position !== motor.goal) moving = true
    }
    return moving
  }
}

export const virtualBus = new VirtualBus()
