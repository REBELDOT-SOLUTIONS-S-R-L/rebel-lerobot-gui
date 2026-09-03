import type {
  AppInfo,
  AppSettings,
  AutoCalStart,
  BusPresence,
  BusSnapshot,
  CalibrationFile,
  CameraInfo,
  CommandSpec,
  DatasetMeta,
  DeviceProfile,
  EpisodeActions,
  FileFilter,
  InstalledPackage,
  LerobotCapabilities,
  MotionTestStart,
  MotorIdWriteRequest,
  MotorIdWriteResult,
  PythonCandidate,
  Result,
  RunInfo,
  RunKind,
  ScanResult,
  SerialPortInfo
} from '@shared/types'
import { contextBridge, ipcRenderer } from 'electron'

type Unsubscribe = () => void

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * The whole renderer surface. Every call resolves to a Result so panels can show
 * an error inline instead of dealing with rejected promises.
 */
const api = {
  app: {
    info: () => invoke<AppInfo>('app:info')
  },

  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings:set', patch)
  },

  python: {
    discover: () => invoke<PythonCandidate[]>('python:discover'),
    inspect: (path: string) => invoke<PythonCandidate | null>('python:inspect', path),
    inspectVenv: (path: string) => invoke<PythonCandidate | null>('python:inspectVenv', path),
    uvPath: () => invoke<string | null>('python:uvPath')
  },

  lerobot: {
    capabilities: (force?: boolean) => invoke<LerobotCapabilities>('lerobot:capabilities', force),
    packages: () => invoke<InstalledPackage[]>('lerobot:packages')
  },

  profiles: {
    list: () => invoke<DeviceProfile[]>('profiles:list'),
    save: (profile: DeviceProfile) => invoke<DeviceProfile[]>('profiles:save', profile),
    remove: (uid: string) => invoke<DeviceProfile[]>('profiles:delete', uid)
  },

  dialog: {
    openDirectory: (opts: { title?: string; defaultPath?: string } = {}) =>
      invoke<string | null>('dialog:openDirectory', opts),
    openFile: (opts: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {}) =>
      invoke<string | null>('dialog:openFile', opts),
    saveFile: (opts: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {}) =>
      invoke<string | null>('dialog:saveFile', opts)
  },

  shell: {
    showPath: (path: string) => invoke<boolean>('shell:showPath', path),
    openExternal: (url: string) => invoke<void>('shell:openExternal', url)
  },

  bridge: {
    ensure: () => invoke<{ running: boolean; venvPath: string | null }>('bridge:ensure'),
    stop: () => invoke<{ running: boolean }>('bridge:stop'),
    onNotification: (cb: (frame: Record<string, unknown>) => void) =>
      on<Record<string, unknown>>('bridge:notification', cb),
    onLog: (cb: (text: string) => void) => on<string>('bridge:log', cb),
    onClosed: (cb: (payload: { reason: string }) => void) => on<{ reason: string }>('bridge:closed', cb),
    onReady: (cb: (payload: { venvPath: string }) => void) => on<{ venvPath: string }>('bridge:ready', cb)
  },

  ports: {
    list: () => invoke<SerialPortInfo[]>('ports:list')
  },

  cameras: {
    list: (includeRealsense = true) =>
      invoke<{ cameras: CameraInfo[]; errors: Record<string, string> }>('cameras:list', includeRealsense),
    snapshot: (params: { type: string; identifier: string; width: number; height: number; fps: number }) =>
      invoke<{ width: number; height: number; jpegBase64: string }>('cameras:snapshot', params)
  },

  /**
   * Reads and writes on one arm's motors.
   *
   * Every call names the device it is about: the virtual arm is answered inside
   * the app and the real ones by the Python sidecar, and both can be open at
   * once — a real leader driving the virtual follower needs exactly that.
   */
  bus: {
    scan: (uid: string) => invoke<ScanResult>('bus:scan', uid),
    connect: (uid: string) => invoke<BusSnapshot>('bus:connect', uid),
    offlineSnapshot: (uid: string) => invoke<BusSnapshot>('bus:offlineSnapshot', uid),
    refresh: (uid: string) => invoke<BusSnapshot>('bus:refresh', uid),
    disconnect: (uid?: string) => invoke<{ closed: boolean }>('bus:disconnect', uid),
    presentIds: (port?: string) => invoke<BusPresence>('bus:presentIds', port),
    streamStart: (uid?: string, hz?: number) => invoke<{ hz: number }>('bus:streamStart', uid, hz),
    streamStop: (uid?: string) => invoke<{ stopped: boolean }>('bus:streamStop', uid),
    configureMotors: () => invoke<{ configured: boolean }>('bus:configureMotors'),
    recordRom: (durationS?: number) =>
      invoke<{ mins: Record<string, number>; maxes: Record<string, number> }>('bus:recordRom', durationS),
    stopRom: () => invoke<{ stopped: boolean }>('bus:stopRom')
  },

  autocal: {
    start: (opts?: { settleS?: number; speed?: number }) =>
      invoke<AutoCalStart>('autocal:start', opts),
    stop: () => invoke<{ stopped: boolean }>('autocal:stop')
  },

  motion: {
    start: (opts?: { countdownS?: number; settleS?: number; speed?: number }) =>
      invoke<MotionTestStart>('motion:start', opts),
    stop: () => invoke<{ stopped: boolean }>('motion:stop')
  },

  motor: {
    writeId: (req: MotorIdWriteRequest) => invoke<MotorIdWriteResult>('motor:writeId', req),
    setLimits: (uid: string, motor: string, rangeMin: number, rangeMax: number) =>
      invoke<{ motor: string; rangeMin: number; rangeMax: number }>(
        'motor:setLimits',
        uid,
        motor,
        rangeMin,
        rangeMax
      ),
    setHoming: (uid: string, motor: string, offset: number) =>
      invoke<{ motor: string; homingOffset: number }>('motor:setHoming', uid, motor, offset),
    torque: (uid: string, enabled: boolean, motor?: string) =>
      invoke<{ enabled: boolean }>('motor:torque', uid, enabled, motor),
    move: (uid: string, motor: string, position: number) =>
      invoke<{ motor: string; goal: number }>('motor:move', uid, motor, position),
    /** Every joint in one write — a control frame, or a replayed one. */
    moveMany: (uid: string, positions: Record<string, number>) =>
      invoke<{ written: string[] }>('motor:moveMany', uid, positions)
  },

  virtual: {
    /** Put the simulated arm back to the middle of every factory range. */
    reset: () => invoke<{ reset: true }>('virtual:reset')
  },

  calibration: {
    path: (uid: string) => invoke<string>('calibration:path', uid),
    read: (uid: string) => invoke<{ path: string; data: CalibrationFile | null }>('calibration:read', uid),
    readPath: (path: string) => invoke<CalibrationFile | null>('calibration:readPath', path),
    write: (uid: string, data: CalibrationFile) => invoke<string>('calibration:write', uid, data),
    split: (filePath: string) =>
      invoke<{ calibrationDir: string; id: string }>('calibration:split', filePath),
    applyToMotors: (uid: string, data: CalibrationFile) =>
      invoke<{ applied: string[] }>('calibration:applyToMotors', uid, data),
    readFromMotors: (uid: string) => invoke<CalibrationFile>('calibration:readFromMotors', uid)
  },

  datasets: {
    read: (root: string) => invoke<DatasetMeta>('datasets:read', root),
    isRoot: (root: string) => invoke<boolean>('datasets:isRoot', root),
    discover: () => invoke<DatasetMeta[]>('datasets:discover'),
    episode: (params: { root: string; repoId: string; episode: number; maxFrames?: number }) =>
      invoke<EpisodeActions>('datasets:episode', params)
  },

  commands: {
    preview: (kind: RunKind, payload: unknown) => invoke<CommandSpec>('commands:preview', kind, payload)
  },

  runs: {
    start: (kind: RunKind, payload: unknown) => invoke<RunInfo>('run:start', kind, payload),
    startSpec: (kind: RunKind, command: CommandSpec) => invoke<RunInfo>('run:startSpec', kind, command),
    findPort: () => invoke<RunInfo>('run:findPort'),
    list: () => invoke<RunInfo[]>('run:list'),
    get: (runId: string) => invoke<RunInfo | null>('run:get', runId),
    log: (runId: string) => invoke<string>('run:log', runId),
    respond: (runId: string, send: string) => invoke<boolean>('run:respond', runId, send),
    write: (runId: string, data: string) => invoke<boolean>('run:write', runId, data),
    resize: (runId: string, cols: number, rows: number) =>
      invoke<boolean>('run:resize', runId, cols, rows),
    stop: (runId: string) => invoke<boolean>('run:stop', runId),
    kill: (runId: string) => invoke<boolean>('run:kill', runId),
    pause: (runId: string) => invoke<boolean>('run:pause', runId),
    resume: (runId: string) => invoke<boolean>('run:resume', runId),
    clearFinished: () => invoke<RunInfo[]>('run:clearFinished'),
    onOutput: (cb: (payload: { runId: string; data: string }) => void) =>
      on<{ runId: string; data: string }>('run:output', cb),
    onStatus: (cb: (info: RunInfo) => void) => on<RunInfo>('run:status', cb)
  }
}

export type LerobotApi = typeof api

contextBridge.exposeInMainWorld('lerobotGui', api)
