import type { DatasetMeta, ReplayOptions, RunInfo } from '@shared/types'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ConsolePane } from '../components/ConsolePane'
import { SplitLayout } from '../components/SplitLayout'
import { PathPicker } from '../components/PathPicker'
import { ProfileSelect } from '../components/ProfileSelect'
import { TransportBar } from '../components/TransportBar'
import {
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
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/**
 * Replay: play a recorded episode back on a follower.
 *
 * `lerobot-replay` addresses a dataset by repo_id, not by file path, so this
 * panel takes a folder and derives the repo_id + `--dataset.root` from it, and
 * reads `meta/info.json` to offer a real episode list instead of a blind number.
 */
export function ReplayPanel(): ReactNode {
  const { caps, runs, activeRunId, setActiveRun } = useAppStore(useShallow((s) => ({
    caps: s.caps,
    runs: s.runs,
    activeRunId: s.activeRunId,
    setActiveRun: s.setActiveRun
  })))

  const [opts, setOpts] = useState<ReplayOptions>({
    robotUid: null,
    datasetRoot: '',
    repoId: '',
    episode: 0,
    fps: null
  })
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [local, setLocal] = useState<DatasetMeta[]>([])
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok
  const set = <K extends keyof ReplayOptions>(key: K, value: ReplayOptions[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }))

  const discover = useCallback(async (): Promise<void> => {
    setScanning(true)
    const res = await api.datasets.discover()
    if (res.ok) setLocal(res.value)
    setScanning(false)
  }, [])

  useEffect(() => {
    if (envReady) void discover()
  }, [envReady, discover])

  /** Load a folder: read its metadata and adopt the derived repo_id. */
  const loadRoot = useCallback(async (root: string): Promise<void> => {
    const res = await api.datasets.read(root)
    if (!res.ok) {
      setMeta(null)
      return
    }
    setMeta(res.value)
    setOpts((o) => ({
      ...o,
      datasetRoot: root,
      repoId: res.value.repoId,
      episode: res.value.episodes[0] ?? 0,
      fps: res.value.fps
    }))
  }, [])

  useEffect(() => {
    if (!envReady) {
      setPreview(null)
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
  }, [opts, envReady])

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
            <Field label="Robot (follower)">
              <ProfileSelect role="robot" value={opts.robotUid} onChange={(uid) => set('robotUid', uid)} />
            </Field>
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
        </>
      }
      side={
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
      }
    />
  )
}
