import { useEffect, type ReactNode } from 'react'
import { Badge, Spinner } from './components/ui'
import { Wordmark } from './components/Wordmark'
import { api } from './lib/api'
import { useResolvedTheme } from './lib/theme'
import { AboutPanel } from './panels/AboutPanel'
import { ConfigurePanel } from './panels/ConfigurePanel'
import { DemosPanel } from './panels/DemosPanel'
import { InferPanel } from './panels/InferPanel'
import { ReplayPanel } from './panels/ReplayPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import { TeleoperatePanel } from './panels/TeleoperatePanel'
import { View3DPanel } from './panels/View3DPanel'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore, type PanelId } from './store/useAppStore'

/** Workflow tabs, left to right. Settings is deliberately not one of them. */
const TABS: { id: PanelId; label: string; hint: string }[] = [
  { id: 'configure', label: 'Configure', hint: 'Motors, calibration and device profiles' },
  { id: 'view3d', label: '3D View', hint: 'A follower’s own model, posed from its motor readings' },
  { id: 'teleoperate', label: 'Teleoperate', hint: 'Drive a follower from a leader, and record' },
  { id: 'replay', label: 'Replay', hint: 'Play a recorded episode back on the arm' },
  { id: 'infer', label: 'Infer', hint: 'Run a trained policy on the arm' },
  { id: 'demos', label: 'Demos', hint: 'Saved scripts, one card each' }
]

const SETTINGS_TAB = {
  id: 'settings' as const,
  label: 'Settings',
  hint: 'Appearance, Python environment and LeRobot install'
}

const ABOUT_TAB = {
  id: 'about' as const,
  label: 'About',
  hint: 'Who made this, and what it is for'
}

function tabClass(active: boolean): string {
  return `relative rounded-t-md px-3.5 py-2 text-sm transition-colors ${
    active
      ? 'bg-shell-900 font-semibold text-ink-100'
      : 'text-ink-500 hover:bg-shell-850 hover:text-ink-300'
  }`
}

export function App(): ReactNode {
  const {
    panel,
    setPanel,
    bootstrap,
    settings,
    saveSettings,
    caps,
    capsLoading,
    upsertRun,
    runs,
    activeRunId
  } = useAppStore(
    useShallow((s) => ({
      panel: s.panel,
      setPanel: s.setPanel,
      bootstrap: s.bootstrap,
      settings: s.settings,
      saveSettings: s.saveSettings,
      caps: s.caps,
      capsLoading: s.capsLoading,
      upsertRun: s.upsertRun,
      runs: s.runs,
      activeRunId: s.activeRunId
    })))

  const resolvedTheme = useResolvedTheme()

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Paint the theme onto <html>; every colour token hangs off this attribute.
  // `system` keeps listening, so the app follows the OS while it is running.
  useEffect(() => {
    const choice = settings?.theme ?? 'dark'
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      const light = choice === 'light' || (choice === 'system' && media.matches)
      root.dataset.theme = light ? 'light' : 'dark'
    }
    apply()
    if (choice !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.theme])

  // Run status arrives from the main process for every panel, so subscribe once.
  useEffect(() => {
    const offStatus = api.runs.onStatus((info) => upsertRun(info))
    const offClosed = api.bridge.onClosed(() => {
      // The sidecar died; panels re-open it on their next call.
      console.warn('[bridge] closed')
    })
    return () => {
      offStatus()
      offClosed()
    }
  }, [upsertRun])

  const activeRun = runs.find((r) => r.runId === activeRunId) ?? null
  const busyRuns = runs.filter((r) => r.status === 'running' || r.status === 'paused')

  return (
    <div className="flex h-full flex-col bg-shell-900">
      <header className="drag-region flex shrink-0 items-center gap-4 border-b border-shell-700 bg-shell-950 px-4 pt-2 pb-0">
        <div className="no-drag flex items-center gap-3 pb-2.5 pl-16">
          <Wordmark />
          <span className="h-6 w-px shrink-0 bg-shell-700" aria-hidden />
          <ArmMark />
          <div className="leading-tight">
            <h1 className="text-sm font-semibold text-ink-100">LeRobot Control</h1>
            <p className="text-[11px] text-ink-600">SO-100 / SO-101 arms</p>
          </div>
        </div>

        <nav className="no-drag flex items-end gap-1 self-end">
          {TABS.map((tab) => {
            const active = panel === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                title={tab.hint}
                onClick={() => setPanel(tab.id)}
                className={tabClass(active)}
              >
                {tab.label}
                {active && <span className="absolute inset-x-0 -bottom-px h-px bg-shell-900" />}
              </button>
            )
          })}
        </nav>

        <div className="no-drag ml-auto flex items-end gap-2 self-end pb-0">
          <div className="flex items-center gap-2 pb-2.5">
            {busyRuns.length > 0 && (
              <Badge tone="live">
                <Spinner className="h-2.5 w-2.5" />
                {busyRuns.length} running
              </Badge>
            )}
            <EnvBadge
              loading={capsLoading}
              venv={settings?.venvPath ?? null}
              ok={!!caps?.ok}
              version={caps?.lerobotVersion ?? null}
              onClick={() => setPanel('settings')}
            />
          </div>

          <button
            type="button"
            title={
              resolvedTheme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
            }
            aria-label="Toggle light and dark theme"
            onClick={() => void saveSettings({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}
            className="mb-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-shell-850 hover:text-ink-100"
          >
            {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>

          <button
            type="button"
            title={SETTINGS_TAB.hint}
            onClick={() => setPanel(SETTINGS_TAB.id)}
            className={`${tabClass(panel === SETTINGS_TAB.id)} flex items-center gap-1.5`}
          >
            <GearIcon />
            {SETTINGS_TAB.label}
            {panel === SETTINGS_TAB.id && (
              <span className="absolute inset-x-0 -bottom-px h-px bg-shell-900" />
            )}
            {!settings?.venvPath && (
              <span className="absolute top-1.5 right-1 h-1.5 w-1.5 rounded-full bg-warn-400" />
            )}
          </button>

          <button
            type="button"
            title={ABOUT_TAB.hint}
            onClick={() => setPanel(ABOUT_TAB.id)}
            className={tabClass(panel === ABOUT_TAB.id)}
          >
            {ABOUT_TAB.label}
            {panel === ABOUT_TAB.id && (
              <span className="absolute inset-x-0 -bottom-px h-px bg-shell-900" />
            )}
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col p-4">
        {panel === 'configure' && <ConfigurePanel />}
        {panel === 'view3d' && <View3DPanel />}
        {panel === 'teleoperate' && <TeleoperatePanel />}
        {panel === 'replay' && <ReplayPanel />}
        {panel === 'infer' && <InferPanel />}
        {panel === 'demos' && <DemosPanel />}
        {panel === 'settings' && <SettingsPanel />}
        {panel === 'about' && <AboutPanel />}
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-shell-700 bg-shell-950 px-4 py-1.5 text-[11px] text-ink-600">
        <span className="truncate font-mono">
          {activeRun ? activeRun.command : 'No command running'}
        </span>
        {activeRun?.status === 'paused' && <span className="shrink-0 text-warn-400">suspended</span>}
      </footer>
    </div>
  )
}

function EnvBadge({
  loading,
  venv,
  ok,
  version,
  onClick
}: {
  loading: boolean
  venv: string | null
  ok: boolean
  version: string | null
  onClick: () => void
}): ReactNode {
  const label = loading
    ? 'checking…'
    : !venv
      ? 'no environment'
      : ok
        ? `LeRobot ${version ?? ''}`.trim()
        : 'LeRobot missing'
  const tone = loading ? 'accent' : ok ? 'live' : 'warn'
  return (
    <button type="button" onClick={onClick} title="Open Settings">
      <Badge tone={tone as 'accent' | 'live' | 'warn'}>
        {loading && <Spinner className="h-2.5 w-2.5" />}
        {label}
      </Badge>
    </button>
  )
}

/** Shows the theme you would switch *to*, which is the convention users expect. */
function SunIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2.8v2.1M12 19.1v2.1M21.2 12h-2.1M4.9 12H2.8M18.5 5.5l-1.5 1.5M7 17l-1.5 1.5M18.5 18.5 17 17M7 7 5.5 5.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GearIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7 5.4 5.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Small mark echoing the arm silhouette, so the header is not text-only. */
function ArmMark(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden>
      <rect x="6" y="20" width="12" height="2.5" rx="1" className="fill-shell-500" />
      <rect x="9.5" y="12" width="5" height="8.5" rx="1.4" className="fill-shell-600" />
      <path d="M12 13 L17 7" className="stroke-accent-400" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M17 7 L13 3" className="stroke-live-400" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="12" cy="13" r="2" className="fill-shell-950 stroke-accent-400" strokeWidth="1.4" />
      <circle cx="17" cy="7" r="1.8" className="fill-shell-950 stroke-live-400" strokeWidth="1.4" />
    </svg>
  )
}
