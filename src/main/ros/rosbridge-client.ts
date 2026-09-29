import { EventEmitter } from 'node:events'
import {
  advertiseOp,
  ROS_TOPICS,
  type RosbridgeOp,
  type RosConnectionState,
  type RosTopicKey
} from '@shared/ros'

/**
 * A rosbridge v2 client that only publishes.
 *
 * Keeps one websocket open while anything wants it, and reconnects with a
 * backoff when it drops — rosbridge is usually started after the app, or on
 * another machine that comes and goes. Topics are remembered as they are
 * advertised so a reconnect can advertise them again; rosbridge forgets a
 * client's publishers the moment its socket closes. Latched messages are kept
 * too and sent again, because a subscriber that joins later still needs them.
 *
 * Publishes while disconnected are dropped. Telemetry is only worth anything
 * live, and queueing it would replay stale poses into a twin on reconnect.
 */

/** The socket this needs, so tests can hand in a fake. */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type SocketFactory = (url: string) => SocketLike

const OPEN = 1
const BACKOFF_MS = [500, 1000, 2000, 5000]

export class RosbridgeClient extends EventEmitter {
  private socket: SocketLike | null = null
  private url: string | null = null
  private wanted = false
  private attempt = 0
  private retry: NodeJS.Timeout | null = null
  private topics = new Map<string, RosTopicKey>()
  private latched = new Map<string, unknown>()
  state: RosConnectionState = 'idle'
  error: string | null = null

  constructor(private readonly factory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike) {
    super()
  }

  get connected(): boolean {
    return this.state === 'connected'
  }

  /** Connect to `url`, or switch to it if another one was open. */
  open(url: string): void {
    this.wanted = true
    if (this.url === url && this.socket) return
    this.url = url
    this.teardown()
    this.connect()
  }

  close(): void {
    this.wanted = false
    this.teardown()
    this.topics.clear()
    this.latched.clear()
    this.setState('idle', null)
  }

  advertise(topic: string, key: RosTopicKey): void {
    if (this.topics.get(topic) === key) return
    this.topics.set(topic, key)
    this.send(advertiseOp(topic, key))
  }

  unadvertise(topic: string): void {
    if (!this.topics.delete(topic)) return
    this.latched.delete(topic)
    this.send({ op: 'unadvertise', topic })
  }

  publish(topic: string, msg: unknown): void {
    const key = this.topics.get(topic)
    if (!key) throw new Error(`${topic} was published before it was advertised.`)
    if (ROS_TOPICS[key].latch) this.latched.set(topic, msg)
    this.send({ op: 'publish', topic, msg })
  }

  private send(op: RosbridgeOp): void {
    if (this.socket?.readyState !== OPEN) return
    this.socket.send(JSON.stringify(op))
  }

  private connect(): void {
    if (!this.url) return
    this.setState('connecting', this.error)
    let socket: SocketLike
    try {
      socket = this.factory(this.url)
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err))
      this.scheduleRetry()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.setState('connected', null)
      for (const [topic, key] of this.topics) this.send(advertiseOp(topic, key))
      for (const [topic, msg] of this.latched) this.send({ op: 'publish', topic, msg })
    }
    // rosbridge answers a bad publish with a status message rather than closing.
    socket.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { op?: string; level?: string; msg?: string }
        if (frame.op === 'status' && frame.level === 'error') this.emit('log', `[rosbridge] ${frame.msg}\n`)
      } catch {
        // Not ours to understand; the client never subscribes to anything.
      }
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.error = `Could not reach rosbridge at ${this.url}.`
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setState(this.wanted ? 'error' : 'idle', this.wanted ? (this.error ?? `Lost rosbridge at ${this.url}.`) : null)
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retry) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    this.attempt += 1
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.wanted && !this.socket) this.connect()
    }, delay)
  }

  private teardown(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.attempt = 0
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      try {
        socket.close()
      } catch {
        // Already gone.
      }
    }
  }

  private setState(state: RosConnectionState, error: string | null): void {
    const changed = state !== this.state || error !== this.error
    this.state = state
    this.error = error
    if (changed) this.emit('state', { state, error })
  }
}

/**
 * Whether rosbridge answers at `url`, for Settings' Test button.
 *
 * A socket of its own, so testing a new address never disturbs sessions that
 * are publishing to the old one.
 */
export function probeRosbridge(
  url: string,
  timeoutMs = 4000,
  factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: SocketLike
    try {
      socket = factory(url)
    } catch (err) {
      reject(new Error(`'${url}' is not a websocket address: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    const finish = (error: string | null): void => {
      clearTimeout(timer)
      socket.onopen = socket.onclose = socket.onerror = null
      try {
        socket.close()
      } catch {
        // Already gone.
      }
      if (error) reject(new Error(error))
      else resolve()
    }
    const timer = setTimeout(() => finish(`rosbridge at ${url} did not answer within ${timeoutMs / 1000} s.`), timeoutMs)
    socket.onopen = () => finish(null)
    socket.onerror = () => finish(`Could not reach rosbridge at ${url}. Is rosbridge_server running?`)
    socket.onclose = () => finish(`rosbridge at ${url} closed the connection.`)
  })
}
