import { STS3215_MAX_TICK } from '@shared/devices'
import {
  applyPositions,
  poseFromReadings,
  readingsFromMotors,
  type JointReading,
  type SimManifest
} from '@shared/sim'
import type { BusSnapshot } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SplitLayout } from '../components/SplitLayout'
import { Badge, Button, Field, Notice, Panel, Select, Spinner } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { ArmScene, loadSimManifest } from '../lib/arm-scene'
import { useResolvedTheme } from '../lib/theme'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** Position stream rate. Higher than Configure's 10 Hz — this is animation. */
const STREAM_HZ = 30

/**
 * 3D View: the selected follower's own model, standing on a surface, posed from
 * what its motors are actually reporting.
 *
 * The scene is built offline in Blender from the URDF and STL parts that ship in
 * `assets/simulation` (`tools/blender/build_sim_scene.py`), so the app only
 * loads a glb and writes one rotation per joint. The tick-to-angle conversion
 * lives in `@shared/sim` and follows LeRobot's own: a tick is 360/4095 degrees
 * of joint, measured from the middle of the calibrated range.
 */
export function View3DPanel(): ReactNode {
  const { profiles, caps } = useAppStore(
    useShallow((s) => ({ profiles: s.profiles, caps: s.caps }))
  )
  const followers = useMemo(() => profiles.filter((p) => p.role === 'robot'), [profiles])

  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<BusSnapshot | null>(null)
  const [readings, setReadings] = useState<Record<string, JointReading>>({})
  const [manifest, setManifest] = useState<SimManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<ArmScene | null>(null)
  const theme = useResolvedTheme()

  const device = followers.find((p) => p.uid === selectedUid) ?? null
  const envReady = !!caps?.ok
  const live = snapshot?.source === 'live'

  useEffect(() => {
    if (!selectedUid && followers.length > 0) setSelectedUid(followers[0].uid)
  }, [followers, selectedUid])

  /* -- the WebGL scene ---------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      sceneRef.current = new ArmScene(canvas)
    } catch (err) {
      setSceneError(
        `This window could not start WebGL, so the 3D view cannot be drawn. ${errorMessage(err)}`
      )
      return
    }
    const scene = sceneRef.current
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // Load the model for whichever arm is selected. Keyed on the model, not the
  // device: two followers of the same model share one scene.
  const model = device?.model ?? null
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !model) return
    let cancelled = false
    setLoading(true)
    setSceneError(null)
    void loadSimManifest(model)
      .then(async (loaded) => {
        if (cancelled) return
        await scene.load(loaded)
        if (cancelled) return
        setManifest(loaded)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setManifest(null)
        setSceneError(
          `Could not load the ${model} scene. Rebuild it with \`npm run build:sim\`. ${errorMessage(err)}`
        )
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [model])

  useEffect(() => sceneRef.current?.setTheme(theme), [theme, manifest])

  // Pose the model. `immediate` on the first pose after a load, so the arm does
  // not visibly swing in from the URDF's rest position.
  const posedOnce = useRef(false)
  useEffect(() => {
    posedOnce.current = false
  }, [manifest])
  useEffect(() => {
    if (!manifest) return
    sceneRef.current?.setPose(poseFromReadings(manifest, readings), {
      immediate: !posedOnce.current
    })
    posedOnce.current = true
  }, [manifest, readings])

  /* -- the bus ------------------------------------------------------ */

  const showSnapshot = useCallback((next: BusSnapshot) => {
    setSnapshot(next)
    setReadings(readingsFromMotors(next.motors))
  }, [])

  const loadOffline = useCallback(async () => {
    if (!device) return
    const res = await api.bus.offlineSnapshot(device.uid)
    if (res.ok) showSnapshot(res.value)
    else setActionError(res.error)
  }, [device?.uid, showSnapshot])

  // A calibration file is enough to pose the arm at its recorded centre, so the
  // model is never stuck at the URDF's rest pose just because nothing is plugged
  // in. Reading a JSON file needs no Python environment.
  useEffect(() => {
    setSnapshot(null)
    setReadings({})
    setStreaming(false)
    if (device) void loadOffline()
  }, [device?.uid, loadOffline])

  useEffect(() => {
    if (!streaming) return
    return api.bridge.onNotification((frame) => {
      if (frame.type === 'streamError') {
        setActionError(String(frame.message ?? 'The position stream failed.'))
        if (frame.fatal === true) setStreaming(false)
        return
      }
      if (frame.type !== 'positions') return
      const positions = frame.positions as Record<string, number>
      setReadings((prev) => applyPositions(prev, positions))
    })
  }, [streaming])

  const connect = useCallback(async () => {
    if (!device) return
    setConnecting(true)
    setActionError(null)
    const res = await api.bus.connect(device.uid)
    if (res.ok) {
      showSnapshot(res.value)
      if (res.value.source === 'live') {
        const started = await api.bus.streamStart(STREAM_HZ)
        setStreaming(started.ok)
      }
    } else {
      setActionError(res.error)
    }
    setConnecting(false)
  }, [device?.uid, showSnapshot])

  const disconnect = useCallback(async () => {
    await api.bus.streamStop()
    await api.bus.disconnect()
    setStreaming(false)
    await loadOffline()
  }, [loadOffline])

  // Leave the bus free for the other panels.
  useEffect(() => {
    return () => {
      void api.bus.streamStop()
      void api.bus.disconnect()
    }
  }, [])

  const pose = manifest ? poseFromReadings(manifest, readings) : {}
  const uncalibrated = snapshot?.motors.some((m) => m.rangeMin === null) ?? false

  return (
    <SplitLayout
      id="view3d"
      defaultWidth={340}
      minMain={420}
      mainClassName="flex min-h-0 min-w-0 flex-1 flex-col"
      sideClassName="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1"
      main={
        <Panel
          className="min-h-0 flex-1"
          bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
          title={device ? `${device.id} — ${device.model} follower` : '3D view'}
          description={
            live
              ? `Live from ${snapshot?.port} — the model follows every reading`
              : snapshot?.source === 'calibration-file'
                ? 'Posed from the calibration file — connect the arm to follow it live'
                : device
                  ? 'Factory defaults — calibrate this arm for a pose that means something'
                  : 'Select a follower to load its model'
          }
          actions={
            <div className="flex items-center gap-2">
              {manifest && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Back to the default camera framing."
                  onClick={() => sceneRef.current?.resetView()}
                >
                  Reset view
                </Button>
              )}
              {live ? (
                <>
                  <Badge tone="live">{streaming ? 'following' : 'connected'}</Badge>
                  <Button size="sm" variant="secondary" onClick={() => void disconnect()}>
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!device || !device.port || connecting || !envReady}
                  title={
                    !envReady
                      ? 'Set up Python and install LeRobot in Settings first.'
                      : !device?.port
                        ? 'Select this device’s serial port in Configure first.'
                        : 'Opens the bus and drives the model from the live positions.'
                  }
                  onClick={() => void connect()}
                >
                  {connecting ? <Spinner /> : 'Follow the arm'}
                </Button>
              )}
            </div>
          }
        >
          {sceneError && <Notice tone="error">{sceneError}</Notice>}
          {actionError && (
            <Notice tone="error" onClose={() => setActionError(null)}>
              {actionError}
            </Notice>
          )}
          {uncalibrated && !sceneError && (
            <Notice tone="warn" title="This arm has no calibration yet">
              Without a recorded range there is nothing to measure a position against, so the model is
              posed off the full encoder span. Calibrate it in Configure for a pose that matches the arm.
            </Notice>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-plate">
            <canvas ref={canvasRef} className="absolute inset-0 block" />
            {(loading || !device) && (
              <div className="absolute inset-0 flex items-center justify-center bg-plate/80 text-sm text-ink-500">
                {!device ? (
                  followers.length === 0 ? (
                    'Add a follower arm in Configure first.'
                  ) : (
                    'Select a follower.'
                  )
                ) : (
                  <span className="flex items-center gap-2">
                    <Spinner /> Loading the {device.model} model…
                  </span>
                )}
              </div>
            )}
          </div>
        </Panel>
      }
      side={
        <>
          <Panel collapsible title="Follower">
            <Field label="Saved followers" hint="Leader arms are configured, not simulated.">
              <Select
                value={selectedUid}
                onChange={setSelectedUid}
                placeholder={followers.length === 0 ? 'No follower arms yet' : 'Select a follower'}
                options={followers.map((p) => ({
                  value: p.uid,
                  label: `${p.id} — ${p.model}`
                }))}
              />
            </Field>
          </Panel>

          <Panel
            collapsible
            title="Joints"
            description={live ? `Streaming at ${STREAM_HZ} Hz` : 'Ticks as last read'}
          >
            <JointTable
              manifest={manifest}
              readings={readings}
              pose={pose}
              names={snapshot?.motors.map((m) => ({ name: m.name, label: m.label })) ?? []}
            />
          </Panel>

          {manifest && (
            <Panel collapsible defaultOpen={false} title="Scene">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <SceneRow label="Model" value={manifest.model} />
                <SceneRow label="Source" value={manifest.urdf} mono />
                <SceneRow label="Triangles" value={manifest.triangles.toLocaleString()} />
                <SceneRow label="Built by" value={manifest.generator} mono />
                <SceneRow label="Built at" value={manifest.generatedAt} mono />
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-ink-600">
                Rebuild after editing the URDFs or the scene with{' '}
                <code className="font-mono text-ink-500">npm run build:sim</code>, which needs Blender
                on the PATH or installed in the usual place.
              </p>
            </Panel>
          )}
        </>
      }
    />
  )
}

function SceneRow({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): ReactNode {
  return (
    <>
      <dt className="text-ink-600">{label}</dt>
      <dd className={`break-all text-ink-300 ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </>
  )
}

/** Ticks in, degrees out — the same conversion the model is posed with. */
function JointTable({
  manifest,
  readings,
  pose,
  names
}: {
  manifest: SimManifest | null
  readings: Record<string, JointReading>
  pose: Record<string, number>
  names: { name: string; label: string }[]
}): ReactNode {
  if (!manifest) return <p className="text-xs text-ink-600">No model loaded.</p>
  const labels = new Map(names.map((n) => [n.name, n.label]))

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-ink-600">
          <th className="pb-1 font-normal">Joint</th>
          <th className="pb-1 text-right font-normal">Ticks</th>
          <th className="pb-1 text-right font-normal">Angle</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {manifest.joints.map((joint) => {
          const reading = readings[joint.name]
          const degrees = ((pose[joint.name] ?? joint.rest) * 180) / Math.PI
          const span =
            reading?.rangeMin != null && reading?.rangeMax != null
              ? `${reading.rangeMin}–${reading.rangeMax}`
              : `0–${STS3215_MAX_TICK} (uncalibrated)`
          return (
            <tr key={joint.name} className="border-t border-shell-700/60" title={`Range ${span}`}>
              <td className="py-1 font-sans text-ink-300">{labels.get(joint.name) ?? joint.name}</td>
              <td className="py-1 text-right text-ink-500">{reading?.position ?? '—'}</td>
              <td className="py-1 text-right text-ink-100">{degrees.toFixed(1)}°</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
