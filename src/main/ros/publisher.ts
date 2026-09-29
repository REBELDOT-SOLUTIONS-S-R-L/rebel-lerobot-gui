import { EventEmitter } from 'node:events'
import type { ArmModel } from '@shared/devices'
import type { MotorTelemetry } from '@shared/feetech'
import type { TickRange } from '@shared/normalize'
import {
  DIAGNOSTICS_HZ,
  diagnosticsMsg,
  jointStateMsg,
  rosNamespace,
  topicPath,
  type RosAttachRequest,
  type RosSessionMode,
  type RosStatus,
  type RosTopicKey
} from '@shared/ros'
import type { SimManifest } from '@shared/sim'
import type { RosbridgeClient } from './rosbridge-client'

/**
 * Which devices are being published, and turning their frames into messages.
 *
 * A panel attaches a device while it drives it, with the calibrated ranges it
 * already holds, and detaches it when it stops. Everything else arrives here on
 * its own: position frames from the sidecar and the virtual arm, and the goals
 * the app writes. The panel never sends telemetry itself, so the rate ROS sees
 * is the stream's, not React's.
 *
 * The socket is opened with the first session and closed a moment after the
 * last one, so an app that is not publishing holds no connection at all.
 */

export interface PublisherDevice {
  /** The profile's name, which becomes the namespace. */
  id: string
  model: ArmModel
  virtual: boolean
}

export interface PublisherDeps {
  client: RosbridgeClient
  url: () => string
  resolveDevice: (uid: string) => PublisherDevice
  loadManifest: (model: ArmModel) => SimManifest
  /** The model's URDF, ready to publish. */
  loadDescription: (model: ArmModel) => string
  /** Health registers for a device, or null when it cannot be read right now. */
  readTelemetry: (uid: string) => Promise<Record<string, Partial<MotorTelemetry>> | null>
  now?: () => number
}

interface Session {
  uid: string
  device: PublisherDevice
  namespace: string
  mode: RosSessionMode
  ranges: Record<string, TickRange>
  manifest: SimManifest
  startedAt: number
  /** joint_states stamps over the rate window. */
  sent: number[]
  reading: boolean
}

/** Joint topics come and go with a session; the latched ones stay with the socket. */
const SESSION_TOPICS: RosTopicKey[] = ['jointStates', 'jointCommand', 'diagnostics', 'robotDescription', 'session']

const RATE_WINDOW_MS = 2000
/** Grace before the socket closes, so switching modes does not reconnect. */
const CLOSE_AFTER_MS = 3000

export class RosPublisher extends EventEmitter {
  private sessions = new Map<string, Session>()
  /** The real arm the sidecar's serial bus has open; untagged frames are its. */
  private busUid: string | null = null
  private ticker: NodeJS.Timeout | null = null
  private closer: NodeJS.Timeout | null = null
  private readonly now: () => number

  constructor(private readonly deps: PublisherDeps) {
    super()
    this.now = deps.now ?? Date.now
    deps.client.on('state', () => this.emitStatus())
  }

  status(): RosStatus {
    const now = this.now()
    return {
      state: this.deps.client.state,
      url: this.deps.url(),
      error: this.deps.client.error,
      sessions: [...this.sessions.values()].map((s) => ({
        uid: s.uid,
        namespace: s.namespace,
        mode: s.mode,
        rate: s.sent.filter((t) => now - t <= RATE_WINDOW_MS).length / (RATE_WINDOW_MS / 1000)
      }))
    }
  }

  /** Start publishing a device, or update the ranges and mode of one already going. */
  attach(req: RosAttachRequest): RosStatus {
    const existing = this.sessions.get(req.uid)
    if (existing) {
      const modeChanged = existing.mode !== req.mode
      existing.ranges = req.ranges
      existing.mode = req.mode
      if (modeChanged) this.publishSession(existing, true)
      this.emitStatus()
      return this.status()
    }

    const device = this.deps.resolveDevice(req.uid)
    const namespace = rosNamespace(device.id)
    const clash = [...this.sessions.values()].find((s) => s.namespace === namespace)
    if (clash) {
      throw new Error(
        `'${device.id}' and '${clash.device.id}' both publish under /${namespace}. Rename one of the profiles.`
      )
    }
    const session: Session = {
      uid: req.uid,
      device,
      namespace,
      mode: req.mode,
      ranges: req.ranges,
      manifest: this.deps.loadManifest(device.model),
      startedAt: this.now(),
      sent: [],
      reading: false
    }
    const description = this.deps.loadDescription(device.model)

    this.cancelClose()
    this.deps.client.open(this.deps.url())
    this.sessions.set(req.uid, session)
    for (const key of SESSION_TOPICS) this.deps.client.advertise(topicPath(namespace, key), key)
    this.deps.client.publish(topicPath(namespace, 'robotDescription'), { data: description })
    this.publishSession(session, true)
    this.startTicker()
    this.emitStatus()
    return this.status()
  }

  detach(uid: string): RosStatus {
    const session = this.sessions.get(uid)
    if (!session) return this.status()
    this.publishSession(session, false)
    this.sessions.delete(uid)
    // The latched two stay advertised until the socket closes, so a subscriber
    // joining after the stop still learns that the session ended.
    for (const key of ['jointStates', 'jointCommand', 'diagnostics'] as const) {
      this.deps.client.unadvertise(topicPath(session.namespace, key))
    }
    if (this.sessions.size === 0) {
      this.stopTicker()
      this.scheduleClose()
    }
    this.emitStatus()
    return this.status()
  }

  detachAll(): void {
    for (const uid of [...this.sessions.keys()]) this.detach(uid)
  }

  /** Which real arm the sidecar has open, so its untagged frames can be routed. */
  setBusDevice(uid: string | null): void {
    this.busUid = uid
  }

  /** A position frame: `virtual` from the simulated arm, `bus` from the sidecar. */
  positions(source: 'virtual' | 'bus', ticks: Record<string, number>): void {
    const session =
      source === 'virtual'
        ? [...this.sessions.values()].find((s) => s.device.virtual)
        : this.busUid
          ? this.sessions.get(this.busUid)
          : undefined
    if (!session || !this.deps.client.connected) return
    const now = this.now()
    this.deps.client.publish(
      topicPath(session.namespace, 'jointStates'),
      jointStateMsg(session.manifest, session.device.model, ticks, session.ranges, now)
    )
    session.sent.push(now)
    while (session.sent.length > 0 && now - session.sent[0] > RATE_WINDOW_MS) session.sent.shift()
  }

  /** Goals the app is writing to a device, in ticks. */
  command(uid: string, ticks: Record<string, number>): void {
    const session = this.sessions.get(uid)
    if (!session || !this.deps.client.connected) return
    this.deps.client.publish(
      topicPath(session.namespace, 'jointCommand'),
      jointStateMsg(session.manifest, session.device.model, ticks, session.ranges, this.now())
    )
  }

  private publishSession(session: Session, active: boolean): void {
    this.deps.client.publish(topicPath(session.namespace, 'session'), {
      data: JSON.stringify({
        active,
        device: session.device.id,
        namespace: `/${session.namespace}`,
        model: session.device.model,
        simulated: session.device.virtual,
        mode: session.mode,
        startedAt: new Date(session.startedAt).toISOString(),
        ...(active ? {} : { endedAt: new Date(this.now()).toISOString() }),
        publisher: 'rebel-lerobot-gui'
      })
    })
  }

  /** Once a second: motor health, and the rates the header shows. */
  private tick(): void {
    this.emitStatus()
    if (!this.deps.client.connected) return
    for (const session of this.sessions.values()) {
      if (session.reading) continue
      session.reading = true
      void this.deps
        .readTelemetry(session.uid)
        .then((motors) => {
          if (!motors || this.sessions.get(session.uid) !== session || !this.deps.client.connected) return
          this.deps.client.publish(
            topicPath(session.namespace, 'diagnostics'),
            diagnosticsMsg(session.namespace, motors, this.now())
          )
        })
        .catch(() => {
          // A busy or closed bus skips a beat; the next tick tries again.
        })
        .finally(() => {
          session.reading = false
        })
    }
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => this.tick(), 1000 / DIAGNOSTICS_HZ)
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private scheduleClose(): void {
    this.cancelClose()
    this.closer = setTimeout(() => {
      this.closer = null
      if (this.sessions.size === 0) this.deps.client.close()
    }, CLOSE_AFTER_MS)
  }

  private cancelClose(): void {
    if (this.closer) clearTimeout(this.closer)
    this.closer = null
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }
}
