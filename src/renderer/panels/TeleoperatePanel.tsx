import type { RunInfo, TeleoperateOptions } from '@shared/types'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CameraSelect } from '../components/CameraSelect'
import { ConsolePane } from '../components/ConsolePane'
import { SplitLayout } from '../components/SplitLayout'
import { PathPicker } from '../components/PathPicker'
import { ProfileSelect } from '../components/ProfileSelect'
import { TransportBar } from '../components/TransportBar'
import {
  Button,
  CommandPreview,
  Divider,
  Field,
  Notice,
  NumberInput,
  Panel,
  Select,
  TextInput,
  Toggle
} from '../components/ui'
import { api } from '../lib/api'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

function defaults(datasetRoot: string): TeleoperateOptions {
  return {
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

/**
 * Teleoperate: drive a follower from a leader, optionally recording a dataset.
 *
 * Recording is the same run with a different command (`lerobot-record` instead of
 * `lerobot-teleoperate`), which is why it lives here as an option rather than in
 * its own panel.
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

  const [opts, setOpts] = useState<TeleoperateOptions>(() => defaults(settings?.defaultDatasetRoot ?? ''))
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok
  const set = <K extends keyof TeleoperateOptions>(key: K, value: TeleoperateOptions[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }))

  useEffect(() => {
    if (settings?.defaultDatasetRoot && !opts.datasetRoot) set('datasetRoot', settings.defaultDatasetRoot)
  }, [settings?.defaultDatasetRoot, opts.datasetRoot])

  // Live command preview — the same builder the run uses, so what you see is
  // literally what gets executed.
  useEffect(() => {
    if (!envReady) {
      setPreview(null)
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
  }, [opts, envReady])

  const robotProfile = profiles.find((p) => p.uid === opts.robotUid) ?? null

  const start = async (): Promise<void> => {
    setStartError(null)
    const res = await api.runs.start('teleoperate', opts)
    if (res.ok) setActiveRun(res.value.runId)
    else setStartError(res.error)
  }

  const missing = validate(opts)

  return (
    <SplitLayout
      id="teleoperate"
      mainClassName="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
      sideClassName="flex min-h-0 flex-col gap-4 overflow-hidden"
      main={
        <>
          <Panel title="Setup" description="Which arms are involved.">
            <div className="flex flex-col gap-3">
              <Field label="Configuration">
                <Select
                  value={opts.setup}
                  onChange={(v) => set('setup', v as TeleoperateOptions['setup'])}
                  options={[
                    { value: 'single', label: 'Single — one leader drives one follower' },
                    { value: 'dual', label: 'Dual — two leaders drive two followers (bimanual)' }
                  ]}
                />
              </Field>

              {opts.setup === 'single' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Leader (teleop)">
                    <ProfileSelect
                      role="teleop"
                      value={opts.leaderUid}
                      onChange={(uid) => set('leaderUid', uid)}
                    />
                  </Field>
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

              <Field label="Loop rate (fps)" hint="60 is LeRobot's teleoperate default; recording usually uses 30.">
                <NumberInput
                  value={opts.fps}
                  min={1}
                  max={200}
                  className="w-24"
                  onChange={(e) => set('fps', Number(e.currentTarget.value) || 30)}
                />
              </Field>
            </div>
          </Panel>

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
      }
      side={
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
      }
    />
  )
}

function validate(opts: TeleoperateOptions): string | null {
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
