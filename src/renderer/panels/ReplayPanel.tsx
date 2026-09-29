import { applyPositions, poseFromReadings, readingsFromMotors, type JointReading } from '@shared/sim'
import type { BusSnapshot, DatasetMeta, ReplayOptions, RunInfo } from '@shared/types'
import { isVirtual } from '@shared/virtual'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArmViewport } from '../components/ArmViewport'
import { ConsolePane } from '../components/ConsolePane'
import { SplitLayout } from '../components/SplitLayout'
import { PathPicker } from '../components/PathPicker'
import { ProfileSelect } from '../components/ProfileSelect'
import { TransportBar } from '../components/TransportBar'
import {
  Badge,
  Button,
  CommandPreview,
  EmptyState,
  Field,
  Notice,
  NumberInput,
  Panel,
  Select,
  Spinner,
  TextInput
} from '../components/ui'
import { api } from '../lib/api'
import { loadArmKinematics } from '../lib/arm-kinematics'
import { useSticky } from '../lib/use-sticky'
import { rangesOf } from '../lib/use-leader-mirror'
import { useControlClaim } from '../lib/use-control-claim'
import { useRosPublish } from '../lib/use-ros-publish'
import { RosPublishToggle } from '../components/RosPublishToggle'
import { useEpisodeReplay } from '../lib/use-episode-replay'
import type { SimManifest } from '@shared/sim'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** Position stream rate while the app is replaying. Fast enough to animate. */
const STREAM_HZ = 30

/**
 * Replay: play a recorded episode back on a follower.
 *
 * `lerobot-replay` addresses a dataset by repo_id, not by file path, so this
 * panel takes a folder and derives the repo_id + `--dataset.root` from it, and
 * reads `meta/info.json` to offer a real episode list instead of a blind number.
 *
 * The virtual arm cannot be the other end of that command — there is no LeRobot
 * device behind it — so replaying onto it is done in the app instead: the
 * episode's actions are read through LeRobot's own dataset class and written as
 * goal positions at the rate they were recorded (`useEpisodeReplay`). The model
 * is shown alongside, because otherwise there would be nothing to watch.
 */
export function ReplayPanel(): ReactNode {
  const { caps, runs, activeRunId, setActiveRun } = useAppStore(useShallow((s) => ({
    caps: s.caps,
    runs: s.runs,
    activeRunId: s.activeRunId,
    setActiveRun: s.setActiveRun
  })))

  // The arm, the dataset and the episode survive a tab switch; the metadata
  // behind them is re-read on the way back in.
  const [opts, setOpts] = useSticky('replay.options', () => ({
    robotUid: null,
    datasetRoot: '',
    repoId: '',
    episode: 0,
    fps: null
  }))
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [local, setLocal] = useState<DatasetMeta[]>([])
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  /* -- replaying onto the virtual arm, in the app ------------------- */
  const [snapshot, setSnapshot] = useState<BusSnapshot | null>(null)
  const [readings, setReadings] = useState<Record<string, JointReading>>({})
  const [manifest, setManifest] = useState<SimManifest | null>(null)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok
  const profiles = useAppStore((s) => s.profiles)
  const robotProfile = profiles.find((p) => p.uid === opts.robotUid) ?? null
  /** The app replays onto the virtual arm itself; `lerobot-replay` cannot. */
  const simulated = isVirtual(opts.robotUid)
  const set = <K extends keyof ReplayOptions>(key: K, value: ReplayOptions[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }))

  const replay = useEpisodeReplay({
    uid: opts.robotUid,
    root: opts.datasetRoot,
    repoId: opts.repoId,
    episode: opts.episode,
    ranges: useMemo(() => rangesOf(snapshot?.motors ?? []), [snapshot])
  })
  const playing = replay.status === 'playing' || replay.status === 'paused'
  useControlClaim('replay.episode', playing)
  const ros = useRosPublish({
    panel: 'replay',
    active: playing,
    mode: 'replay',
    devices: [{ uid: opts.robotUid, ranges: useMemo(() => rangesOf(snapshot?.motors ?? []), [snapshot]) }]
  })

  /**
   * Open the simulation and watch it.
   *
   * Its positions come back on the same stream a real arm's do, which is what
   * poses the model beside the transport controls.
   */
  useEffect(() => {
    if (!simulated || !opts.robotUid) {
      setSnapshot(null)
      setReadings({})
      return
    }
    const uid = opts.robotUid
    let cancelled = false
    void api.bus.connect(uid).then(async (res) => {
      if (cancelled || !res.ok) return
      setSnapshot(res.value)
      setReadings(readingsFromMotors(res.value.motors))
      await api.bus.streamStart(uid, STREAM_HZ)
    })
    return () => {
      cancelled = true
      void api.bus.streamStop(uid)
    }
  }, [simulated, opts.robotUid])

  useEffect(() => {
    if (!simulated) return
    return api.bridge.onNotification((frame) => {
      if (frame.type !== 'positions' || frame.source !== 'virtual') return
      setReadings((prev) => applyPositions(prev, frame.positions as Record<string, number>))
    })
  }, [simulated])

  const model = simulated ? (robotProfile?.model ?? null) : null
  useEffect(() => {
    if (!model) {
      setManifest(null)
      return
    }
    let cancelled = false
    void loadArmKinematics(model)
      .then((loaded) => !cancelled && setManifest(loaded.manifest))
      .catch(() => !cancelled && setManifest(null))
    return () => {
      cancelled = true
    }
  }, [model])

  const discover = useCallback(async (): Promise<void> => {
    setScanning(true)
    const res = await api.datasets.discover()
    if (res.ok) setLocal(res.value)
    setScanning(false)
  }, [])

  useEffect(() => {
    if (envReady) void discover()
  }, [envReady, discover])

  /** Read a folder's metadata, which is what offers a real episode list. */
  const loadMeta = useCallback(async (root: string): Promise<DatasetMeta | null> => {
    const res = await api.datasets.read(root)
    setMeta(res.ok ? res.value : null)
    return res.ok ? res.value : null
  }, [])

  /** Pick a folder: read its metadata and adopt the repo_id and fps it implies. */
  const loadRoot = useCallback(
    async (root: string): Promise<void> => {
      const meta = await loadMeta(root)
      if (!meta) return
      setOpts((o) => ({
        ...o,
        datasetRoot: root,
        repoId: meta.repoId,
        episode: meta.episodes[0] ?? 0,
        fps: meta.fps
      }))
    },
    [loadMeta, setOpts]
  )

  /**
   * Read the metadata again for a dataset chosen before a tab switch.
   *
   * Without this the folder and episode come back but the episode *list* does
   * not, so a selection made from a dropdown would reappear in a bare number
   * box. `loadMeta` rather than `loadRoot`, which would reset the episode to the
   * first one and undo half the restore.
   */
  useEffect(() => {
    if (opts.datasetRoot && !meta) void loadMeta(opts.datasetRoot)
  }, [opts.datasetRoot, meta, loadMeta])

  useEffect(() => {
    if (!envReady || simulated) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    void api.commands.preview('replay', opts).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setPreview(res.value.display)
        setPreviewError(null)
      } else {
        setPreview(null)
        setPreviewError(res.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [opts, envReady, simulated])

  const start = async (): Promise<void> => {
    setStartError(null)
    const res = await api.runs.start('replay', opts)
    if (res.ok) setActiveRun(res.value.runId)
    else setStartError(res.error)
  }

  const missing = !opts.robotUid
    ? 'Select the arm to replay on.'
    : !opts.repoId.trim()
      ? 'Select a dataset.'
      : meta && meta.totalEpisodes === 0
        ? 'This dataset has no episodes.'
        : null

  return (
    <SplitLayout
      id="replay"
      mainClassName="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
      sideClassName="flex min-h-0 flex-col gap-4 overflow-hidden"
      main={
        <>
          <Panel title="Device" description="The follower that will reproduce the recorded motion.">
            <div className="flex flex-col gap-3">
              <Field
                label="Robot (follower)"
                hint="Pick the virtual arm to watch an episode back with no hardware connected."
              >
                <ProfileSelect role="robot" value={opts.robotUid} onChange={(uid) => set('robotUid', uid)} />
              </Field>
              {simulated && (
                <Notice tone="info" title="Replayed by the app">
                  <code>lerobot-replay</code> has no device to drive at this end, so the app reads the
                  episode itself and writes each frame's action to the simulation. Reading the dataset
                  still goes through LeRobot, so a Python environment is needed even though nothing is
                  driven by it.
                </Notice>
              )}
            </div>
          </Panel>

          <Panel
            title="Dataset"
            description="Pick a dataset folder — the one containing meta/ and data/."
            actions={
              <Button size="sm" variant="secondary" disabled={scanning || !envReady} onClick={() => void discover()}>
                {scanning ? <Spinner /> : 'Rescan'}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {local.length > 0 && (
                <Field label="Datasets found on this machine">
                  <Select
                    value={local.some((d) => d.root === opts.datasetRoot) ? opts.datasetRoot : null}
                    onChange={(root) => void loadRoot(root)}
                    placeholder="Select a dataset…"
                    options={local.map((d) => ({
                      value: d.root,
                      label: `${d.repoId} — ${d.totalEpisodes ?? '?'} episode${d.totalEpisodes === 1 ? '' : 's'}`
                    }))}
                  />
                </Field>
              )}

              <Field label="…or browse to a folder">
                <PathPicker
                  mode="directory"
                  title="Select the dataset folder"
                  value={opts.datasetRoot}
                  onChange={(root) => void loadRoot(root)}
                  onReveal
                />
              </Field>

              {meta?.warning && <Notice tone="warn">{meta.warning}</Notice>}

              {meta && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-ink-600">Repo id</dt>
                  <dd className="font-mono text-ink-100">{meta.repoId}</dd>
                  <dt className="text-ink-600">Episodes</dt>
                  <dd className="font-mono text-ink-300">{meta.totalEpisodes ?? '—'}</dd>
                  <dt className="text-ink-600">Frames</dt>
                  <dd className="font-mono text-ink-300">{meta.totalFrames ?? '—'}</dd>
                  <dt className="text-ink-600">Recorded at</dt>
                  <dd className="font-mono text-ink-300">{meta.fps ? `${meta.fps} fps` : '—'}</dd>
                  <dt className="text-ink-600">Robot type</dt>
                  <dd className="font-mono text-ink-300">{meta.robotType ?? '—'}</dd>
                </dl>
              )}

              <Field
                label="Dataset name"
                hint="Derived from the folder. Edit only if LeRobot expects a different repo_id."
              >
                <TextInput
                  value={opts.repoId}
                  spellCheck={false}
                  onChange={(e) => set('repoId', e.currentTarget.value)}
                  className="font-mono text-xs"
                />
              </Field>

              <Field label="Episode">
                {meta && meta.episodes.length > 0 ? (
                  <Select
                    value={opts.episode}
                    onChange={(v) => set('episode', Number(v))}
                    options={meta.episodes.map((i) => ({ value: i, label: `Episode ${i}` }))}
                  />
                ) : (
                  <NumberInput
                    value={opts.episode}
                    min={0}
                    className="w-28"
                    onChange={(e) => set('episode', Number(e.currentTarget.value) || 0)}
                  />
                )}
              </Field>

              {meta?.robotType && (
                <Notice tone="info">
                  This dataset was recorded on <code>{meta.robotType}</code>. Replaying on a different arm
                  model can move joints beyond their calibrated range.
                </Notice>
              )}
            </div>
          </Panel>

          {simulated && (
            <Panel
              title={robotProfile ? `${robotProfile.id} — ${robotProfile.model}` : 'Arm'}
              bodyClassName="flex flex-col"
              description={
                playing ? 'Following the recorded actions' : 'The simulation, waiting for an episode'
              }
              actions={
                <Badge tone={playing ? 'accent' : 'neutral'}>
                  {replay.status === 'playing'
                    ? 'replaying'
                    : replay.status === 'paused'
                      ? 'paused'
                      : replay.status === 'finished'
                        ? 'finished'
                        : 'idle'}
                </Badge>
              }
            >
              <ArmViewport
                model={robotProfile?.model ?? null}
                pose={manifest ? poseFromReadings(manifest, readings) : {}}
                className="h-72"
                placeholder="Loading the model…"
              />
            </Panel>
          )}
        </>
      }
      side={
        simulated ? (
          <>
            <Panel title="Replay" className="shrink-0">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {replay.status === 'playing' ? (
                    <Button variant="secondary" onClick={replay.pause}>
                      Pause
                    </Button>
                  ) : replay.status === 'paused' ? (
                    <Button variant="live" onClick={replay.resume}>
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="live"
                      disabled={!envReady || missing !== null || replay.status === 'loading'}
                      onClick={() => void replay.start()}
                    >
                      {replay.status === 'loading' ? <Spinner /> : 'Start replay'}
                    </Button>
                  )}
                  <Button variant="danger" disabled={replay.status === 'idle'} onClick={replay.stop}>
                    Stop
                  </Button>
                </div>

                <RosPublishToggle ros={ros} />

                {!envReady && (
                  <Notice tone="warn">
                    Reading the episode goes through LeRobot, so set up the environment in Settings
                    first.
                  </Notice>
                )}
                {missing && <Notice tone="warn">{missing}</Notice>}
                {replay.error && (
                  <Notice tone="error" title="Replay failed">
                    {replay.error}
                  </Notice>
                )}
                {replay.truncated && (
                  <Notice tone="warn">
                    This episode has {replay.total} frames, more than one read returns, so only the
                    first {replay.loaded} are replayed.
                  </Notice>
                )}

                {replay.total > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-shell-800">
                      <span
                        className="block h-full bg-accent-500 transition-[width] duration-100"
                        style={{ width: `${Math.min(100, (replay.frame / replay.loaded) * 100)}%` }}
                      />
                    </div>
                    <p className="font-mono text-[11px] tabular-nums text-ink-500">
                      frame {replay.frame} / {replay.loaded} at {replay.fps.toFixed(0)} fps
                    </p>
                  </div>
                )}
              </div>
            </Panel>

            {!meta && (
              <Panel scrollBody title="Dataset" className="min-h-0 flex-1">
                <EmptyState title="No dataset selected">
                  Choose a dataset above. Recordings made from the Teleoperate panel appear in the
                  list automatically.
                </EmptyState>
              </Panel>
            )}
          </>
        ) : (
        <>
          <Panel title="Run" className="shrink-0">
            <div className="flex flex-col gap-3">
              {!caps?.hasReplay && envReady && (
                <Notice tone="warn" title="lerobot-replay is not installed">
                  Install LeRobot with the <code>core_scripts</code> extra from Settings.
                </Notice>
              )}
              <TransportBar
                run={run?.kind === 'replay' ? run : null}
                startLabel="Start replay"
                disabled={!envReady || !caps?.hasReplay || missing !== null}
                disabledReason={!envReady ? 'Set up the environment in Settings first.' : missing}
                onStart={start}
              />
              <RosPublishToggle ros={ros} unavailable="LeRobot commands hold the serial port themselves, so the app has no readings to publish from them yet. Publishing works for driving from the app: the virtual arm, keyboard and gamepad." />
              {startError && (
                  <Notice tone="error" onClose={() => setStartError(null)}>
                    {startError}
                  </Notice>
                )}
              <CommandPreview command={preview} error={previewError} />
            </div>
          </Panel>

          {!meta ? (
            <Panel scrollBody title="Output" className="min-h-0 flex-1">
              <EmptyState title="No dataset selected">
                Choose a dataset above. Recordings made from the Teleoperate panel appear in the list
                automatically.
              </EmptyState>
            </Panel>
          ) : (
            <ConsolePane run={run} className="min-h-0 flex-1" heightClass="" />
          )}
        </>
        )
      }
    />
  )
}
