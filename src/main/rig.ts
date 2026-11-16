import { EventEmitter } from 'node:events'
import { SO_ARM_MOTORS } from '@shared/devices'
import { normalizeTicks, unnormalizeTicks, type TickRange } from '@shared/normalize'
import {
  IDLE_RIG_STATUS,
  sideCamera,
  sidePrefix,
  validateSides,
  type RecordRequest,
  type RigFrame,
  type RigSideId,
  type RigSideInfo,
  type RigStartRequest,
  type RigStartResult,
  type RigStatus
} from '@shared/rig'
import type { BusSnapshot, DeviceProfile } from '@shared/types'
import { isVirtual } from '@shared/virtual'
import { bridge } from './bridge/bridge-client'
import { snapshotFromBridge } from './calibration'
import { venvExists } from './paths'
import { rosPublisher } from './ros'
import { getProfile, settings } from './stores/settings'
import { virtualBus } from './virtual-bus'

/**
 * The teleoperation rig, from the main process's side.
 *
 * The sidecar runs the loop for real hardware (`Rig` in the bridge). This sits
 * between it, the panel and the virtual arm, which lives here:
 *
 * - a virtual follower's positions and goals are handed to the sidecar every
 *   frame, in LeRobot's units, so the recording has them;
 * - a leader driving the virtual follower arrives as a normalized action from
 *   the sidecar and is written to the simulation here;
 * - every position, real or virtual, goes to the panel as one `rig:frame`, and
 *   to the ROS 2 publisher.
 *
 * With no Python environment and only the virtual arm, the sidecar is not
 * needed and not started: the arm still drives, it just cannot record.
 */

interface ActiveSide {
  side: RigSideId
  robot: DeviceProfile
  leader: DeviceProfile | null
  simulated: boolean
  /** The virtual follower's calibration, for converting its ticks. */
  ranges: Record<string, TickRange>
  /** Last action handed in for a virtual follower, merged as goals arrive. */
  action: Record<string, number>
}

const MOTOR_MODES = new Map(SO_ARM_MOTORS.map((m) => [m.name, m.normMode]))

function rangesFromSnapshot(snapshot: BusSnapshot): Record<string, TickRange> {
  const ranges: Record<string, TickRange> = {}
  for (const m of snapshot.motors) {
    if (m.rangeMin === null || m.rangeMax === null) continue
    ranges[m.name] = { min: m.rangeMin, max: m.rangeMax, driveMode: m.driveMode }
  }
  return ranges
}

/** Ticks to `<motor>.pos` in LeRobot's units, for the motors that have a range. */
export function toNormalized(
  ticks: Record<string, number>,
  ranges: Record<string, TickRange>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, value] of Object.entries(ticks)) {
    const mode = MOTOR_MODES.get(name)
    const range = ranges[name]
    if (!mode || !range || range.max === range.min) continue
    out[`${name}.pos`] = normalizeTicks(mode, value, range)
  }
  return out
}

/** The inverse, for an action the sidecar read off a leader. */
export function fromNormalized(
  action: Record<string, number>,
  ranges: Record<string, TickRange>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(action)) {
    const name = key.replace(/\.pos$/, '')
    const mode = MOTOR_MODES.get(name)
    const range = ranges[name]
    if (!mode || !range || range.max === range.min) continue
    out[name] = unnormalizeTicks(mode, value, range)
  }
  return out
}

export class RigCoordinator extends EventEmitter {
  private sides = new Map<RigSideId, ActiveSide>()
  /** The sidecar is running the loop, so recording is possible. */
  private sidecar = false
  status: RigStatus = { ...IDLE_RIG_STATUS }

  get running(): boolean {
    return this.sides.size > 0
  }

  async start(req: RigStartRequest): Promise<RigStartResult> {
    await this.stop()
    const problem = validateSides(req.sides)
    if (problem) throw new Error(problem)

    const sides = req.sides.map((spec) => {
      const robot = getProfile(spec.robotUid)
      if (!robot) throw new Error('A follower profile in this setup no longer exists.')
      const leader = spec.controller === 'leader' ? getProfile(spec.leaderUid) : null
      if (spec.controller === 'leader' && !leader) {
        throw new Error('A leader profile in this setup no longer exists.')
      }
      for (const device of [robot, leader]) {
        if (device && !isVirtual(device.uid) && !device.port) {
          throw new Error(`'${device.id}' has no serial port selected. Pick one in Configure.`)
        }
      }
      return { spec, robot, leader, simulated: isVirtual(robot.uid) }
    })

    const venv = settings().get().venvPath
    const envReady = !!venv && venvExists(venv)
    const hardware = sides.some((s) => !s.simulated || s.leader)
    const cameras = sides.some((s) => sideCamera(s.robot, s.spec.cameraKey))
    if ((hardware || cameras) && !envReady) {
      throw new Error('Real arms and cameras are driven through LeRobot. Set up the environment in Settings first.')
    }

    const result: RigSideInfo[] = []
    const virtualSnapshot = sides.some((s) => s.simulated) ? virtualBus.snapshot() : null

    if (envReady) {
      await bridge.ensure(venv)
      const first = sides[0].robot
      const robotType =
        req.setup === 'dual' ? 'bi_so_follower' : `${first.model.toLowerCase()}_follower`
      const started = await bridge.request<{
        sides: Record<string, { follower: Parameters<typeof snapshotFromBridge>[1] | null; leader: Parameters<typeof snapshotFromBridge>[1] | null }>
      }>(
        'rig.start',
        {
          fps: req.fps,
          robotType,
          sides: sides.map(({ spec, robot, leader, simulated }) => {
            const camera = sideCamera(robot, spec.cameraKey)
            return {
              side: spec.side,
              prefix: sidePrefix(spec.side),
              controller: spec.controller,
              follower: simulated
                ? null
                : { port: robot.port, id: robot.id, calibrationDir: robot.calibrationDir },
              leader: leader
                ? { port: leader.port, id: leader.id, calibrationDir: leader.calibrationDir }
                : null,
              camera: camera ? { name: camera.key, binding: camera } : null
            }
          })
        },
        120_000
      )
      this.sidecar = true
      for (const { spec, robot, leader, simulated } of sides) {
        const info = started.sides[spec.side]
        const follower = simulated
          ? virtualSnapshot!
          : snapshotFromBridge(robot, info.follower!)
        result.push({
          side: spec.side,
          robotUid: robot.uid,
          leaderUid: leader?.uid ?? null,
          simulated,
          follower,
          leader: leader && info.leader ? snapshotFromBridge(leader, info.leader) : null
        })
      }
    } else {
      for (const { spec, robot } of sides) {
        result.push({
          side: spec.side,
          robotUid: robot.uid,
          leaderUid: null,
          simulated: true,
          follower: virtualSnapshot!,
          leader: null
        })
      }
    }

    for (const { spec, robot, leader, simulated } of sides) {
      const info = result.find((r) => r.side === spec.side)!
      this.sides.set(spec.side, {
        side: spec.side,
        robot,
        leader,
        simulated,
        ranges: simulated ? rangesFromSnapshot(info.follower) : {},
        action: {}
      })
    }
    // The simulation streams its own positions; they are forwarded from here.
    if (sides.some((s) => s.simulated)) virtualBus.streamStart(req.fps)

    this.setStatus({
      ...IDLE_RIG_STATUS,
      running: true,
      error: null
    })
    return {
      sides: result,
      canRecord: this.sidecar,
      recordReason: this.sidecar
        ? null
        : 'Recording writes a LeRobot dataset, which needs the Python environment. Set it up in Settings.'
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.sidecar) return
    const hadVirtual = [...this.sides.values()].some((s) => s.simulated)
    this.sides.clear()
    if (hadVirtual) virtualBus.streamStop()
    if (this.sidecar && bridge.running) {
      this.sidecar = false
      // Generous: stopping saves the episode being recorded and finishes the dataset.
      await bridge.request('rig.stop', {}, 180_000).catch(() => undefined)
    }
    this.sidecar = false
    this.setStatus({ ...this.status, running: false, phase: 'idle', frames: 0 })
  }

  async recordStart(req: RecordRequest): Promise<RigStatus> {
    if (!this.sidecar) throw new Error('Recording needs the Python environment and a running rig.')
    const status = await bridge.request<RigStatus>('record.start', { ...req }, 60_000)
    this.setStatus(status)
    return status
  }

  async recordStop(discard = false): Promise<RigStatus> {
    if (!this.sidecar) return this.status
    const status = await bridge.request<RigStatus>('record.stop', { discard }, 30_000)
    this.setStatus(status)
    return status
  }

  /**
   * Goals the keyboard or gamepad solved for an arm in this rig.
   *
   * Returns false when the arm is not one of the rig's real followers, so the
   * caller writes them the usual way — which is also how the virtual arm moves.
   */
  goals(uid: string, ticks: Record<string, number>): boolean {
    const side = this.sideOf(uid)
    if (!side) return false
    if (side.simulated) {
      side.action = { ...side.action, ...toNormalized(ticks, side.ranges) }
      this.feed(side.side, undefined, side.action)
      return false
    }
    if (!this.sidecar) return false
    void bridge.request('rig.goals', { side: side.side, positions: ticks }, 5_000).catch(() => undefined)
    return true
  }

  /** The virtual arm moved: tell the panel, and the recording. */
  onVirtualPositions(ticks: Record<string, number>): void {
    const side = [...this.sides.values()].find((s) => s.simulated)
    if (!side) return
    this.emit('frames', [{ side: side.side, follower: ticks }] satisfies RigFrame[])
    this.feed(side.side, toNormalized(ticks, side.ranges), undefined)
  }

  /** A notification from the sidecar. Returns true when it was the rig's. */
  onBridgeNotification(frame: Record<string, unknown>): boolean {
    if (frame.type === 'rigFrame') {
      const frames = (frame.frames as (RigFrame & { action?: Record<string, number> })[]) ?? []
      const out: RigFrame[] = []
      for (const f of frames) {
        const side = this.sides.get(f.side)
        if (!side) continue
        if (f.follower) rosPublisher.positionsFor(side.robot.uid, f.follower)
        if (f.leader && side.leader) rosPublisher.positionsFor(side.leader.uid, f.leader)
        // A leader driving the virtual follower: the simulation is moved here.
        if (f.action && side.simulated) {
          const goals = fromNormalized(f.action, side.ranges)
          virtualBus.moveMany(goals)
          rosPublisher.command(side.robot.uid, goals)
        }
        if (f.follower || f.leader) out.push({ side: f.side, follower: f.follower, leader: f.leader })
      }
      if (out.length > 0) this.emit('frames', out)
      return true
    }
    if (frame.type === 'rigStatus') {
      const { type: _type, ...status } = frame
      this.setStatus({ ...(status as unknown as RigStatus), running: this.running })
      return true
    }
    if (frame.type === 'rigError') {
      this.emit('error', `${String(frame.side)}: ${String(frame.message)}`)
      return true
    }
    return false
  }

  /** The sidecar died; whatever it was running is gone. */
  onBridgeClosed(): void {
    if (!this.sidecar) return
    this.sidecar = false
    this.setStatus({
      ...this.status,
      phase: 'idle',
      error: 'The Python sidecar stopped, so the real arms are no longer driven or recorded.'
    })
  }

  private sideOf(uid: string): ActiveSide | undefined {
    return [...this.sides.values()].find((s) => s.robot.uid === uid)
  }

  private feed(
    side: RigSideId,
    state: Record<string, number> | undefined,
    action: Record<string, number> | undefined
  ): void {
    if (!this.sidecar || !bridge.running) return
    void bridge.request('rig.feed', { side, state: state ?? null, action: action ?? null }, 5_000).catch(() => undefined)
  }

  private setStatus(status: RigStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

export const rig = new RigCoordinator()
