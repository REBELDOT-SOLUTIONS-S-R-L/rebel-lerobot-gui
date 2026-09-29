import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DIAG_ERROR,
  DIAG_OK,
  DIAG_STALE,
  DIAG_WARN,
  diagnosticsMsg,
  jointStateMsg,
  rosNamespace,
  rosTime,
  topicPath,
  urdfWithAbsoluteMeshes
} from '@shared/ros'
import { SIM_MANIFESTS, jointAngleRad, jointTuning, type SimManifest } from '@shared/sim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RosPublisher } from '../src/main/ros/publisher'
import { RosbridgeClient, type SocketLike } from '../src/main/ros/rosbridge-client'

const manifest = JSON.parse(
  readFileSync(resolve('assets', SIM_MANIFESTS.SO101), 'utf8')
) as SimManifest

const RANGES = Object.fromEntries(manifest.joints.map((j) => [j.name, { min: 1000, max: 3000 }]))
const MID = Object.fromEntries(manifest.joints.map((j) => [j.name, 2000]))

describe('rosNamespace', () => {
  it('keeps names that are already valid', () => {
    expect(rosNamespace('follower_1')).toBe('follower_1')
  })
  it('turns filename characters into single underscores', () => {
    expect(rosNamespace('my-follower.v2')).toBe('my_follower_v2')
    expect(rosNamespace('a--b')).toBe('a_b')
    expect(rosNamespace('-edge-')).toBe('edge')
  })
  it('never starts with a digit and is never empty', () => {
    expect(rosNamespace('101-arm')).toBe('arm_101_arm')
    expect(rosNamespace('---')).toBe('arm')
  })
  it('builds absolute topic paths', () => {
    expect(topicPath('left', 'jointStates')).toBe('/left/joint_states')
  })
})

describe('rosTime', () => {
  it('splits milliseconds into sec and nanosec', () => {
    expect(rosTime(1_700_000_000_123)).toEqual({ sec: 1_700_000_000, nanosec: 123_000_000 })
  })
})

describe('jointStateMsg', () => {
  it('reports every joint in the URDF radians the 3D view uses', () => {
    const ticks: Record<string, number> = { ...MID, elbow_flex: 2500, gripper: 1500 }
    const msg = jointStateMsg(manifest, 'SO101', ticks, RANGES, 5000)
    expect(msg.name).toEqual(manifest.joints.map((j) => j.name))
    for (const [i, name] of msg.name.entries()) {
      const joint = manifest.joints.find((j) => j.name === name)!
      const expected = jointAngleRad(
        joint,
        { position: ticks[name], rangeMin: 1000, rangeMax: 3000 },
        jointTuning('SO101', name)
      )
      expect(msg.position[i]).toBeCloseTo(expected, 9)
    }
    expect(msg.header.stamp).toEqual({ sec: 5, nanosec: 0 })
    expect(msg.velocity).toEqual([])
    expect(msg.effort).toEqual([])
  })

  it('leaves out joints it cannot convert rather than inventing an angle', () => {
    const { gripper: _gripper, ...ranges } = RANGES
    const msg = jointStateMsg(manifest, 'SO101', { shoulder_pan: 2000, gripper: 2000 }, ranges, 0)
    expect(msg.name).toEqual(['shoulder_pan'])
  })
})

describe('diagnosticsMsg', () => {
  it('converts register units and grades each motor', () => {
    const msg = diagnosticsMsg(
      'arm',
      {
        shoulder_pan: { temperature: 35, voltage: 121, load: 250, current: 100, status: 0 },
        elbow_flex: { temperature: 58, status: 0 },
        wrist_flex: { temperature: 40, status: 0x20 },
        gripper: {}
      },
      0
    )
    const byName = Object.fromEntries(msg.status.map((s) => [s.name, s]))
    const pan = byName['arm/shoulder_pan']
    expect(pan.level).toBe(DIAG_OK)
    expect(pan.hardware_id).toBe('arm')
    expect(Object.fromEntries(pan.values.map((v) => [v.key, v.value]))).toEqual({
      temperature_c: '35',
      voltage_v: '12.1',
      load_percent: '25.0',
      current_ma: '650',
      status: '0'
    })
    expect(byName['arm/elbow_flex'].level).toBe(DIAG_WARN)
    expect(byName['arm/wrist_flex'].level).toBe(DIAG_ERROR)
    expect(byName['arm/wrist_flex'].message).toContain('overload')
    expect(byName['arm/gripper'].level).toBe(DIAG_STALE)
  })
})

describe('urdfWithAbsoluteMeshes', () => {
  it('points relative meshes at file URLs and leaves the rest alone', () => {
    const urdf =
      '<mesh filename="assets/base.stl"/><mesh scale="1 1 1" filename="package://x/y.stl"/>'
    expect(urdfWithAbsoluteMeshes(urdf, '/opt/app/SO101/')).toBe(
      '<mesh filename="file:///opt/app/SO101/assets/base.stl"/><mesh scale="1 1 1" filename="package://x/y.stl"/>'
    )
  })
  it('handles Windows paths', () => {
    expect(urdfWithAbsoluteMeshes('<mesh filename="a.stl"/>', 'C:\\app\\SO101')).toBe(
      '<mesh filename="file:///C:/app/SO101/a.stl"/>'
    )
  })
})

/* ------------------------------------------------------------------ *
 * The websocket side, against a fake socket                           *
 * ------------------------------------------------------------------ */

class FakeSocket implements SocketLike {
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({})
  }
}

function harness() {
  const sockets: FakeSocket[] = []
  const client = new RosbridgeClient((url) => {
    const socket = new FakeSocket(url)
    sockets.push(socket)
    return socket
  })
  return { client, sockets, last: () => sockets[sockets.length - 1] }
}

describe('RosbridgeClient', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('advertises on connect, drops publishes while down, and re-advertises after a drop', () => {
    const { client, sockets, last } = harness()
    client.open('ws://ros:9090')
    client.advertise('/a/joint_states', 'jointStates')
    client.advertise('/a/robot_description', 'robotDescription')
    client.publish('/a/robot_description', { data: '<robot/>' })
    client.publish('/a/joint_states', { name: [] }) // not open yet: dropped
    expect(last().sent).toEqual([])

    last().open()
    expect(client.state).toBe('connected')
    expect(last().sent.map((f) => [f.op, f.topic])).toEqual([
      ['advertise', '/a/joint_states'],
      ['advertise', '/a/robot_description'],
      // Latched, so a late subscriber still gets it.
      ['publish', '/a/robot_description']
    ])
    expect(last().sent[1]).toMatchObject({ type: 'std_msgs/msg/String', latch: true })

    last().drop()
    expect(client.state).toBe('error')
    vi.advanceTimersByTime(600)
    expect(sockets).toHaveLength(2)
    last().open()
    expect(last().sent.map((f) => f.op)).toEqual(['advertise', 'advertise', 'publish'])
  })

  it('stops reconnecting once closed', () => {
    const { client, sockets, last } = harness()
    client.open('ws://ros:9090')
    last().drop()
    client.close()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(1)
    expect(client.state).toBe('idle')
  })
})

describe('RosPublisher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function publisher(ids: Record<string, string> = {}) {
    const h = harness()
    const pub = new RosPublisher({
      client: h.client,
      url: () => 'ws://ros:9090',
      resolveDevice: (uid) =>
        uid === 'virtual-arm'
          ? { id: 'virtual_arm', model: 'SO101', virtual: true }
          : { id: ids[uid] ?? `real-${uid}`, model: 'SO101', virtual: false },
      loadManifest: () => manifest,
      loadDescription: () => '<robot/>',
      readTelemetry: async () => ({ gripper: { temperature: 30, status: 0 } }),
      now: () => 1000
    })
    return { ...h, pub }
  }

  const topicsOf = (socket: FakeSocket, op: string): string[] =>
    socket.sent.filter((f) => f.op === op).map((f) => String(f.topic))

  it('routes virtual and bus frames to the right namespace, and commands too', () => {
    const { pub, last } = publisher()
    pub.attach({ uid: 'virtual-arm', mode: 'control', ranges: RANGES })
    pub.attach({ uid: 'L', mode: 'teleoperate', ranges: RANGES })
    last().open()

    pub.positions('bus', MID) // no bus device yet: nowhere to go
    pub.setBusDevice('L')
    pub.positions('bus', MID)
    pub.positions('virtual', MID)
    pub.command('virtual-arm', { gripper: 2000 })

    const published = topicsOf(last(), 'publish')
    expect(published).toContain('/real_L/joint_states')
    expect(published).toContain('/virtual_arm/joint_states')
    expect(published).toContain('/virtual_arm/joint_command')
    expect(published.filter((t) => t === '/real_L/joint_states')).toHaveLength(1)
    expect(pub.status().sessions.map((s) => [s.namespace, s.rate])).toEqual([
      ['virtual_arm', 0.5],
      ['real_L', 0.5]
    ])
  })

  it('publishes the session as ended on detach and closes the socket after the last one', () => {
    const { pub, last, client } = publisher()
    pub.attach({ uid: 'virtual-arm', mode: 'replay', ranges: RANGES })
    last().open()
    pub.detach('virtual-arm')

    const session = last()
      .sent.filter((f) => f.op === 'publish' && f.topic === '/virtual_arm/session')
      .map((f) => JSON.parse((f.msg as { data: string }).data) as { active: boolean; mode: string })
    expect(session.map((s) => s.active)).toEqual([true, false])
    expect(topicsOf(last(), 'unadvertise')).toEqual([
      '/virtual_arm/joint_states',
      '/virtual_arm/joint_command',
      '/virtual_arm/diagnostics'
    ])
    expect(client.state).toBe('connected')
    vi.advanceTimersByTime(3500)
    expect(client.state).toBe('idle')
  })

  it('sends diagnostics once a second while connected', async () => {
    const { pub, last } = publisher()
    pub.attach({ uid: 'virtual-arm', mode: 'control', ranges: RANGES })
    last().open()
    await vi.advanceTimersByTimeAsync(1000)
    expect(topicsOf(last(), 'publish')).toContain('/virtual_arm/diagnostics')
  })

  it('updates a session that is already attached instead of starting another', () => {
    const { pub } = publisher()
    pub.attach({ uid: 'a', mode: 'control', ranges: RANGES })
    pub.attach({ uid: 'a', mode: 'replay', ranges: RANGES })
    expect(pub.status().sessions.map((s) => [s.uid, s.mode])).toEqual([['a', 'replay']])
  })

  it('refuses two devices that would share a namespace', () => {
    const { pub } = publisher({ x1: 'my-arm', x2: 'my_arm' })
    pub.attach({ uid: 'x1', mode: 'control', ranges: RANGES })
    expect(() => pub.attach({ uid: 'x2', mode: 'control', ranges: RANGES })).toThrow(/both publish under \/my_arm/)
  })
})
