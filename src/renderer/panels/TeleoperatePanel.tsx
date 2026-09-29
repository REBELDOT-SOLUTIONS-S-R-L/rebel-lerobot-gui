import { applyPositions, poseFromReadings, readingsFromMotors, type JointReading } from '@shared/sim'
import { drivenInApp } from '@shared/teleop-input'
import type { BusSnapshot, RunInfo, TeleoperateOptions, TeleopController } from '@shared/types'
import { isVirtual } from '@shared/virtual'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArmViewport } from '../components/ArmViewport'
import { CameraSelect } from '../components/CameraSelect'
import { ConsolePane } from '../components/ConsolePane'
import { EeControls } from '../components/EeControls'
import { SplitLayout } from '../components/SplitLayout'
import { PathPicker } from '../components/PathPicker'
import { ProfileSelect } from '../components/ProfileSelect'
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
import { useEscapeToStop } from '../lib/use-arm-control'
import { useSticky } from '../lib/use-sticky'
import { useControlClaim } from '../lib/use-control-claim'
import { useRosPublish } from '../lib/use-ros-publish'
import { RosPublishToggle } from '../components/RosPublishToggle'
import { rangesOf, useLeaderMirror } from '../lib/use-leader-mirror'
import { useEeDrive } from '../lib/use-ee-drive'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** Position stream rate while the app is driving. Fast enough to animate. */
const STREAM_HZ = 30

function defaults(datasetRoot: string): TeleoperateOptions {
  return {
    controller: 'leader',
    setup: 'single',
    robotUid: null,
    leaderUid: null,
    leftRobotUid: null,
    rightRobotUid: null,
    leftLeaderUid: null,
    rightLeaderUid: null,
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
  { value: 'leader', label: 'Leader arm — copy a second arm, joint for joint' },
  { value: 'keyboard', label: 'Keyboard — fly the tool with the keys' },
  { value: 'gamepad', label: 'Gamepad — fly the tool with the sticks' }
]

/**
 * Teleoperate: drive a follower, optionally recording a dataset.
 *
 * A leader arm driving a real follower is `lerobot-teleoperate`'s job and this
 * panel starts it, with recording as the same run under a different command
 * (`lerobot-record`) — which is why recording lives here as an option rather
 * than in its own panel.
 *
 * The other two controllers have no pose to copy, so the app drives the arm
 * itself: it reads the keys or the sticks, moves a target tool pose, solves the
 * joint angles that reach it and writes those as goal positions, fifty times a
 * second (`useEeDrive`). The virtual follower is driven the same way, and can
 * additionally be mirrored from a real leader, since there is no LeRobot device
 * for `lerobot-teleoperate` to talk to at that end.
 */
export function TeleoperatePanel(): ReactNode {
  const { settings, caps, profiles, runs, activeRunId, setActiveRun } = useAppStore(useShallow((s) => ({
    settings: s.settings,
    caps: s.caps,
    profiles: s.profiles,
    runs: s.runs,
    activeRunId: s.activeRunId,
    setActiveRun: s.setActiveRun
  })))

  // Everything chosen here survives a tab switch; what was read from the arms
  // does not, and is re-read when control is next taken.
  const [opts, setOpts] = useSticky('teleoperate.options', () =>
    defaults(settings?.defaultDatasetRoot ?? '')
  )
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  /* -- in-app driving ----------------------------------------------- */
  const [engaged, setEngaged] = useState(false)
  const [engaging, setEngaging] = useState(false)
  const [snapshot, setSnapshot] = useState<BusSnapshot | null>(null)
  const [leaderSnapshot, setLeaderSnapshot] = useState<BusSnapshot | null>(null)
  const [readings, setReadings] = useState<Record<string, JointReading>>({})
  const [kinematics, setKinematics] = useState<ArmKinematics | null>(null)
  const [kinematicsError, setKinematicsError] = useState<string | null>(null)
  const [speed, setSpeed] = useSticky('teleoperate.speed', () => 1)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok
  const set = <K extends keyof TeleoperateOptions>(key: K, value: TeleoperateOptions[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }))

  const robotProfile = profiles.find((p) => p.uid === opts.robotUid) ?? null
  const leaderProfile = profiles.find((p) => p.uid === opts.leaderUid) ?? null
  const simulated = isVirtual(opts.robotUid)
  /** The app drives this itself; there is no lerobot process to start. */
  const inApp = drivenInApp(opts)
  const eeMode = opts.controller !== 'leader'
  /** A real leader mirrored onto the virtual arm. */
  const mirrorMode = inApp && !eeMode

  useEffect(() => {
    if (settings?.defaultDatasetRoot && !opts.datasetRoot) set('datasetRoot', settings.defaultDatasetRoot)
  }, [settings?.defaultDatasetRoot, opts.datasetRoot])

  // A bimanual pair is only ever driven by `lerobot-teleoperate`, and recording
  // is that command's other half; neither survives the app driving the arm.
  useEffect(() => {
    if (!inApp) return
    if (opts.setup !== 'single') set('setup', 'single')
    if (opts.record) set('record', false)
    if (opts.useCameras) set('useCameras', false)
  }, [inApp, opts.setup, opts.record, opts.useCameras])

  // Live command preview — the same builder the run uses, so what you see is
  // literally what gets executed. Nothing to preview when the app is driving.
  useEffect(() => {
    if (!envReady || inApp) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    void api.commands.preview('teleoperate', opts).then((res) => {
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
  }, [opts, envReady, inApp])

  /* -- kinematics --------------------------------------------------- */

  const model = eeMode ? (robotProfile?.model ?? null) : null
  useEffect(() => {
    if (!model) {
      setKinematics(null)
      return
    }
    let cancelled = false
    setKinematicsError(null)
    void loadArmKinematics(model)
      .then((loaded) => !cancelled && setKinematics(loaded))
      .catch((err: unknown) => {
        if (cancelled) return
        setKinematics(null)
        setKinematicsError(
          `Could not read the ${model} kinematics out of the assets folder, so the tool cannot be ` +
            `solved for. ${errorMessage(err)}`
        )
      })
    return () => {
      cancelled = true
    }
  }, [model])

  /* -- engaging ----------------------------------------------------- */

  /** Frames from the follower; the simulation tags its own so they can be told apart. */
  const followerFrames = simulated ? 'virtual' : 'bus'

  useEffect(() => {
    if (!engaged) return
    return api.bridge.onNotification((frame) => {
      if (frame.type === 'streamError') {
        setStartError(String(frame.message ?? 'The position stream failed.'))
        return
      }
      if (frame.type !== 'positions') return
      const source = frame.source === 'virtual' ? 'virtual' : 'bus'
      if (source !== followerFrames) return
      setReadings((prev) => applyPositions(prev, frame.positions as Record<string, number>))
    })
  }, [engaged, followerFrames])

  const engage = useCallback(async (): Promise<void> => {
    if (!opts.robotUid) return
    setEngaging(true)
    setStartError(null)
    try {
      const follower = await api.bus.connect(opts.robotUid)
      if (!follower.ok) {
        setStartError(follower.error)
        return
      }
      setSnapshot(follower.value)
      setReadings(readingsFromMotors(follower.value.motors))

      if (mirrorMode) {
        if (!opts.leaderUid) return
        const leader = await api.bus.connect(opts.leaderUid)
        if (!leader.ok) {
          setStartError(leader.error)
          return
        }
        setLeaderSnapshot(leader.value)
        if (leader.value.source !== 'live') {
          setStartError(
            `Could not read the leader arm. ${leader.value.warning ?? 'Check its port and power.'}`
          )
          return
        }
        // The leader is read, never driven, so its torque stays off — that is
        // what lets it be moved by hand.
        await api.bus.streamStart(opts.leaderUid, opts.fps)
      } else if (!simulated) {
        // Hold the pose the solver commands. Left on when the loop stops, so a
        // loaded arm does not drop the moment control is released.
        const torque = await api.motor.torque(opts.robotUid, true)
        if (!torque.ok) {
          setStartError(torque.error)
          return
        }
      }

      await api.bus.streamStart(opts.robotUid, STREAM_HZ)
      setEngaged(true)
    } finally {
      setEngaging(false)
    }
  }, [opts.robotUid, opts.leaderUid, opts.fps, mirrorMode, simulated])

  const disengage = useCallback(async (): Promise<void> => {
    setEngaged(false)
    if (opts.robotUid) await api.bus.streamStop(opts.robotUid)
    if (opts.leaderUid) {
      await api.bus.streamStop(opts.leaderUid)
      await api.bus.disconnect(opts.leaderUid)
    }
    if (opts.robotUid && !simulated) await api.bus.disconnect(opts.robotUid)
    setLeaderSnapshot(null)
  }, [opts.robotUid, opts.leaderUid, simulated])

  // Selecting a different arm, or a different way of driving it, has to release
  // whatever the last one was holding.
  useEffect(() => {
    setEngaged(false)
    setSnapshot(null)
    setLeaderSnapshot(null)
    setReadings({})
  }, [opts.robotUid, opts.leaderUid, opts.controller])

  // Nothing should be driving an arm once this panel is gone.
  useEffect(() => {
    const { robotUid, leaderUid } = opts
    return () => {
      void api.bus.streamStop(robotUid ?? undefined)
      void api.bus.streamStop(leaderUid ?? undefined)
      if (leaderUid) void api.bus.disconnect(leaderUid)
      if (robotUid && !isVirtual(robotUid)) void api.bus.disconnect(robotUid)
    }
  }, [opts.robotUid, opts.leaderUid])

  useEscapeToStop(engaged, () => void disengage())
  useControlClaim('teleoperate.engaged', engaged)

  const drive = useEeDrive({
    uid: opts.robotUid,
    controller: eeMode ? (opts.controller as 'keyboard' | 'gamepad') : 'keyboard',
    engaged: engaged && eeMode,
    kinematics,
    readings,
    speed
  })

  const mirror = useLeaderMirror({
    leaderUid: opts.leaderUid,
    followerUid: opts.robotUid,
    engaged: engaged && mirrorMode,
    leaderRanges: useMemo(() => rangesOf(leaderSnapshot?.motors ?? []), [leaderSnapshot]),
    followerRanges: useMemo(() => rangesOf(snapshot?.motors ?? []), [snapshot])
  })

  const followerRanges = useMemo(() => rangesOf(snapshot?.motors ?? []), [snapshot])
  const leaderRanges = useMemo(() => rangesOf(leaderSnapshot?.motors ?? []), [leaderSnapshot])
  const ros = useRosPublish({
    panel: 'teleoperate',
    active: engaged,
    mode: 'teleoperate',
    devices: [
      { uid: opts.robotUid, ranges: followerRanges },
      // Mirrored, the leader is read by the app too, so it has its own namespace.
      { uid: mirrorMode ? opts.leaderUid : null, ranges: leaderRanges }
    ]
  })

  /* -- starting a lerobot run --------------------------------------- */

  const start = async (): Promise<void> => {
    setStartError(null)
    const res = await api.runs.start('teleoperate', opts)
    if (res.ok) setActiveRun(res.value.runId)
    else setStartError(res.error)
  }

  const missing = validate(opts)
  const uncalibrated = snapshot?.motors.some((m) => m.rangeMin === null) ?? false
  const pose = kinematics ? poseFromReadings(kinematics.manifest, readings) : {}

  return (
    <SplitLayout
      id="teleoperate"
      mainClassName={
        inApp
          ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden'
          : 'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1'
      }
      sideClassName="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1"
      main={
        <>
          <Panel title="Setup" className={inApp ? 'shrink-0' : ''} description="What is driving what.">
            <div className="flex flex-col gap-3">
              <Field
                label="Control"
                hint={
                  eeMode
                    ? 'The keys or sticks command where the tool goes; the app solves the joint angles for it.'
                    : 'A leader arm hands over its whole pose, joint for joint.'
                }
              >
                <Select
                  value={opts.controller}
                  onChange={(v) => set('controller', v as TeleopController)}
                  options={CONTROLLERS}
                />
              </Field>

              {!eeMode && (
                <Field label="Configuration">
                  <Select
                    value={opts.setup}
                    onChange={(v) => set('setup', v as TeleoperateOptions['setup'])}
                    options={[
                      { value: 'single', label: 'Single — one leader drives one follower' },
                      {
                        value: 'dual',
                        label: 'Dual — two leaders drive two followers (bimanual)',
                        disabled: simulated
                      }
                    ]}
                  />
                </Field>
              )}

              {opts.setup === 'single' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {!eeMode && (
                    <Field label="Leader (teleop)">
                      <ProfileSelect
                        role="teleop"
                        value={opts.leaderUid}
                        onChange={(uid) => set('leaderUid', uid)}
                      />
                    </Field>
                  )}
                  <Field label="Robot (follower)">
                    <ProfileSelect role="robot" value={opts.robotUid} onChange={(uid) => set('robotUid', uid)} />
                  </Field>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Left leader">
                      <ProfileSelect
                        role="teleop"
                        value={opts.leftLeaderUid}
                        onChange={(uid) => set('leftLeaderUid', uid)}
                      />
                    </Field>
                    <Field label="Left follower">
                      <ProfileSelect
                        role="robot"
                        value={opts.leftRobotUid}
                        onChange={(uid) => set('leftRobotUid', uid)}
                      />
                    </Field>
                    <Field label="Right leader">
                      <ProfileSelect
                        role="teleop"
                        value={opts.rightLeaderUid}
                        onChange={(uid) => set('rightLeaderUid', uid)}
                      />
                    </Field>
                    <Field label="Right follower">
                      <ProfileSelect
                        role="robot"
                        value={opts.rightRobotUid}
                        onChange={(uid) => set('rightRobotUid', uid)}
                      />
                    </Field>
                  </div>

                  <Notice tone="info" title="Bimanual calibration names">
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
                </>
              )}

              <Field
                label="Loop rate (fps)"
                hint={
                  mirrorMode
                    ? 'How often the leader is read and forwarded to the simulation.'
                    : '60 is LeRobot’s teleoperate default; recording usually uses 30.'
                }
              >
                <NumberInput
                  value={opts.fps}
                  min={1}
                  max={200}
                  className="w-24"
                  disabled={eeMode}
                  onChange={(e) => set('fps', Number(e.currentTarget.value) || 30)}
                />
              </Field>

              {simulated && (
                <Notice tone="info" title="Driving the virtual arm">
                  {eeMode
                    ? 'Nothing is plugged in — the keys or sticks move a simulated arm, so this is a safe place to learn the controls.'
                    : 'The leader arm is read over its serial port and its pose is forwarded to the simulation. No follower hardware is involved.'}
                </Notice>
              )}
            </div>
          </Panel>

          {inApp ? (
            <Panel
              className="min-h-0 flex-1"
              bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
              title={robotProfile ? `${robotProfile.id} — ${robotProfile.model}` : 'Arm'}
              description={
                engaged
                  ? 'Following what the app is commanding'
                  : 'Start driving to take control of this arm'
              }
              actions={
                engaged ? (
                  <Badge tone={simulated ? 'accent' : 'live'}>
                    {simulated ? 'simulating' : 'live'}
                  </Badge>
                ) : undefined
              }
            >
              {kinematicsError && <Notice tone="error">{kinematicsError}</Notice>}
              {drive.error && (
                <Notice tone="error" title="The arm stopped following">
                  {drive.error}
                </Notice>
              )}
              {mirror.error && (
                <Notice tone="error" title="Could not forward the leader’s pose">
                  {mirror.error}
                </Notice>
              )}
              {engaged && uncalibrated && (
                <Notice tone="warn" title="This arm has no calibration yet">
                  Without a recorded range there is nothing to convert a solved angle into, so the
                  joints below will not move. Calibrate it in Configure first.
                </Notice>
              )}
              {drive.homing && <Notice tone="info">Returning to the middle of every range.</Notice>}

              <ArmViewport
                model={robotProfile?.model ?? null}
                pose={pose}
                className="min-h-60 flex-1"
                placeholder={
                  robotProfile
                    ? 'Loading the model…'
                    : 'Select a follower arm to load its model.'
                }
              />
            </Panel>
          ) : (
            <>
              <Panel title="Cameras & dashboard">
                <div className="flex flex-col gap-4">
                  <Toggle
                    label="Use cameras"
                    hint={
                      robotProfile && robotProfile.cameras.length === 0
                        ? 'This follower has no cameras configured yet — add them below.'
                        : "Streams the follower's cameras into the run. Required if you are recording for training."
                    }
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

                  {opts.useCameras && robotProfile && (
                    <>
                      <Divider label={`cameras on ${robotProfile.id}`} />
                      <CameraSelect
                        cameras={robotProfile.cameras}
                        onChange={(cameras) => {
                          void useAppStore.getState().saveProfile({ ...robotProfile, cameras })
                        }}
                      />
                    </>
                  )}
                  {opts.useCameras && !robotProfile && (
                    <Notice tone="warn">Select a follower to configure its cameras.</Notice>
                  )}
                </div>
              </Panel>

              <Panel title="Record" description="Capture this session as a LeRobot dataset.">
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
                      <Field
                        label="Dataset name"
                        hint="LeRobot's repo_id. Use owner/name if you plan to push it to the Hub."
                      >
                        <TextInput
                          value={opts.datasetRepoId}
                          placeholder="my_so101_pick_place"
                          spellCheck={false}
                          onChange={(e) => set('datasetRepoId', e.currentTarget.value)}
                        />
                      </Field>

                      <Field label="Dataset folder" hint="Passed as --dataset.root.">
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
                    disabled={engaging || missing !== null || (eeMode && !kinematics)}
                    onClick={() => void engage()}
                  >
                    {engaging ? <Spinner /> : 'Start driving'}
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    title="Give up control of the arm. Escape does the same."
                    onClick={() => void disengage()}
                  >
                    Stop driving
                  </Button>
                )}

                <RosPublishToggle ros={ros} />

                {!engaged && missing && <Notice tone="warn">{missing}</Notice>}
                {startError && (
                  <Notice tone="error" onClose={() => setStartError(null)}>
                    {startError}
                  </Notice>
                )}

                {engaged && !simulated && (
                  <Notice tone="info">
                    Torque stays on when you stop, so the arm holds where you left it rather than
                    dropping. Switch it off in Configure to move the arm by hand.
                  </Notice>
                )}

                {mirrorMode && engaged && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-ink-600">Leader</dt>
                    <dd className="font-mono text-ink-300">
                      {leaderProfile?.id ?? '—'} on {leaderSnapshot?.port ?? '—'}
                    </dd>
                    <dt className="text-ink-600">Poses forwarded</dt>
                    <dd className="font-mono tabular-nums text-ink-100">{mirror.frames}</dd>
                  </dl>
                )}
              </div>
            </Panel>

            {eeMode && (
              <Panel title={opts.controller === 'keyboard' ? 'Keyboard' : 'Gamepad'}>
                <EeControls
                  controller={opts.controller as 'keyboard' | 'gamepad'}
                  state={drive}
                  speed={speed}
                  onSpeed={setSpeed}
                />
              </Panel>
            )}

            <Panel collapsible title="Joints" description={engaged ? `Read at ${STREAM_HZ} Hz` : 'Not driving'}>
              <JointTable readings={readings} motors={snapshot?.motors ?? []} />
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
                  onStart={start}
                >
                  {robotProfile && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => useAppStore.getState().setPanel('configure')}
                    >
                      Edit {robotProfile.id}
                    </Button>
                  )}
                </TransportBar>

                <RosPublishToggle ros={ros} unavailable="LeRobot commands hold the serial port themselves, so the app has no readings to publish from them yet. Publishing works for driving from the app: the virtual arm, keyboard and gamepad." />

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

/** Ticks in, degrees out — the same conversion the model is posed with. */
function JointTable({
  readings,
  motors
}: {
  readings: Record<string, JointReading>
  motors: readonly { name: string; label: string }[]
}): ReactNode {
  if (motors.length === 0) {
    return <p className="text-xs text-ink-600">Start driving to read the joints.</p>
  }
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

function validate(opts: TeleoperateOptions): string | null {
  if (opts.controller !== 'leader') {
    return opts.robotUid ? null : 'Select the follower arm to drive.'
  }
  if (opts.setup === 'single') {
    if (!opts.leaderUid) return 'Select a leader arm.'
    if (!opts.robotUid) return 'Select a follower arm.'
  } else {
    if (!opts.leftLeaderUid || !opts.rightLeaderUid) return 'Select both leader arms.'
    if (!opts.leftRobotUid || !opts.rightRobotUid) return 'Select both follower arms.'
  }
  if (opts.record) {
    if (!opts.datasetRepoId.trim()) return 'Give the dataset a name.'
    if (!opts.singleTask.trim()) return 'Describe the task being recorded.'
  }
  return null
}
