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

export type PanelId =
  | 'configure'
  | 'view3d'
  | 'teleoperate'
  | 'replay'
  | 'infer'
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
  ports: SerialPortInfo[]
  portsError: string | null
  portsLoading: boolean
  runs: RunInfo[]
  /** Run currently shown in the console pane. */
  activeRunId: string | null

  setPanel: (panel: PanelId) => void
  bootstrap: () => Promise<void>
  refreshSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  refreshCaps: (force?: boolean) => Promise<void>
  refreshProfiles: () => Promise<void>
  saveProfile: (profile: DeviceProfile) => Promise<string | null>
  removeProfile: (uid: string) => Promise<void>
  refreshPorts: () => Promise<void>
  setActiveRun: (runId: string | null) => void
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
  ports: [],
  portsError: null,
  portsLoading: false,
  runs: [],
  activeRunId: null,

  setPanel: (panel) => set({ panel }),

  bootstrap: async () => {
    const [info, settings, profiles] = await Promise.all([
      attempt(api.app.info()),
      attempt(api.settings.get()),
      attempt(api.profiles.list())
    ])
    set({
      appInfo: info.value ?? null,
      settings: settings.value ?? null,
      profiles: profiles.value ?? []
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
    if (res.value) set({ profiles: res.value })
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
