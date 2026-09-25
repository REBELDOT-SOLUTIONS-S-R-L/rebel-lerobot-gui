import type { Demo, DemoDraft } from '@shared/demos'
import type {
  AppInfo,
  AppSettings,
  DeviceProfile,
  LerobotCapabilities,
  RunInfo,
  SerialPortInfo
} from '@shared/types'
import { create } from 'zustand'
import { api, attempt } from '../lib/api'
import { forgetDevice, type PanelSelections } from '../lib/panel-selections'

export type PanelId =
  | 'configure'
  | 'view3d'
  | 'teleoperate'
  | 'replay'
  | 'infer'
  | 'demos'
  | 'settings'
  | 'about'

interface AppState {
  panel: PanelId
  appInfo: AppInfo | null
  settings: AppSettings | null
  caps: LerobotCapabilities | null
  capsError: string | null
  capsLoading: boolean
  profiles: DeviceProfile[]
  demos: Demo[]
  /**
   * Demo uid -> runId, for the demos currently under way.
   *
   * A demo's console has to survive its modal being closed and reopened, so the
   * link between a demo and its run lives here rather than in the modal.
   */
  demoRuns: Record<string, string>
  ports: SerialPortInfo[]
  portsError: string | null
  portsLoading: boolean
  runs: RunInfo[]
  /** Run currently shown in the console pane. */
  activeRunId: string | null
  /**
   * Panel selections that outlive the panel.
   *
   * Only one panel is mounted at a time, so this is where the choices that led
   * to a view are kept while another tab is open — see `useSticky`, which is the
   * only thing that should read or write it.
   */
  sticky: Partial<PanelSelections>

  setPanel: (panel: PanelId) => void
  bootstrap: () => Promise<void>
  refreshSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  refreshCaps: (force?: boolean) => Promise<void>
  refreshProfiles: () => Promise<void>
  saveProfile: (profile: DeviceProfile) => Promise<string | null>
  removeProfile: (uid: string) => Promise<void>
  refreshDemos: () => Promise<void>
  saveDemo: (demo: DemoDraft) => Promise<string | null>
  removeDemo: (uid: string) => Promise<void>
  startDemo: (uid: string) => Promise<string | null>
  refreshPorts: () => Promise<void>
  setActiveRun: (runId: string | null) => void
  setSticky: <K extends keyof PanelSelections>(key: K, value: PanelSelections[K]) => void
  upsertRun: (info: RunInfo) => void
  refreshRuns: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  panel: 'configure',
  appInfo: null,
  settings: null,
  caps: null,
  capsError: null,
  capsLoading: false,
  profiles: [],
  demos: [],
  demoRuns: {},
  ports: [],
  portsError: null,
  portsLoading: false,
  runs: [],
  activeRunId: null,
  sticky: {},

  setPanel: (panel) => set({ panel }),

  bootstrap: async () => {
    const [info, settings, profiles, demos, demoRuns] = await Promise.all([
      attempt(api.app.info()),
      attempt(api.settings.get()),
      attempt(api.profiles.list()),
      attempt(api.demos.list()),
      attempt(api.demos.running())
    ])
    set({
      appInfo: info.value ?? null,
      settings: settings.value ?? null,
      profiles: profiles.value ?? [],
      demos: demos.value ?? [],
      // A dev reload leaves the main process — and any demo it started — alive,
      // so pick those back up rather than showing them as stopped.
      demoRuns: demoRuns.value ?? {}
    })
    // Land on Settings when there is no environment yet — nothing else can work.
    if (!settings.value?.venvPath) set({ panel: 'settings' })
    else await get().refreshCaps()
    await get().refreshRuns()
  },

  refreshSettings: async () => {
    const res = await attempt(api.settings.get())
    if (res.value) set({ settings: res.value })
  },

  saveSettings: async (patch) => {
    const res = await attempt(api.settings.set(patch))
    if (res.value) set({ settings: res.value })
    if ('venvPath' in patch) {
      set({ caps: null, capsError: null, ports: [] })
      await get().refreshCaps(true)
    }
  },

  refreshCaps: async (force) => {
    if (!get().settings?.venvPath) {
      set({ caps: null, capsError: null })
      return
    }
    set({ capsLoading: true })
    const res = await attempt(api.lerobot.capabilities(force))
    set({
      caps: res.value ?? null,
      capsError: res.error ?? res.value?.error ?? null,
      capsLoading: false
    })
  },

  refreshProfiles: async () => {
    const res = await attempt(api.profiles.list())
    if (res.value) set({ profiles: res.value })
  },

  /** Returns an error message, or null on success. */
  saveProfile: async (profile) => {
    const res = await attempt(api.profiles.save(profile))
    if (res.value) {
      set({ profiles: res.value })
      return null
    }
    return res.error ?? 'Could not save the profile.'
  },

  removeProfile: async (uid) => {
    const res = await attempt(api.profiles.remove(uid))
    if (!res.value) return
    const profiles = res.value
    // Deleting a profile is the only thing that can make a selection dangle, so
    // it is the one place that has to let go of it.
    set((state) => ({ profiles, sticky: forgetDevice(state.sticky, uid) }))
  },

  refreshDemos: async () => {
    const res = await attempt(api.demos.list())
    if (res.value) set({ demos: res.value })
  },

  saveDemo: async (demo) => {
    const res = await attempt(api.demos.save(demo))
    if (res.value) {
      set({ demos: res.value })
      return null
    }
    return res.error ?? 'Could not save the demo.'
  },

  removeDemo: async (uid) => {
    const res = await attempt(api.demos.remove(uid))
    if (!res.value) return
    // Let go of the run too: the main process stops it as part of the delete,
    // and leaving the id here would point at a run nothing can reach.
    const demoRuns = { ...get().demoRuns }
    delete demoRuns[uid]
    set({ demos: res.value, demoRuns })
  },

  startDemo: async (uid) => {
    const res = await attempt(api.demos.start(uid))
    if (!res.value) return res.error ?? 'Could not start the demo.'
    const info = res.value
    set((state) => ({
      demoRuns: { ...state.demoRuns, [uid]: info.runId },
      runs: [...state.runs.filter((r) => r.runId !== info.runId), info],
      activeRunId: info.runId
    }))
    return null
  },

  refreshPorts: async () => {
    if (!get().settings?.venvPath) {
      set({ portsError: 'Configure a Python environment in Settings to list serial ports.' })
      return
    }
    set({ portsLoading: true })
    const res = await attempt(api.ports.list())
    set({ ports: res.value ?? [], portsError: res.error ?? null, portsLoading: false })
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),

  setSticky: (key, value) => set((state) => ({ sticky: { ...state.sticky, [key]: value } })),

  upsertRun: (info) =>
    set((state) => {
      const idx = state.runs.findIndex((r) => r.runId === info.runId)
      const runs = idx >= 0 ? state.runs.map((r) => (r.runId === info.runId ? info : r)) : [...state.runs, info]
      return { runs }
    }),

  refreshRuns: async () => {
    const res = await attempt(api.runs.list())
    if (res.value) set({ runs: res.value })
  }
}))

/** Convenience selectors. */
export const selectProfilesByRole = (role: 'robot' | 'teleop') => (s: AppState) =>
  s.profiles.filter((p) => p.role === role)

export const selectRun = (runId: string | null) => (s: AppState) =>
  runId ? (s.runs.find((r) => r.runId === runId) ?? null) : null

export function isEnvReady(s: AppState): boolean {
  return !!s.settings?.venvPath && !!s.caps?.ok
}
