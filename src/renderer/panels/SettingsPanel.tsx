import { PYTHON_RANGE } from '@shared/devices'
import type { InstalledPackage, PythonCandidate, RunInfo, ThemeChoice } from '@shared/types'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ConsolePane } from '../components/ConsolePane'
import { PathPicker } from '../components/PathPicker'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Notice,
  Panel,
  Select,
  Spinner,
  TextInput,
  Toggle
} from '../components/ui'
import { api } from '../lib/api'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/**
 * Environment setup: pick a Python, create or adopt a virtualenv, install
 * LeRobot, and see what the resulting environment can actually do.
 *
 * Everything here runs as a visible subprocess, because pip output is exactly
 * what you need when an install goes wrong.
 */
const THEMES: { id: ThemeChoice; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow the operating system, and keep following it' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' }
]

export function SettingsPanel(): ReactNode {
  const { settings, caps, capsLoading, capsError, saveSettings, refreshCaps, runs, activeRunId, setActiveRun } =
    useAppStore(useShallow((s) => ({
      settings: s.settings,
      caps: s.caps,
      capsLoading: s.capsLoading,
      capsError: s.capsError,
      saveSettings: s.saveSettings,
      refreshCaps: s.refreshCaps,
      runs: s.runs,
      activeRunId: s.activeRunId,
      setActiveRun: s.setActiveRun
    })))

  const [pythons, setPythons] = useState<PythonCandidate[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [uvAvailable, setUvAvailable] = useState(false)
  const [venvDraft, setVenvDraft] = useState('')
  const [packages, setPackages] = useState<InstalledPackage[] | null>(null)
  const [packageFilter, setPackageFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [extras, setExtras] = useState('core_scripts,feetech')
  const [installFromSource, setInstallFromSource] = useState(false)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const busy = run?.status === 'running' || run?.status === 'starting'

  const discover = useCallback(async (): Promise<void> => {
    setDiscovering(true)
    const [found, uv] = await Promise.all([api.python.discover(), api.python.uvPath()])
    if (found.ok) setPythons(found.value)
    else setError(found.error)
    setUvAvailable(uv.ok && !!uv.value)
    setDiscovering(false)
  }, [])

  useEffect(() => {
    void discover()
  }, [discover])

  useEffect(() => {
    if (settings?.venvPath) setVenvDraft(settings.venvPath)
  }, [settings?.venvPath])

  const startRun = async (kind: 'venv' | 'install', payload: unknown): Promise<void> => {
    setError(null)
    const res = await api.runs.start(kind, payload)
    if (res.ok) setActiveRun(res.value.runId)
    else setError(res.error)
  }

  const supported = pythons.filter((p) => p.supported)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <Panel title="Appearance" description="Applies immediately, and is remembered.">
          <Field label="Theme">
            <div className="flex w-fit gap-1 rounded-lg border border-shell-700 bg-shell-900 p-1">
              {THEMES.map((t) => {
                const active = (settings?.theme ?? 'dark') === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={t.hint}
                    onClick={() => void saveSettings({ theme: t.id })}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? 'bg-accent-600 font-semibold text-white'
                        : 'text-ink-500 hover:bg-shell-800 hover:text-ink-100'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </Field>
        </Panel>

        <Panel
          title="Python interpreter"
          description={`LeRobot needs Python ${PYTHON_RANGE}. Newer releases cannot start its CLI.`}
          actions={
            <Button size="sm" variant="secondary" disabled={discovering} onClick={() => void discover()}>
              {discovering ? <Spinner /> : 'Rescan'}
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            {pythons.length === 0 && !discovering && (
              <Notice tone="warn" title="No Python interpreters found">
                Install Python {PYTHON_RANGE} (miniforge, python.org or your package manager), then
                rescan. You can also type a path directly below.
              </Notice>
            )}
            {pythons.length > 0 && supported.length === 0 && (
              <Notice tone="error" title="No supported interpreter">
                None of the interpreters found are in the {PYTHON_RANGE} window LeRobot runs in. Install one
                — <code>uv python install 3.12</code> is the quickest — then rescan.
              </Notice>
            )}

            <Field label="Interpreter">
              <Select
                value={settings?.pythonPath ?? null}
                onChange={(v) => void saveSettings({ pythonPath: v })}
                placeholder="Select an interpreter…"
                options={pythons.map((p) => ({
                  value: p.path,
                  label: p.supported
                    ? `Python ${p.version} — ${p.source}`
                    : `Python ${p.version} — ${p.source} (${p.unsupportedReason ?? 'unsupported'})`,
                  disabled: !p.supported
                }))}
              />
            </Field>

            <Field label="…or point at one directly" hint="Useful for a conda env or a custom build.">
              <PathPicker
                mode="openFile"
                title="Select a Python interpreter"
                value={settings?.pythonPath ?? ''}
                onChange={(path) => void saveSettings({ pythonPath: path })}
              />
            </Field>

            {uvAvailable && (
              <Toggle
                label="Use uv to create environments"
                hint="uv is installed and is what LeRobot itself locks with. Faster than python -m venv."
                checked={settings?.preferUv ?? false}
                onChange={(next) => void saveSettings({ preferUv: next })}
              />
            )}
          </div>
        </Panel>

        <Panel
          title="Environment"
          description="The virtualenv or conda env that holds LeRobot. All LeRobot commands run from here."
        >
          <div className="flex flex-col gap-3">
            <Field
              label="Environment folder"
              hint="Pick an existing env to adopt it, or a new empty folder to create one."
            >
              <PathPicker
                mode="directory"
                title="Select or create the environment folder"
                value={venvDraft}
                onChange={setVenvDraft}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={busy || !venvDraft || venvDraft === settings?.venvPath}
                onClick={() => void saveSettings({ venvPath: venvDraft })}
              >
                Use this environment
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !settings?.pythonPath || !venvDraft}
                title="Runs python -m venv (or uv venv) in the folder above."
                onClick={() =>
                  void startRun('venv', {
                    pythonPath: settings?.pythonPath,
                    venvPath: venvDraft,
                    preferUv: settings?.preferUv
                  })
                }
              >
                Create environment here
              </Button>
              {settings?.venvPath && (
                <Badge tone={caps?.ok ? 'live' : 'warn'}>
                  active: {shortPath(settings.venvPath)}
                </Badge>
              )}
            </div>

            {error && (
              <Notice tone="error" onClose={() => setError(null)}>
                {error}
              </Notice>
            )}
          </div>
        </Panel>

        <Panel
          title="Install LeRobot"
          description="Installs the extras this app needs: core_scripts for record/replay/teleoperate, feetech for the SO-arm motors."
        >
          <div className="flex flex-col gap-3">
            <Toggle
              label="Install from a local source checkout"
              hint="Editable install (pip install -e). Use this if you are modifying LeRobot itself."
              checked={installFromSource}
              onChange={setInstallFromSource}
            />

            {installFromSource && (
              <Field label="LeRobot source folder" hint="The clone's root — the folder with pyproject.toml.">
                <PathPicker
                  mode="directory"
                  title="Select the LeRobot checkout"
                  value={settings?.lerobotSourcePath ?? ''}
                  onChange={(path) => void saveSettings({ lerobotSourcePath: path })}
                />
              </Field>
            )}

            <Field label="Extras" hint="Comma separated. Add smolvla, pi or diffusion for those policies.">
              <TextInput
                value={extras}
                spellCheck={false}
                onChange={(e) => setExtras(e.currentTarget.value)}
                className="font-mono text-xs"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={busy || !settings?.venvPath}
                title="Old pip resolves LeRobot's extras poorly; worth doing first."
                onClick={() => void startRun('install', { step: 'pip', venvPath: settings?.venvPath })}
              >
                Upgrade pip
              </Button>
              <Button
                variant="primary"
                disabled={busy || !settings?.venvPath}
                onClick={() =>
                  void startRun('install', {
                    step: 'lerobot',
                    venvPath: settings?.venvPath,
                    sourcePath: installFromSource ? settings?.lerobotSourcePath : null,
                    extras: extras
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  })
                }
              >
                Install LeRobot
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !settings?.venvPath}
                onClick={() =>
                  void startRun('install', {
                    step: 'lerobot',
                    venvPath: settings?.venvPath,
                    sourcePath: installFromSource ? settings?.lerobotSourcePath : null,
                    extras: extras.split(',').map((s) => s.trim()).filter(Boolean),
                    upgrade: true
                  })
                }
              >
                Upgrade
              </Button>
            </div>

            {run?.status === 'exited' && run.kind === 'install' && (
              <Notice
                tone="success"
                title="Install finished"
                actions={
                  <Button size="sm" variant="secondary" onClick={() => void refreshCaps(true)}>
                    Re-check
                  </Button>
                }
              >
                Re-check the environment to pick up the newly installed commands.
              </Notice>
            )}
          </div>
        </Panel>

        <Panel
          title="Default locations"
          description="Used to pre-fill the calibration and dataset paths in the other panels."
        >
          <div className="flex flex-col gap-3">
            <Field
              label="Calibration folder"
              hint="Calibration files are written here as <device name>.json."
            >
              <PathPicker
                mode="directory"
                onReveal
                title="Select the calibration folder"
                value={settings?.defaultCalibrationDir ?? ''}
                onChange={(path) => void saveSettings({ defaultCalibrationDir: path })}
              />
            </Field>
            <Field label="Dataset folder" hint="Where recordings go, and where Replay looks for datasets.">
              <PathPicker
                mode="directory"
                onReveal
                title="Select the dataset folder"
                value={settings?.defaultDatasetRoot ?? ''}
                onChange={(path) => void saveSettings({ defaultDatasetRoot: path })}
              />
            </Field>
          </div>
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
        <Panel
          title="Environment status"
          className="shrink-0 overflow-hidden"
          actions={
            <Button
              size="sm"
              variant="secondary"
              disabled={capsLoading || !settings?.venvPath}
              onClick={() => void refreshCaps(true)}
            >
              {capsLoading ? <Spinner /> : 'Re-check'}
            </Button>
          }
        >
          {!settings?.venvPath ? (
            <EmptyState title="No environment selected">
              Choose a folder above and either adopt an existing environment or create a new one.
            </EmptyState>
          ) : capsLoading ? (
            <div className="flex items-center gap-2 text-sm text-ink-500">
              <Spinner /> Probing the environment…
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {caps && !caps.pythonSupported && (
                <Notice tone="error" title={`This environment is on Python ${caps.pythonVersion}`}>
                  {caps.pythonSupportReason}. LeRobot imports, but every command exits with{' '}
                  <code>TypeError: str | None is not callable</code> before it runs. Pick an interpreter in
                  the {PYTHON_RANGE} window above, create a new environment folder, and reinstall LeRobot.
                </Notice>
              )}

              {capsError && (
                <Notice tone="error" title="LeRobot is not importable yet">
                  {capsError}
                </Notice>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-ink-600">Python</dt>
                <dd className="font-mono text-ink-100">{caps?.pythonVersion || '—'}</dd>
                <dt className="text-ink-600">LeRobot</dt>
                <dd className="font-mono text-ink-100">{caps?.lerobotVersion ?? 'not installed'}</dd>
                <dt className="text-ink-600">Calibration root</dt>
                <dd className="truncate font-mono text-ink-300">
                  {caps?.defaultCalibrationRoot ?? '—'}
                </dd>
              </dl>

              <div className="flex flex-wrap gap-1.5">
                <CapBadge ok={!!caps?.hasCalibrate} label="calibrate" />
                <CapBadge ok={!!caps?.hasSetupMotors} label="setup-motors" />
                <CapBadge ok={!!caps?.hasTeleoperate} label="teleoperate" />
                <CapBadge ok={!!caps?.hasRecord} label="record" />
                <CapBadge ok={!!caps?.hasReplay} label="replay" />
                <CapBadge ok={!!caps?.hasRollout} label="rollout" />
                <CapBadge ok={!!caps?.hasPyserial} label="pyserial" />
                <CapBadge ok={!!caps?.hasFeetech} label="feetech sdk" />
                <CapBadge ok={!!caps?.hasOpencv} label="opencv" />
                <CapBadge ok={!!caps?.hasRerun} label="rerun" />
              </div>

              {caps?.ok && !caps.hasRollout && (
                <Notice tone="info" title="Inference uses lerobot-record on this version">
                  This LeRobot build has no <code>lerobot-rollout</code>, so the Infer panel runs a policy
                  through <code>lerobot-record</code> instead. That path requires the dataset name to start
                  with <code>eval_</code>, which the app adds for you.
                </Notice>
              )}

              {caps?.ok && !caps.hasFeetech && (
                <Notice tone="warn" title="Feetech SDK missing">
                  The SO-100/SO-101 motors need it. Add the <code>feetech</code> extra and reinstall.
                </Notice>
              )}
            </div>
          )}
        </Panel>

        <Panel
          scrollBody
          title="Installed packages"
          className="min-h-0 flex-1"
          actions={
            <div className="flex items-center gap-2">
              <TextInput
                value={packageFilter}
                placeholder="Filter…"
                onChange={(e) => setPackageFilter(e.currentTarget.value)}
                className="w-32 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!settings?.venvPath}
                onClick={() => {
                  void api.lerobot.packages().then((res) => {
                    if (res.ok) setPackages(res.value)
                    else setError(res.error)
                  })
                }}
              >
                Load
              </Button>
            </div>
          }
        >
          {packages === null ? (
            <EmptyState title="Not loaded">
              Load the package list to see exactly what is installed in this environment.
            </EmptyState>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-shell-850">
                <tr className="text-left text-ink-600">
                  <th className="pb-1.5 font-medium">Package</th>
                  <th className="pb-1.5 font-medium">Version</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {packages
                  .filter((p) => p.name.toLowerCase().includes(packageFilter.toLowerCase()))
                  .map((p) => (
                    <tr key={p.name} className="border-t border-shell-800">
                      <td className="py-1 text-ink-300">{p.name}</td>
                      <td className="py-1 text-ink-500">{p.version}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Panel>

        <ConsolePane run={run} className="shrink-0" heightClass="h-48" />
      </div>
    </div>
  )
}

function CapBadge({ ok, label }: { ok: boolean; label: string }): ReactNode {
  return <Badge tone={ok ? 'live' : 'neutral'}>{ok ? `✓ ${label}` : `– ${label}`}</Badge>
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}
