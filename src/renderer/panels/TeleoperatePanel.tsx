import type { ArmModel } from '@shared/devices'
import {
  ARM_SPACING_CM,
  IDLE_RIG_STATUS,
  SIDE_FIELDS,
  gamepadIndex,
  lerobotUnsupported,
  sideCamera,
  sideLabel,
  teleopSides,
  validateSides,
  type RigSideId,
  type RigSideInfo,
  type RigStatus,
  type TeleopSideSpec
} from '@shared/rig'
import {
  applyPositions,
  poseFromReadings,
  readingsFromMotors,
  type JointReading,
  type SimManifest
} from '@shared/sim'
import { drivenInApp } from '@shared/teleop-input'
import type { DeviceProfile, RunInfo, TeleoperateOptions, TeleopController } from '@shared/types'
import { isVirtual } from '@shared/virtual'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArmViewport } from '../components/ArmViewport'
import { CameraFeed } from '../components/CameraFeed'
import { CameraSelect } from '../components/CameraSelect'
import { ConsolePane } from '../components/ConsolePane'
import { EeControls } from '../components/EeControls'
import { PathPicker } from '../components/PathPicker'
import { ProfileSelect } from '../components/ProfileSelect'
import { RosPublishToggle } from '../components/RosPublishToggle'
import { SplitLayout } from '../components/SplitLayout'
import { TransportBar } from '../components/TransportBar'
import {
  Badge,
  Button,
  CommandPreview,
  Divider,
  Field,
  Notice,
  NumberInput,
  Panel,
  Select,
  Spinner,
  TextInput,
  Toggle
} from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { loadArmKinematics, type ArmKinematics } from '../lib/arm-kinematics'
import { loadSimManifest } from '../lib/arm-scene'
import { useEscapeToStop } from '../lib/use-arm-control'
import { useControlClaim } from '../lib/use-control-claim'
import { useEeDrive } from '../lib/use-ee-drive'
import { rangesOf } from '../lib/use-leader-mirror'
import { useRosPublish } from '../lib/use-ros-publish'
import { useSticky } from '../lib/use-sticky'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

function defaults(datasetRoot: string): TeleoperateOptions {
  return {
    setup: 'single',
    runner: 'app',
    controller: 'leader',
    robotUid: null,
    leaderUid: null,
    cameraKey: null,
    showCamera: false,
    leftController: 'leader',
    rightController: 'leader',
    leftRobotUid: null,
    rightRobotUid: null,
    leftLeaderUid: null,
    rightLeaderUid: null,
    leftCameraKey: null,
    rightCameraKey: null,
    leftShowCamera: false,
    rightShowCamera: false,
    armSpacingCm: ARM_SPACING_CM.default,
    autoRecord: false,
    bimanualRobotId: 'bimanual_follower',
    bimanualLeaderId: 'bimanual_leader',
    fps: 30,
    displayData: false,
    useCameras: false,
    record: false,
    datasetRepoId: '',
    datasetRoot,
    singleTask: '',
    numEpisodes: 5,
    episodeTimeS: 60,
    resetTimeS: 15,
    pushToHub: false,
    resume: false
  }
}

const CONTROLLERS: { value: TeleopController; label: string }[] = [
  { value: 'leader', label: 'Leader arm' },
  { value: 'keyboard', label: 'Keyboard' },
  { value: 'gamepad', label: 'Gamepad' }
]

type Readings = Partial<Record<RigSideId, Record<string, JointReading>>>

/**
 * Teleoperate: drive one arm or two, and record what happens as a dataset.
 *
 * The app runs the loop itself (`@shared/rig`): leader arms through LeRobot's
 * own device classes in the sidecar, the keyboard and gamepad through the app's
 * inverse kinematics, the virtual arm in process. That is what lets recording
 * start and stop on demand — one episode each time — and lets the 3D view,
 * camera feeds and ROS 2 follow every setup. A leader-only setup can still be
 * handed to `lerobot-teleoperate` / `lerobot-record` instead.
 */
export function TeleoperatePanel(): ReactNode {
  const { settings, caps, profiles, runs, activeRunId, setActiveRun } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      caps: s.caps,
      profiles: s.profiles,
      runs: s.runs,
      activeRunId: s.activeRunId,
      setActiveRun: s.setActiveRun
    }))
  )

  // Everything chosen here survives a tab switch; what was read from the arms
  // does not, and is re-read when control is next taken.
  const [stored, setOpts] = useSticky('teleoperate.options', () =>
    defaults(settings?.defaultDatasetRoot ?? '')
  )
  // Selections kept from before a field existed fill in from the defaults.
  const opts = useMemo(() => ({ ...defaults(''), ...stored }), [stored])
  const set = useCallback(
    <K extends keyof TeleoperateOptions>(key: K, value: TeleoperateOptions[K]): void =>
      setOpts((o) => ({ ...defaults(''), ...o, [key]: value })),
    [setOpts]
  )
  const sides = useMemo(() => teleopSides(opts), [opts])
  const profileOf = (uid: string | null): DeviceProfile | null => profiles.find((p) => p.uid === uid) ?? null

  const envReady = !!caps?.ok
  const inApp = drivenInApp(opts)
  const lerobotReason = lerobotUnsupported(sides)

  useEffect(() => {
    if (settings?.defaultDatasetRoot && !opts.datasetRoot) set('datasetRoot', settings.defaultDatasetRoot)
  }, [settings?.defaultDatasetRoot, opts.datasetRoot, set])

  // A setup LeRobot cannot run goes back to the app rather than offering a dead button.
  useEffect(() => {
    if (!inApp && lerobotReason) set('runner', 'app')
  }, [inApp, lerobotReason, set])

  /* -- the rig ------------------------------------------------------ */

  const [engaged, setEngaged] = useState(false)
  const [engaging, setEngaging] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [loopError, setLoopError] = useState<string | null>(null)
  const [rigSides, setRigSides] = useState<RigSideInfo[]>([])
  const [readings, setReadings] = useState<Readings>({})
  const [canRecord, setCanRecord] = useState(false)
  const [recordReason, setRecordReason] = useState<string | null>(null)
  const [rigStatus, setRigStatus] = useState<RigStatus>(IDLE_RIG_STATUS)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [speed, setSpeed] = useSticky('teleoperate.speed', () => 1)

  useEffect(() => api.rig.onStatus(setRigStatus), [])
  useEffect(() => api.rig.onError((message) => setLoopError(message)), [])
  useEffect(() => {
    if (!engaged) return
    return api.rig.onFrame((frames) => {
      setReadings((prev) => {
        const next = { ...prev }
        for (const frame of frames) {
          if (frame.follower) next[frame.side] = applyPositions(next[frame.side] ?? {}, frame.follower)
        }
        return next
      })
    })
  }, [engaged])

  const engage = useCallback(async (): Promise<void> => {
    setEngaging(true)
    setStartError(null)
    setLoopError(null)
    setRecordError(null)
    try {
      const res = await api.rig.start({ setup: opts.setup, fps: opts.fps, sides })
      if (!res.ok) {
        setStartError(res.error)
        return
      }
      setRigSides(res.value.sides)
      setReadings(
        Object.fromEntries(res.value.sides.map((s) => [s.side, readingsFromMotors(s.follower.motors)]))
      )
      setCanRecord(res.value.canRecord)
      setRecordReason(res.value.recordReason)
      setEngaged(true)
    } finally {
      setEngaging(false)
    }
  }, [opts.setup, opts.fps, sides])

  const disengage = useCallback(async (): Promise<void> => {
    setEngaged(false)
    // Stopping the rig saves an episode being recorded and finishes the dataset.
    await api.rig.stop()
    setRigSides([])
  }, [])

  // Changing what is driven releases whatever was being driven.
  const sidesKey = JSON.stringify(sides.map((s) => [s.side, s.controller, s.robotUid, s.leaderUid, s.cameraKey]))
  const engagedRef = useRef(engaged)
  engagedRef.current = engaged
  useEffect(() => {
    if (engagedRef.current) void disengage()
  }, [sidesKey, opts.setup, opts.fps, disengage])

  // Nothing drives an arm once this panel is gone.
  useEffect(
    () => () => {
      if (engagedRef.current) void api.rig.stop()
    },
    []
  )

  useEscapeToStop(engaged, () => void disengage())
  useControlClaim('teleoperate.engaged', engaged)

  /* -- recording ----------------------------------------------------- */

  const recordMissing = !opts.datasetRepoId.trim()
    ? 'Give the dataset a name.'
    : !opts.singleTask.trim()
      ? 'Describe the task being recorded.'
      : null
  const recording = rigStatus.phase === 'recording'
  const saving = rigStatus.phase === 'saving'

  const startRecording = useCallback(async (): Promise<void> => {
    setRecordError(null)
    const res = await api.rig.recordStart({
      repoId: opts.datasetRepoId.trim(),
      root: opts.datasetRoot,
      task: opts.singleTask.trim()
    })
    if (!res.ok) setRecordError(res.error)
  }, [opts.datasetRepoId, opts.datasetRoot, opts.singleTask])

  const stopRecording = useCallback(async (discard = false): Promise<void> => {
    const res = await api.rig.recordStop(discard)
    if (!res.ok) setRecordError(res.error)
  }, [])

  // Auto-record: each drive is one episode.
  useEffect(() => {
    if (!engaged || !opts.autoRecord || !canRecord || recordMissing) return
    void startRecording()
    // Only when driving starts; stopping the rig saves the episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged])

  /* -- keyboard and gamepad ------------------------------------------ */

  const eeSides = sides.filter((s) => s.controller !== 'leader')
  const [kinematics, setKinematics] = useState<Partial<Record<ArmModel, ArmKinematics>>>({})
  const [kinematicsError, setKinematicsError] = useState<string | null>(null)
  const eeModels = [...new Set(eeSides.map((s) => profileOf(s.robotUid)?.model).filter((m): m is ArmModel => !!m))]
  const eeModelsKey = eeModels.join('|')
  useEffect(() => {
    let cancelled = false
    setKinematicsError(null)
    for (const model of eeModelsKey ? (eeModelsKey.split('|') as ArmModel[]) : []) {
      void loadArmKinematics(model)
        .then((loaded) => !cancelled && setKinematics((k) => ({ ...k, [model]: loaded })))
        .catch((err: unknown) => {
          if (cancelled) return
          setKinematicsError(
            `Could not read the ${model} kinematics out of the assets folder, so the tool cannot be solved for. ${errorMessage(err)}`
          )
        })
    }
    return () => {
      cancelled = true
    }
  }, [eeModelsKey])

  const driveFor = (index: number) => {
    const spec = sides[index]
    const ee = spec && spec.controller !== 'leader'
    const model = spec ? profileOf(spec.robotUid)?.model : undefined
    return {
      uid: spec?.robotUid ?? null,
      controller: (ee ? spec.controller : 'keyboard') as 'keyboard' | 'gamepad',
      engaged: engaged && !!ee,
      kinematics: (model && kinematics[model]) || null,
      readings: (spec && readings[spec.side]) || {},
      speed,
      padIndex: spec ? gamepadIndex(sides, spec.side) : 0
    }
  }
  const driveA = useEeDrive(driveFor(0))
  const driveB = useEeDrive(driveFor(1))
  const drives = [driveA, driveB]
  const kinematicsReady = eeSides.every((s) => {
    const model = profileOf(s.robotUid)?.model
    return !!model && !!kinematics[model]
  })

  // Every side's scene description, to pose its model from readings.
  const [manifests, setManifests] = useState<Partial<Record<ArmModel, SimManifest>>>({})
  const sideModelsKey = [
    ...new Set(sides.map((s) => profileOf(s.robotUid)?.model).filter((m): m is ArmModel => !!m))
  ].join('|')
  useEffect(() => {
    let cancelled = false
    for (const model of sideModelsKey ? (sideModelsKey.split('|') as ArmModel[]) : []) {
      void loadSimManifest(model)
        .then((loaded) => !cancelled && setManifests((m) => ({ ...m, [model]: loaded })))
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [sideModelsKey])

  /* -- ROS 2 ---------------------------------------------------------- */

  const ros = useRosPublish({
    panel: 'teleoperate',
    active: engaged,
    mode: 'teleoperate',
    devices: rigSides.flatMap((s) => [
      { uid: s.robotUid, ranges: rangesOf(s.follower.motors) },
      ...(s.leader && s.leaderUid ? [{ uid: s.leaderUid, ranges: rangesOf(s.leader.motors) }] : [])
    ])
  })

  /* -- the LeRobot command path ---------------------------------------- */

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  useEffect(() => {
    if (!envReady || inApp) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    void api.commands.preview('teleoperate', opts).then((res) => {
      if (cancelled) return
      setPreview(res.ok ? res.value.display : null)
      setPreviewError(res.ok ? null : res.error)
    })
    return () => {
      cancelled = true
    }
  }, [opts, envReady, inApp])

  const startCli = async (): Promise<void> => {
    setStartError(null)
    const res = await api.runs.start('teleoperate', opts)
    if (res.ok) setActiveRun(res.value.runId)
    else setStartError(res.error)
  }

  /* -- view ------------------------------------------------------------ */

  const missing = inApp ? validateSides(sides) : (validateSides(sides) ?? lerobotReason ?? cliMissing(opts))
  const viewArms = sides.map((s) => {
    const model = profileOf(s.robotUid)?.model ?? null
    return { model, pose: poseFor(model, readings[s.side], manifests) }
  })
  const feeds = sides
    .map((s) => ({ spec: s, binding: sideCamera(profileOf(s.robotUid), s.cameraKey) }))
    .filter((f) => f.spec.showCamera && f.binding)
  const uncalibrated = rigSides.some((s) => s.follower.motors.some((m) => m.rangeMin === null))

  return (
    <SplitLayout
      id="teleoperate"
      mainClassName={
        inApp
          ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1'
          : 'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1'
      }
      sideClassName="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1"
      main={
        <>
          <Panel title="Setup" className="shrink-0" description="One arm or two, and what drives each.">
            <fieldset disabled={engaged} className="flex min-w-0 flex-col gap-4 disabled:opacity-70">
              <Segmented
                value={opts.setup}
                onChange={(v) => set('setup', v)}
                options={[
                  { value: 'single', label: 'Single arm' },
                  { value: 'dual', label: 'Dual arms' }
                ]}
              />

              <div className={`grid min-w-0 gap-4 ${opts.setup === 'dual' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
                {sides.map((spec) => (
                  <SideCard
                    key={spec.side}
                    spec={spec}
                    dual={opts.setup === 'dual'}
                    envReady={envReady}
                    onChange={(field, value) => set(SIDE_FIELDS[spec.side][field], value as never)}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <Field
                  label="Loop rate (fps)"
                  hint="How often the arms are read and written, and the dataset's frame rate."
                >
                  <NumberInput
                    value={opts.fps}
                    min={1}
                    max={120}
                    className="w-24"
                    onChange={(e) => set('fps', Number(e.currentTarget.value) || 30)}
                  />
                </Field>
                <div className="min-w-60 flex-1">
                  <Toggle
                    label="Run as a LeRobot command"
                    hint={
                      lerobotReason
                        ? `${lerobotReason} The app runs this setup itself.`
                        : 'Hand this setup to lerobot-teleoperate / lerobot-record instead. No live view, camera feeds, ROS 2 or on-demand recording.'
                    }
                    checked={!inApp}
                    disabled={!!lerobotReason}
                    onChange={(next) => set('runner', next ? 'lerobot' : 'app')}
                  />
                </div>
              </div>
            </fieldset>
          </Panel>

          {inApp ? (
            <Panel
              className="min-h-[420px] flex-1"
              bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
              title={opts.setup === 'dual' ? 'Arms' : (profileOf(opts.robotUid)?.id ?? 'Arm')}
              description={engaged ? 'Following what the arms report' : 'Start driving to take control'}
              actions={
                engaged ? (
                  <Badge tone={rigSides.every((s) => s.simulated) ? 'accent' : 'live'}>
                    {rigSides.every((s) => s.simulated) ? 'simulating' : 'live'}
                  </Badge>
                ) : undefined
              }
            >
              {kinematicsError && <Notice tone="error">{kinematicsError}</Notice>}
              {loopError && (
                <Notice tone="error" title="The loop hit an error" onClose={() => setLoopError(null)}>
                  {loopError}
                </Notice>
              )}
              {drives.map(
                (d, i) =>
                  d.error && (
                    <Notice key={i} tone="error" title={`${sideLabel(sides[i]?.side ?? 'single')} stopped following`}>
                      {d.error}
                    </Notice>
                  )
              )}
              {engaged && uncalibrated && (
                <Notice tone="warn" title="An arm has no calibration yet">
                  Without a recorded range there is nothing to convert a solved angle into. Calibrate it
                  in Configure first.
                </Notice>
              )}

              <ArmViewport
                className="min-h-60 flex-1"
                {...(opts.setup === 'dual'
                  ? { arms: viewArms, spacing: opts.armSpacingCm / 100 }
                  : { model: viewArms[0]?.model ?? null, pose: viewArms[0]?.pose ?? {} })}
                placeholder="Select a follower arm to load its model."
              >
                {opts.setup === 'dual' && (
                  <SpacingSlider value={opts.armSpacingCm} onChange={(v) => set('armSpacingCm', v)} />
                )}
              </ArmViewport>

              {feeds.length > 0 && (
                <div className={`grid gap-3 ${feeds.length > 1 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}>
                  {feeds.map(({ spec, binding }) => (
                    <CameraFeed
                      key={spec.side}
                      id={`teleoperate-${spec.side}`}
                      binding={binding!}
                      label={opts.setup === 'dual' ? `${sideLabel(spec.side)} camera` : 'Camera'}
                    />
                  ))}
                </div>
              )}
            </Panel>
          ) : (
            <LerobotOptions opts={opts} set={set} />
          )}
        </>
      }
      side={
        inApp ? (
          <>
            <Panel title="Drive" className="shrink-0">
              <div className="flex flex-col gap-3">
                {!engaged ? (
                  <Button
                    variant="live"
                    disabled={engaging || missing !== null || !kinematicsReady}
                    title={missing ?? undefined}
                    onClick={() => void engage()}
                  >
                    {engaging ? <Spinner /> : 'Start driving'}
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    title="Give up control of the arms. Escape does the same."
                    onClick={() => void disengage()}
                  >
                    Stop driving
                  </Button>
                )}
                {!engaged && missing && <Notice tone="warn">{missing}</Notice>}
                {startError && (
                  <Notice tone="error" onClose={() => setStartError(null)}>
                    {startError}
                  </Notice>
                )}
                <RosPublishToggle ros={ros} />
                {engaged && rigSides.some((s) => !s.simulated) && (
                  <p className="text-xs leading-relaxed text-ink-600">
                    Stopping switches the motors off and releases the arms, so they can be moved by
                    hand. Support a loaded arm before you stop — it will not hold its pose.
                  </p>
                )}
              </div>
            </Panel>

            <Panel
              title="Record"
              className="shrink-0"
              description="Each start and stop is one episode of a LeRobot dataset."
            >
              <div className="flex flex-col gap-3">
                <RecordButton
                  recording={recording}
                  saving={saving}
                  disabled={!engaged || !canRecord || !!recordMissing}
                  title={
                    !engaged
                      ? 'Start driving first — the recording follows the arms.'
                      : !canRecord
                        ? (recordReason ?? undefined)
                        : (recordMissing ?? undefined)
                  }
                  onStart={() => void startRecording()}
                  onStop={() => void stopRecording()}
                />
                <RecordStatus status={rigStatus} fps={opts.fps} />
                {recording && (
                  <button
                    type="button"
                    className="self-start text-xs text-ink-500 underline-offset-2 hover:text-danger-400 hover:underline"
                    onClick={() => void stopRecording(true)}
                  >
                    Discard this episode
                  </button>
                )}
                <Toggle
                  label="Record automatically while driving"
                  hint="Starts an episode when driving starts and saves it when driving stops."
                  checked={opts.autoRecord}
                  onChange={(next) => set('autoRecord', next)}
                />
                {engaged && !canRecord && recordReason && <Notice tone="warn">{recordReason}</Notice>}
                {(recordError || rigStatus.error) && (
                  <Notice tone="error" onClose={() => setRecordError(null)}>
                    {recordError ?? rigStatus.error}
                  </Notice>
                )}

                <Divider label="dataset" />
                <DatasetFields opts={opts} set={set} disabled={recording || saving} />
              </div>
            </Panel>

            {eeSides.map((spec) => {
              const index = sides.indexOf(spec)
              return (
                <Panel
                  key={spec.side}
                  title={`${opts.setup === 'dual' ? `${sideLabel(spec.side)} — ` : ''}${spec.controller === 'keyboard' ? 'Keyboard' : 'Gamepad'}`}
                >
                  <EeControls
                    controller={spec.controller as 'keyboard' | 'gamepad'}
                    state={drives[index]}
                    speed={speed}
                    onSpeed={setSpeed}
                  />
                </Panel>
              )
            })}

            <Panel collapsible title="Joints" description={engaged ? `Read at ${opts.fps} Hz` : 'Not driving'}>
              <div className="flex flex-col gap-3">
                {rigSides.length === 0 && <p className="text-xs text-ink-600">Start driving to read the joints.</p>}
                {rigSides.map((s) => (
                  <div key={s.side} className="flex flex-col gap-1">
                    {opts.setup === 'dual' && (
                      <p className="text-[11px] font-semibold tracking-wide text-ink-600 uppercase">
                        {sideLabel(s.side)}
                      </p>
                    )}
                    <JointTable readings={readings[s.side] ?? {}} motors={s.follower.motors} />
                  </div>
                ))}
              </div>
            </Panel>
          </>
        ) : (
          <>
            <Panel title="Run" className="shrink-0">
              <div className="flex flex-col gap-3">
                <TransportBar
                  run={run?.kind === 'teleoperate' ? run : null}
                  startLabel={opts.record ? 'Start recording' : 'Start teleoperation'}
                  disabled={!envReady || missing !== null}
                  disabledReason={!envReady ? 'Set up the environment in Settings first.' : missing}
                  onStart={startCli}
                />
                <RosPublishToggle
                  ros={ros}
                  unavailable="LeRobot commands hold the serial port themselves, so there are no readings to publish. Turn off 'Run as a LeRobot command' to publish."
                />
                {startError && (
                  <Notice tone="error" onClose={() => setStartError(null)}>
                    {startError}
                  </Notice>
                )}
                <CommandPreview command={preview} error={previewError} />
              </div>
            </Panel>
            <ConsolePane run={run} className="min-h-0 flex-1" heightClass="" />
          </>
        )
      }
    />
  )
}

/* ------------------------------------------------------------------ *
 * One side of the setup                                               *
 * ------------------------------------------------------------------ */

function SideCard({
  spec,
  dual,
  envReady,
  onChange
}: {
  spec: TeleopSideSpec
  dual: boolean
  envReady: boolean
  onChange: (field: Exclude<keyof TeleopSideSpec, 'side'>, value: unknown) => void
}): ReactNode {
  const profiles = useAppStore((s) => s.profiles)
  const robot = profiles.find((p) => p.uid === spec.robotUid) ?? null
  const [editing, setEditing] = useState(false)
  const cameras = robot?.cameras ?? []
  const simulated = isVirtual(spec.robotUid)

  // A camera that is no longer on the profile is no longer chosen.
  useEffect(() => {
    if (spec.cameraKey && robot && !cameras.some((c) => c.key === spec.cameraKey)) onChange('cameraKey', null)
  }, [spec.cameraKey, robot, cameras, onChange])

  return (
    <section
      className={`flex min-w-0 flex-col gap-3 ${dual ? 'rounded-lg border border-shell-700 bg-shell-900 p-3' : ''}`}
    >
      {dual && (
        <h3 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">{sideLabel(spec.side)} arm</h3>
      )}
      <div className={`grid min-w-0 gap-3 ${dual ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3'}`}>
        <Field label="Controller">
          <Select
            value={spec.controller}
            onChange={(v) => onChange('controller', v)}
            options={CONTROLLERS}
          />
        </Field>
        {spec.controller === 'leader' && (
          <Field label="Leader">
            <ProfileSelect role="teleop" value={spec.leaderUid} onChange={(uid) => onChange('leaderUid', uid)} />
          </Field>
        )}
        <Field label="Follower">
          <ProfileSelect role="robot" value={spec.robotUid} onChange={(uid) => onChange('robotUid', uid)} />
        </Field>
      </div>

      <div className={`grid min-w-0 gap-3 ${dual ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3'}`}>
        <Field
          label="Camera"
          hint={
            simulated
              ? 'The virtual arm has no cameras.'
              : !robot
                ? 'Select the follower first.'
                : cameras.length === 0
                  ? 'No cameras on this follower yet.'
                  : 'Recorded with this arm, as observation.images.'
          }
        >
          <Select
            value={spec.cameraKey ?? ''}
            disabled={!robot || simulated || cameras.length === 0}
            onChange={(v) => onChange('cameraKey', v === '' ? null : v)}
            options={[{ value: '', label: 'None' }, ...cameras.map((c) => ({ value: c.key, label: `${c.key} — ${c.type} ${c.identifier}` }))]}
          />
        </Field>
        <div className={`flex flex-col justify-center gap-2 ${dual ? '' : 'sm:col-span-2'}`}>
          <Toggle
            label="Show camera feed"
            hint={!envReady ? 'Needs the Python environment.' : undefined}
            checked={spec.showCamera}
            disabled={!spec.cameraKey || !envReady}
            onChange={(next) => onChange('showCamera', next)}
          />
          {robot && !simulated && (
            <button
              type="button"
              className="self-start text-xs text-accent-400 underline-offset-2 hover:underline"
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? 'Done editing cameras' : cameras.length === 0 ? 'Add a camera…' : 'Edit cameras…'}
            </button>
          )}
        </div>
      </div>

      {editing && robot && (
        <div className="rounded-lg border border-shell-700 p-3">
          <CameraSelect
            cameras={robot.cameras}
            onChange={(next) => void useAppStore.getState().saveProfile({ ...robot, cameras: next })}
          />
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Small pieces                                                        *
 * ------------------------------------------------------------------ */

function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}): ReactNode {
  return (
    <div role="radiogroup" className="inline-flex self-start rounded-lg border border-shell-700 bg-shell-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-sm transition-colors ${
            value === o.value ? 'bg-shell-700 font-semibold text-ink-100' : 'text-ink-500 hover:text-ink-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SpacingSlider({ value, onChange }: { value: number; onChange: (cm: number) => void }): ReactNode {
  return (
    <label className="flex items-center gap-2 rounded-md bg-shell-900/80 px-2.5 py-1.5 text-xs text-ink-300 backdrop-blur">
      <span>Spacing</span>
      <input
        type="range"
        min={ARM_SPACING_CM.min}
        max={ARM_SPACING_CM.max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-36 accent-accent-500"
        aria-label="Distance between the arms, in centimetres"
      />
      <span className="w-12 text-right font-mono tabular-nums text-ink-100">{value} cm</span>
    </label>
  )
}

function RecordButton({
  recording,
  saving,
  disabled,
  title,
  onStart,
  onStop
}: {
  recording: boolean
  saving: boolean
  disabled: boolean
  title?: string
  onStart: () => void
  onStop: () => void
}): ReactNode {
  if (recording) {
    return (
      <Button variant="danger" onClick={onStop} title="Stop and save this episode.">
        <span className="h-2.5 w-2.5 rounded-sm bg-current" aria-hidden />
        Stop recording
      </Button>
    )
  }
  return (
    <Button variant="secondary" disabled={disabled || saving} title={title} onClick={onStart}>
      {saving ? (
        <>
          <Spinner className="h-3 w-3" /> Saving episode…
        </>
      ) : (
        <>
          <span className="h-2.5 w-2.5 rounded-full bg-danger-400" aria-hidden />
          Start recording
        </>
      )}
    </Button>
  )
}

function RecordStatus({ status, fps }: { status: RigStatus; fps: number }): ReactNode {
  if (status.phase === 'recording') {
    const seconds = Math.floor(status.frames / Math.max(1, fps))
    return (
      <p className="flex items-center gap-2 text-xs text-ink-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-danger-400" aria-hidden />
        <span className="font-mono tabular-nums">
          REC {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
        </span>
        · episode {status.episodes + 1} · {status.frames} frames
      </p>
    )
  }
  if (!status.datasetPath) return null
  return (
    <p className="text-xs leading-relaxed text-ink-500">
      {status.episodes} episode{status.episodes === 1 ? '' : 's'} in{' '}
      <span className="font-mono break-all text-ink-300">{status.datasetPath}</span>
    </p>
  )
}

function DatasetFields({
  opts,
  set,
  disabled
}: {
  opts: TeleoperateOptions
  set: <K extends keyof TeleoperateOptions>(key: K, value: TeleoperateOptions[K]) => void
  disabled?: boolean
}): ReactNode {
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3">
      <Field
        label="Dataset name"
        hint="LeRobot's repo_id, e.g. me/pick_place. Recording into an existing one adds episodes to it."
      >
        <TextInput
          value={opts.datasetRepoId}
          placeholder="me/so101_pick_place"
          spellCheck={false}
          onChange={(e) => set('datasetRepoId', e.currentTarget.value)}
        />
      </Field>
      <Field label="Dataset folder" hint="Written to <folder>/<dataset name>. Replay finds it there.">
        <PathPicker
          mode="directory"
          title="Where should the dataset be written?"
          value={opts.datasetRoot}
          onChange={(v) => set('datasetRoot', v)}
          onReveal
        />
      </Field>
      <Field label="Task description" hint="One sentence describing what the operator is doing.">
        <TextInput
          value={opts.singleTask}
          placeholder="Put the red brick in the bowl"
          onChange={(e) => set('singleTask', e.currentTarget.value)}
        />
      </Field>
    </fieldset>
  )
}

/** The options only `lerobot-teleoperate` / `lerobot-record` use. */
function LerobotOptions({
  opts,
  set
}: {
  opts: TeleoperateOptions
  set: <K extends keyof TeleoperateOptions>(key: K, value: TeleoperateOptions[K]) => void
}): ReactNode {
  const caps = useAppStore((s) => s.caps)
  return (
    <>
      {opts.setup === 'dual' && (
        <Panel title="Bimanual names">
          <div className="flex flex-col gap-3">
            <Notice tone="info">
              A bimanual device gets one name; LeRobot derives the two arms from it as
              <code> &lt;name&gt;_left</code> and <code> &lt;name&gt;_right</code>, and looks for those
              calibration files in the left arm's folder.
            </Notice>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Bimanual follower name">
                <TextInput
                  value={opts.bimanualRobotId}
                  spellCheck={false}
                  onChange={(e) => set('bimanualRobotId', e.currentTarget.value)}
                />
              </Field>
              <Field label="Bimanual leader name">
                <TextInput
                  value={opts.bimanualLeaderId}
                  spellCheck={false}
                  onChange={(e) => set('bimanualLeaderId', e.currentTarget.value)}
                />
              </Field>
            </div>
          </div>
        </Panel>
      )}

      <Panel title="Cameras & dashboard">
        <div className="flex flex-col gap-4">
          <Toggle
            label="Use cameras"
            hint="Streams every camera on the followers' profiles into the run. Required for training on images."
            checked={opts.useCameras}
            onChange={(next) => set('useCameras', next)}
          />
          <Toggle
            label="Display dashboard"
            hint={
              caps?.hasRerun
                ? 'Opens a Rerun window with camera feeds and joint plots (--display_data=true).'
                : 'Rerun is not installed in this environment — add the viz extra in Settings.'
            }
            checked={opts.displayData}
            disabled={!caps?.hasRerun}
            onChange={(next) => set('displayData', next)}
          />
        </div>
      </Panel>

      <Panel title="Record" description="lerobot-record: a fixed number of timed episodes.">
        <div className="flex flex-col gap-3">
          <Toggle
            label="Record a dataset while teleoperating"
            hint="Switches the run to lerobot-record."
            checked={opts.record}
            disabled={!caps?.hasRecord}
            onChange={(next) => set('record', next)}
          />
          {opts.record && (
            <>
              <DatasetFields opts={opts} set={set} />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Episodes">
                  <NumberInput
                    value={opts.numEpisodes}
                    min={1}
                    onChange={(e) => set('numEpisodes', Number(e.currentTarget.value) || 1)}
                  />
                </Field>
                <Field label="Episode (s)">
                  <NumberInput
                    value={opts.episodeTimeS}
                    min={1}
                    onChange={(e) => set('episodeTimeS', Number(e.currentTarget.value) || 60)}
                  />
                </Field>
                <Field label="Reset (s)">
                  <NumberInput
                    value={opts.resetTimeS}
                    min={0}
                    onChange={(e) => set('resetTimeS', Number(e.currentTarget.value) || 0)}
                  />
                </Field>
              </div>
              <Toggle
                label="Upload to the Hugging Face Hub when finished"
                hint="Off by default. Requires `hf auth login` in this environment."
                checked={opts.pushToHub}
                onChange={(next) => set('pushToHub', next)}
              />
              <Toggle
                label="Resume an existing dataset"
                hint="Adds episodes to the dataset above. Episode count then means additional episodes."
                checked={opts.resume}
                onChange={(next) => set('resume', next)}
              />
              <Notice tone="info" title="Episode controls">
                While recording, click the output pane and use <kbd>→</kbd> (or <kbd>n</kbd>) to keep an
                episode, <kbd>←</kbd> (or <kbd>r</kbd>) to redo it, and <kbd>Esc</kbd> (or <kbd>q</kbd>) to
                finish and encode.
              </Notice>
            </>
          )}
        </div>
      </Panel>
    </>
  )
}

/** Ticks in, degrees out — the same conversion the model is posed with. */
function JointTable({
  readings,
  motors
}: {
  readings: Record<string, JointReading>
  motors: readonly { name: string; label: string }[]
}): ReactNode {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-ink-600">
          <th className="pb-1 font-normal">Joint</th>
          <th className="pb-1 text-right font-normal">Ticks</th>
          <th className="pb-1 text-right font-normal">Range</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {motors.map((motor) => {
          const reading = readings[motor.name]
          return (
            <tr key={motor.name} className="border-t border-shell-700/60">
              <td className="py-1 font-sans text-ink-300">{motor.label}</td>
              <td className="py-1 text-right text-ink-100">{reading?.position ?? '—'}</td>
              <td className="py-1 text-right text-ink-500">
                {reading?.rangeMin != null && reading?.rangeMax != null
                  ? `${reading.rangeMin}–${reading.rangeMax}`
                  : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** The model's joint angles for a side, once both the readings and the scene are there. */
function poseFor(
  model: ArmModel | null,
  readings: Record<string, JointReading> | undefined,
  manifests: Partial<Record<ArmModel, SimManifest>>
): Record<string, number> {
  const manifest = model ? manifests[model] : undefined
  if (!manifest || !readings) return {}
  return poseFromReadings(manifest, readings)
}

/** What `lerobot-record` additionally needs. */
function cliMissing(opts: TeleoperateOptions): string | null {
  if (opts.record) {
    if (!opts.datasetRepoId.trim()) return 'Give the dataset a name.'
    if (!opts.singleTask.trim()) return 'Describe the task being recorded.'
  }
  return null
}
