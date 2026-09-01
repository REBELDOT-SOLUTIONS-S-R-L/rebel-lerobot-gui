import type { InferOptions, RunInfo } from '@shared/types'
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
  TextInput,
  Toggle
} from '../components/ui'
import { api } from '../lib/api'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/**
 * Infer: run a trained policy on the arm.
 *
 * The command shape depends on the installed LeRobot: newer builds ship
 * `lerobot-rollout`, older ones drive a policy through `lerobot-record` and
 * require the dataset name to begin with `eval_`. The capability probe decides,
 * and the panel says which path it is taking so the difference is not a mystery.
 */
export function InferPanel(): ReactNode {
  const { settings, caps, profiles, runs, activeRunId, setActiveRun } = useAppStore(useShallow((s) => ({
    settings: s.settings,
    caps: s.caps,
    profiles: s.profiles,
    runs: s.runs,
    activeRunId: s.activeRunId,
    setActiveRun: s.setActiveRun
  })))

  const [opts, setOpts] = useState<InferOptions>({
    robotUid: null,
    policyPath: '',
    task: '',
    duration: 60,
    useCameras: true,
    displayData: false,
    evalRepoId: 'eval_policy_run',
    evalDatasetRoot: settings?.defaultDatasetRoot ?? ''
  })
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok
  const usesRollout = !!caps?.hasRollout
  const set = <K extends keyof InferOptions>(key: K, value: InferOptions[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }))

  useEffect(() => {
    if (settings?.defaultDatasetRoot && !opts.evalDatasetRoot) {
      set('evalDatasetRoot', settings.defaultDatasetRoot)
    }
  }, [settings?.defaultDatasetRoot, opts.evalDatasetRoot])

  useEffect(() => {
    if (!envReady) {
      setPreview(null)
      return
    }
    let cancelled = false
    void api.commands.preview('infer', opts).then((res) => {
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
    const res = await api.runs.start('infer', opts)
    if (res.ok) setActiveRun(res.value.runId)
    else setStartError(res.error)
  }

  const missing = !opts.robotUid
    ? 'Select the arm to run the policy on.'
    : !opts.policyPath.trim()
      ? 'Provide a policy path or Hugging Face model id.'
      : !opts.task.trim()
        ? 'Describe the task for the policy.'
        : opts.useCameras && robotProfile && robotProfile.cameras.length === 0
          ? 'The policy expects camera input but this arm has no cameras configured.'
          : null

  return (
    <SplitLayout
      id="infer"
      mainClassName="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
      sideClassName="flex min-h-0 flex-col gap-4 overflow-hidden"
      main={
        <>
          <Panel title="Device">
            <Field label="Robot (follower)">
              <ProfileSelect role="robot" value={opts.robotUid} onChange={(uid) => set('robotUid', uid)} />
            </Field>
          </Panel>

          <Panel
            title="Policy"
            description="A local checkpoint folder, or a Hugging Face model id such as lerobot/folding_latest."
          >
            <div className="flex flex-col gap-3">
              <Field label="Policy path or model id">
                <TextInput
                  value={opts.policyPath}
                  placeholder="outputs/train/act_so101/checkpoints/last/pretrained_model"
                  spellCheck={false}
                  onChange={(e) => set('policyPath', e.currentTarget.value)}
                  className="font-mono text-xs"
                />
              </Field>

              <Field label="…or browse to a checkpoint folder">
                <PathPicker
                  mode="directory"
                  title="Select the pretrained_model folder"
                  value={opts.policyPath}
                  onChange={(v) => set('policyPath', v)}
                />
              </Field>

              <Field label="Task" hint="The instruction the policy was trained against.">
                <TextInput
                  value={opts.task}
                  placeholder="Put the lego brick into the transparent box"
                  onChange={(e) => set('task', e.currentTarget.value)}
                />
              </Field>

              <Field label="Duration (seconds)" hint="0 runs until you stop it.">
                <NumberInput
                  value={opts.duration}
                  min={0}
                  className="w-28"
                  onChange={(e) => set('duration', Number(e.currentTarget.value) || 0)}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Cameras">
            <div className="flex flex-col gap-4">
              <Toggle
                label="Use cameras"
                hint="The camera names and resolutions must match what the policy was trained on."
                checked={opts.useCameras}
                onChange={(next) => set('useCameras', next)}
              />
              <Toggle
                label="Display dashboard"
                hint={
                  caps?.hasRerun
                    ? 'Opens a Rerun window with the observations the policy is seeing.'
                    : 'Rerun is not installed — add the viz extra in Settings.'
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
            </div>
          </Panel>

          {!usesRollout && envReady && (
            <Panel
              title="Evaluation dataset"
              description="This LeRobot version runs policies through lerobot-record, which always writes a dataset."
            >
              <div className="flex flex-col gap-3">
                <Field
                  label="Dataset name"
                  hint="LeRobot requires an eval_ prefix for policy runs; it is added automatically if missing."
                >
                  <TextInput
                    value={opts.evalRepoId}
                    spellCheck={false}
                    onChange={(e) => set('evalRepoId', e.currentTarget.value)}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Dataset folder">
                  <PathPicker
                    mode="directory"
                    title="Where should the evaluation run be written?"
                    value={opts.evalDatasetRoot}
                    onChange={(v) => set('evalDatasetRoot', v)}
                    onReveal
                  />
                </Field>
              </div>
            </Panel>
          )}
        </>
      }
      side={
        <>
          <Panel title="Run" className="shrink-0">
            <div className="flex flex-col gap-3">
              {envReady && (
                <Notice tone="info" title={usesRollout ? 'Using lerobot-rollout' : 'Using lerobot-record'}>
                  {usesRollout
                    ? 'Autonomous rollout with no recording (--strategy.type=base).'
                    : `LeRobot ${caps?.lerobotVersion ?? ''} has no lerobot-rollout, so the policy is driven through lerobot-record instead.`}
                </Notice>
              )}

              <TransportBar
                run={run?.kind === 'infer' ? run : null}
                startLabel="Start policy"
                disabled={!envReady || missing !== null}
                disabledReason={!envReady ? 'Set up the environment in Settings first.' : missing}
                onStart={start}
              >
                <Button size="sm" variant="ghost" onClick={() => useAppStore.getState().setPanel('replay')}>
                  Open Replay
                </Button>
              </TransportBar>

              <Notice tone="warn" title="Keep the workspace clear">
                The arm moves on its own once the policy starts. Stay clear of its reach and keep Stop within
                easy reach.
              </Notice>

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
