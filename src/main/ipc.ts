import type {
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
  InferOptions,
  InstalledPackage,
  LerobotCapabilities,
  MotionTestStart,
  MotorIdWriteRequest,
  MotorIdWriteResult,
  PythonCandidate,
  ReplayOptions,
  RunInfo,
  RunKind,
  ScanResult,
  SerialPortInfo,
  TeleoperateOptions
} from '@shared/types'
import type { Demo, DemoDraft } from '@shared/demos'
import { DEFAULT_ROSBRIDGE_URL, type RosAttachRequest, type RosStatus } from '@shared/ros'
import { THUMBNAIL_EXTENSIONS } from '@shared/demos'
import { drivenInApp } from '@shared/teleop-input'
import { isVirtual } from '@shared/virtual'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { bridge } from './bridge/bridge-client'
import {
  calibrationPathFor,
  readCalibrationFile,
  snapshotFromBridge,
  snapshotFromCalibration,
  snapshotFromDefaults,
  splitCalibrationPath,
  writeCalibrationFile
} from './calibration'
import { discoverLocalDatasets, isDatasetRoot, readDatasetMeta } from './datasets'
import {
  deleteDemo,
  getDemo,
  listDemos,
  removeThumbnail,
  saveThumbnail,
  upsertDemo,
  writeScript
} from './stores/demos'
import { buildDemoCommand, demoShell, scriptPrologue } from './runner/demo-command'
import { defaultCalibrationDir, isLinux, venvExists, venvScript } from './paths'
import { listPackages, probeCapabilities } from './python/capabilities'
import { discoverPythons, inspectPython, inspectVenv, uvPath } from './python/discover'
import {
  buildCreateVenvCommand,
  buildInstallBridgeDepsCommand,
  buildInstallLerobotCommand,
  buildPipListCommand,
  buildUpgradePipCommand
} from './python/installer'
import {
  buildCalibrateCommand,
  buildFindPortCommand,
  buildInferCommand,
  buildRecordCommand,
  buildReplayCommand,
  buildSetupMotorsCommand,
  buildTeleoperateCommand,
  type ScriptResolver
} from './runner/commands'
import { ptyAvailable, ptyError, runner } from './runner/process-runner'
import {
  deleteProfile,
  getProfile,
  isReservedDeviceId,
  isValidDeviceId,
  listProfiles,
  settings,
  upsertProfile
} from './stores/settings'
import { probeRosbridge } from './ros/rosbridge-client'
import { rosClient, rosPublisher } from './ros'
import { virtualBus } from './virtual-bus'

/**
 * Which demo each demo run belongs to.
 *
 * Kept beside the runner rather than on `RunInfo`, which every other kind of run
 * shares and none of the rest would use. Runs only live for as long as the app
 * does, so this never needs persisting; `demos:running` hands the mapping to the
 * renderer when a panel needs to re-attach to a demo already under way.
 */
const demoRunOwners = new Map<string, string>()

let capsCache: LerobotCapabilities | null = null
/** Resolved `uv` path, refreshed whenever the renderer asks for it. */
let uvPathCache: string | null = null

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

function requireVenv(): string {
  const venv = settings().get().venvPath
  if (!venv || !venvExists(venv)) {
    throw new Error('No Python environment is configured yet. Open Settings and set one up first.')
  }
  return venv
}

function resolver(): ScriptResolver {
  const venv = requireVenv()
  return (script) => {
    const path = venvScript(venv, script)
    if (!existsSync(path)) {
      throw new Error(
        `'${script}' is not installed in ${venv}. Install LeRobot with the core_scripts extra from Settings.`
      )
    }
    return path
  }
}

/** Resolve a device, virtual or real. */
function requireDevice(uid: string | null | undefined): DeviceProfile {
  // Told apart, because a command preview asks before anything is selected and
  // "no longer exists" would be both wrong and alarming.
  if (!uid) throw new Error('No device selected.')
  const profile = getProfile(uid)
  if (!profile) throw new Error('That device profile no longer exists.')
  return profile
}

/** Resolve a device that has to be reachable over a wire. */
function requireProfile(uid: string | null | undefined): DeviceProfile {
  const profile = requireDevice(uid)
  if (isVirtual(profile.uid)) {
    throw new Error(
      'The virtual arm is simulated in the app, so it has no serial port and cannot run a LeRobot command.'
    )
  }
  if (!profile.port) throw new Error(`Profile '${profile.id}' has no serial port selected.`)
  return profile
}

/** Resolve a wired device and make sure the sidecar is up to reach it. */
async function wiredDevice(uid: string | null | undefined): Promise<DeviceProfile> {
  const profile = requireProfile(uid)
  await bridge.ensure(requireVenv())
  return profile
}

/**
 * Serial access on Linux commonly fails with EACCES until the user is in the
 * dialout group. Surfacing the fix beats surfacing a Python traceback.
 */
function decorateError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (isLinux && /permission denied|EACCES|could not open port/i.test(message)) {
    return new Error(
      `${message}\n\nOn Linux the serial device usually needs permission. Try:\n` +
        `  sudo usermod -aG dialout $USER   (then log out and back in)\n` +
        `or, for this session only:\n  sudo chmod 666 <your port>`
    )
  }
  return err instanceof Error ? err : new Error(message)
}

/** Every handler returns a discriminated Result so the renderer never throws. */
function handle<Args extends unknown[], T>(
  channel: string,
  fn: (...args: Args) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, value: await fn(...(args as Args)) }
    } catch (err) {
      const e = decorateError(err)
      console.error(`[ipc] ${channel} failed:`, e)
      return {
        ok: false as const,
        error: e.message,
        detail: (err as { detail?: string })?.detail
      }
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/* ------------------------------------------------------------------ *
 * Registration                                                        *
 * ------------------------------------------------------------------ */

export function registerIpc(): void {
  /* -- app / env ---------------------------------------------------- */

  handle('app:info', () => ({
    platform: process.platform,
    ptyAvailable: ptyAvailable(),
    ptyError: ptyError(),
    defaultCalibrationDir: defaultCalibrationDir(),
    canPause: process.platform !== 'win32'
  }))

  handle('settings:get', (): AppSettings => settings().get())

  handle('settings:set', (patch: Partial<AppSettings>): AppSettings => {
    const next = settings().set(patch)
    // A venv change invalidates both the capability cache and the sidecar.
    if ('venvPath' in patch) {
      capsCache = null
      void bridge.shutdown()
    }
    // Sessions follow the address; with none, the next one picks it up.
    if ('rosbridgeUrl' in patch && rosClient.state !== 'idle') {
      rosClient.open(next.rosbridgeUrl || DEFAULT_ROSBRIDGE_URL)
    }
    return next
  })

  handle('python:discover', (): Promise<PythonCandidate[]> => discoverPythons())
  handle('python:inspect', (path: string) => inspectPython(path))
  handle('python:inspectVenv', (path: string) => inspectVenv(path))
  handle('python:uvPath', async () => {
    uvPathCache = await uvPath()
    return uvPathCache
  })

  handle('lerobot:capabilities', async (force?: boolean): Promise<LerobotCapabilities> => {
    const venv = requireVenv()
    if (!force && capsCache && capsCache.venvPath === venv) return capsCache
    capsCache = await probeCapabilities(venv)
    return capsCache
  })

  handle('lerobot:packages', (): Promise<InstalledPackage[]> => listPackages(requireVenv()))

  /* -- profiles ----------------------------------------------------- */

  handle('profiles:list', (): DeviceProfile[] => listProfiles())

  handle('profiles:save', (profile: DeviceProfile): DeviceProfile[] => {
    if (!isValidDeviceId(profile.id)) {
      throw new Error(
        'The device name becomes a filename and a LeRobot id, so use letters, digits, dot, dash or underscore only.'
      )
    }
    if (isReservedDeviceId(profile.id)) {
      throw new Error(`'${profile.id}' is the virtual arm's name — pick another.`)
    }
    const clash = listProfiles().find((p) => p.uid !== profile.uid && p.id === profile.id)
    if (clash) throw new Error(`Another profile already uses the name '${profile.id}'.`)
    return upsertProfile(profile)
  })

  handle('profiles:delete', (uid: string): DeviceProfile[] => deleteProfile(uid))

  /* -- demos -------------------------------------------------------- */

  handle('demos:running', (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const run of runner.list()) {
      const uid = demoRunOwners.get(run.runId)
      if (uid && (run.status === 'running' || run.status === 'starting' || run.status === 'paused')) {
        out[uid] = run.runId
      }
    }
    return out
  })

  handle('demos:list', (): Demo[] => listDemos())

  handle('demos:save', (draft: DemoDraft): Demo[] => upsertDemo(draft))

  handle('demos:delete', (uid: string): Demo[] => {
    // A demo that is still running would keep writing into a console the panel
    // is about to drop, so stop it first. Deleting is the user's decision; the
    // run is just bookkeeping that has to follow it.
    for (const run of runner.list()) {
      if (run.kind === 'demo' && run.status === 'running' && demoRunOwners.get(run.runId) === uid) {
        runner.stop(run.runId)
      }
    }
    return deleteDemo(uid)
  })

  handle('demos:pickThumbnail', async (uid: string): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a thumbnail',
      filters: [{ name: 'Images', extensions: [...THUMBNAIL_EXTENSIONS] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return saveThumbnail(uid, res.filePaths[0])
  })

  handle('demos:clearThumbnail', (name: string): void => removeThumbnail(name))

  /**
   * Start a demo.
   *
   * The script is written out fresh every time, so an edit made since the last
   * run is what runs. Only one instance of a demo is allowed at a time: the
   * modal has a single console and a single stop button, and two copies of a
   * script driving the same arm is never what was meant.
   */
  handle('demos:start', (uid: string): RunInfo => {
    const demo = getDemo(uid)
    if (!demo) throw new Error('That demo no longer exists.')

    const already = runner
      .list()
      .find(
        (r) =>
          r.kind === 'demo' &&
          demoRunOwners.get(r.runId) === uid &&
          (r.status === 'running' || r.status === 'starting' || r.status === 'paused')
      )
    if (already) throw new Error(`'${demo.name}' is already running.`)

    const shell = demoShell()
    const scriptPath = writeScript(uid, `${scriptPrologue(shell)}${demo.script}`, shell.extension)
    const command = buildDemoCommand({
      demo,
      devices: listProfiles(),
      scriptPath,
      venvPath: settings().get().venvPath,
      shell
    })
    const info = runner.start('demo', command)
    demoRunOwners.set(info.runId, uid)
    return info
  })

  /* -- dialogs ------------------------------------------------------ */

  handle(
    'dialog:openDirectory',
    async (opts: { title?: string; defaultPath?: string }): Promise<string | null> => {
      const res = await dialog.showOpenDialog({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
        properties: ['openDirectory', 'createDirectory']
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    }
  )

  handle(
    'dialog:openFile',
    async (opts: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null> => {
      const res = await dialog.showOpenDialog({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
        filters: opts?.filters,
        properties: ['openFile']
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    }
  )

  handle(
    'dialog:saveFile',
    async (opts: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null> => {
      const res = await dialog.showSaveDialog({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
        filters: opts?.filters
      })
      return res.canceled ? null : (res.filePath ?? null)
    }
  )

  handle('shell:showPath', (path: string) => {
    if (!existsSync(path)) throw new Error(`${path} does not exist yet.`)
    shell.showItemInFolder(path)
    return true
  })

  handle('shell:openExternal', (url: string) => shell.openExternal(url))

  /* -- bridge ------------------------------------------------------- */

  handle('bridge:ensure', async () => {
    await bridge.ensure(requireVenv())
    return { running: bridge.running, venvPath: bridge.venvPath }
  })

  handle('bridge:stop', async () => {
    await bridge.shutdown()
    return { running: bridge.running }
  })

  handle('ports:list', async (): Promise<SerialPortInfo[]> => {
    await bridge.ensure(requireVenv())
    return bridge.request<SerialPortInfo[]>('ports.list')
  })

  handle(
    'cameras:list',
    async (includeRealsense = true): Promise<{ cameras: CameraInfo[]; errors: Record<string, string> }> => {
      await bridge.ensure(requireVenv())
      return bridge.request('cameras.list', { includeRealsense }, 120_000)
    }
  )

  handle(
    'cameras:snapshot',
    async (params: {
      type: string
      identifier: string
      width: number
      height: number
      fps: number
    }): Promise<{ width: number; height: number; jpegBase64: string }> => {
      await bridge.ensure(requireVenv())
      return bridge.request('cameras.snapshot', { ...params }, 60_000)
    }
  )

  /* -- motor bus ---------------------------------------------------- *
   *
   * Every call names the arm it is about. The virtual one is answered in
   * process and the real ones through the sidecar, and the two can be open at
   * once — driving the virtual follower from a real leader needs exactly that —
   * so nothing here means "whatever the bridge happens to have open" any more.
   */

  handle('bus:scan', async (uid: string): Promise<ScanResult> => {
    const profile = await wiredDevice(uid)
    return bridge.request<ScanResult>('bus.scan', { port: profile.port }, 180_000)
  })

  /**
   * Open the bus and read the live table. Falls back to the calibration file so
   * motor IDs and limits still display when the arm is unplugged.
   */
  handle('bus:connect', async (uid: string): Promise<BusSnapshot> => {
    if (isVirtual(uid)) return virtualBus.snapshot()
    const profile = await wiredDevice(uid)
    try {
      await bridge.request('bus.open', { port: profile.port }, 30_000)
      rosPublisher.setBusDevice(uid)
      const state = await bridge.request<Parameters<typeof snapshotFromBridge>[1]>('bus.state', {}, 30_000)
      return snapshotFromBridge(profile, state)
    } catch (err) {
      const offline = readOfflineSnapshot(profile)
      const reason = err instanceof Error ? err.message : String(err)
      return {
        ...offline,
        warning: [`Could not talk to the arm on ${profile.port}: ${reason}`, offline.warning]
          .filter(Boolean)
          .join('\n')
      }
    }
  })

  // The virtual arm has no offline state to fall back to: the simulation *is*
  // the arm, and it is always there.
  handle('bus:offlineSnapshot', (uid: string): BusSnapshot =>
    isVirtual(uid) ? virtualBus.snapshot() : readOfflineSnapshot(requireProfile(uid))
  )

  handle('bus:refresh', async (uid: string): Promise<BusSnapshot> => {
    if (isVirtual(uid)) return virtualBus.snapshot()
    const profile = requireProfile(uid)
    const state = await bridge.request<Parameters<typeof snapshotFromBridge>[1]>('bus.state', {}, 30_000)
    return snapshotFromBridge(profile, state)
  })

  handle('bus:disconnect', async (uid?: string) => {
    if (isVirtual(uid)) return virtualBus.close()
    rosPublisher.setBusDevice(null)
    if (!bridge.running) return { closed: true }
    return bridge.request('bus.close', {}, 10_000)
  })

  // Like motor:writeId, this works with no session open — the bridge opens the
  // port itself, so a mis-ID'd arm can be inspected before anything is written.
  handle('bus:presentIds', async (port?: string): Promise<BusPresence> => {
    await bridge.ensure(requireVenv())
    return bridge.request<BusPresence>('bus.presentIds', { port }, 30_000)
  })

  handle('bus:streamStart', (uid: string | undefined, hz: number | undefined) =>
    isVirtual(uid)
      ? virtualBus.streamStart(hz ?? 10)
      : bridge.request('bus.streamStart', { hz: hz ?? 10 })
  )
  // Panels call the stop handlers on teardown without knowing whether anything
  // was ever started, so "stop what isn't running" succeeds trivially rather than
  // failing — the same courtesy bus:disconnect already extends.
  handle('bus:streamStop', (uid?: string) => {
    if (isVirtual(uid)) return virtualBus.streamStop()
    return bridge.running ? bridge.request('bus.streamStop') : { stopped: true }
  })
  handle('bus:configureMotors', () => bridge.request('bus.configure', {}, 60_000))

  // The sequence itself runs in the bridge: it owns the countdown, so cancelling
  // and stopping are the same flag, and a stalled renderer cannot leave the arm
  // moving with nothing watching it.
  handle(
    'motion:start',
    (opts?: { countdownS?: number; settleS?: number; speed?: number }): Promise<MotionTestStart> =>
      bridge.request<MotionTestStart>('motion.start', { ...opts }, 30_000)
  )
  handle('motion:stop', () =>
    bridge.running ? bridge.request<{ stopped: boolean }>('motion.stop', {}, 10_000) : { stopped: true }
  )

  // Auto-calibration drives each joint into its stops to find them, so it shares
  // the motion test's thread and stop flag — only one of the two can ever run.
  handle(
    'autocal:start',
    (opts?: { settleS?: number; speed?: number }): Promise<AutoCalStart> =>
      bridge.request<AutoCalStart>('autocal.start', { ...opts }, 30_000)
  )
  handle('autocal:stop', () =>
    bridge.running ? bridge.request<{ stopped: boolean }>('autocal.stop', {}, 10_000) : { stopped: true }
  )

  handle('bus:recordRom', (durationS: number = 30) =>
    bridge.request('bus.recordRom', { durationS }, (durationS + 15) * 1000)
  )
  handle('bus:stopRom', () => (bridge.running ? bridge.request('bus.stopRom') : { stopped: true }))

  // Writing an ID deliberately does not go through requireVenv()'s bus session:
  // the bridge opens the port itself when nothing is connected.
  handle('motor:writeId', async (req: MotorIdWriteRequest): Promise<MotorIdWriteResult> => {
    await bridge.ensure(requireVenv())
    return bridge.request<MotorIdWriteResult>('motor.writeId', { ...req }, 60_000)
  })
  handle('motor:setLimits', (uid: string, motor: string, rangeMin: number, rangeMax: number) =>
    isVirtual(uid)
      ? virtualBus.setLimits(motor, rangeMin, rangeMax)
      : bridge.request('motor.setLimits', { motor, rangeMin, rangeMax }, 30_000)
  )
  handle('motor:setHoming', (uid: string, motor: string, offset: number) =>
    isVirtual(uid)
      ? virtualBus.setHoming(motor, offset)
      : bridge.request('motor.setHoming', { motor, offset }, 30_000)
  )
  handle('motor:torque', (uid: string, enabled: boolean, motor?: string) =>
    isVirtual(uid)
      ? virtualBus.torque(enabled, motor)
      : bridge.request('motor.torque', { enabled, motor: motor ?? null }, 30_000)
  )
  handle('motor:move', (uid: string, motor: string, position: number) => {
    rosPublisher.command(uid, { [motor]: position })
    return isVirtual(uid)
      ? virtualBus.move(motor, position)
      : bridge.request('motor.move', { motor, position }, 15_000)
  })

  /**
   * Every joint at once — one round trip per control frame.
   *
   * What the app's own driving writes: keyboard and gamepad teleoperation solve
   * a whole pose per frame, and a replay reads one per recorded frame. Writing
   * them one motor at a time would cost six round trips at 50 Hz and land the
   * joints at visibly different moments.
   */
  handle('motor:moveMany', (uid: string, positions: Record<string, number>) => {
    rosPublisher.command(uid, positions)
    return isVirtual(uid)
      ? virtualBus.moveMany(positions)
      : bridge.request<{ written: string[] }>('motor.moveMany', { positions }, 15_000)
  })

  /* -- ROS 2 -------------------------------------------------------- */

  handle('ros:status', (): RosStatus => rosPublisher.status())
  handle('ros:attach', (req: RosAttachRequest): RosStatus => rosPublisher.attach(req))
  handle('ros:detach', (uid: string): RosStatus => rosPublisher.detach(uid))
  // A reloaded renderer has lost the panels that attached anything.
  handle('ros:reset', (): RosStatus => {
    rosPublisher.detachAll()
    return rosPublisher.status()
  })
  handle('ros:test', (url?: string) =>
    probeRosbridge(url || settings().get().rosbridgeUrl || DEFAULT_ROSBRIDGE_URL).then(() => true)
  )

  /* -- calibration files -------------------------------------------- */

  // `requireDevice`, not `requireProfile`: a calibration file is a file, so the
  // virtual arm can have one written and read back like any other device.
  handle('calibration:path', (uid: string) => calibrationPathFor(requireDevice(uid)))

  handle('calibration:read', (uid: string): { path: string; data: CalibrationFile | null } => {
    const profile = requireDevice(uid)
    const path = calibrationPathFor(profile)
    return { path, data: readCalibrationFile(path) }
  })

  handle('calibration:readPath', (path: string): CalibrationFile | null => readCalibrationFile(path))

  handle('calibration:write', (uid: string, data: CalibrationFile) => {
    const profile = requireDevice(uid)
    const path = calibrationPathFor(profile)
    writeCalibrationFile(path, data)
    return path
  })

  handle('calibration:split', (filePath: string) => splitCalibrationPath(filePath))

  handle('calibration:applyToMotors', (uid: string, data: CalibrationFile) =>
    isVirtual(uid)
      ? virtualBus.applyCalibration(data)
      : bridge.request('calibration.apply', { calibration: data }, 60_000)
  )

  handle('calibration:readFromMotors', (uid: string) =>
    isVirtual(uid)
      ? virtualBus.calibration()
      : bridge.request<CalibrationFile>('calibration.read', {}, 30_000)
  )

  /* -- virtual arm -------------------------------------------------- */

  handle('virtual:reset', () => virtualBus.reset())

  /* -- datasets ----------------------------------------------------- */

  handle('datasets:read', (root: string): DatasetMeta => readDatasetMeta(root))

  /**
   * One episode's actions, for the replay the app performs itself.
   *
   * Only needed when the target is the virtual arm — a real follower gets
   * `lerobot-replay`, which is better at this than we could be. Reading the
   * episode still goes through LeRobot's own dataset class, so it needs the
   * environment even though nothing is driven by it.
   */
  handle(
    'datasets:episode',
    async (params: {
      root: string
      repoId: string
      episode: number
      maxFrames?: number
    }): Promise<EpisodeActions> => {
      await bridge.ensure(requireVenv())
      return bridge.request<EpisodeActions>('dataset.episode', { ...params }, 180_000)
    }
  )
  handle('datasets:isRoot', (root: string) => isDatasetRoot(root))
  handle('datasets:discover', (): DatasetMeta[] => {
    const extra = settings().get().defaultDatasetRoot
    return discoverLocalDatasets(extra ? [extra] : [])
  })

  /* -- command previews --------------------------------------------- */

  handle('commands:preview', (kind: RunKind, payload: unknown): CommandSpec => buildCommand(kind, payload))

  /* -- runs --------------------------------------------------------- */

  handle('run:start', (kind: RunKind, payload: unknown): RunInfo => {
    const command = buildCommand(kind, payload)
    return runner.start(kind, command)
  })

  handle('run:startSpec', (kind: RunKind, command: CommandSpec): RunInfo => runner.start(kind, command))

  /**
   * The interactive unplug-diff flow. Needs no profile, so it gets its own
   * channel rather than a RunKind.
   */
  handle('run:findPort', (): RunInfo => runner.start('calibrate', buildFindPortCommand(resolver())))
  handle('run:list', (): RunInfo[] => runner.list())
  handle('run:get', (runId: string) => runner.get(runId))
  handle('run:log', (runId: string) => runner.logOf(runId))
  handle('run:respond', (runId: string, send: string) => runner.respond(runId, send))
  handle('run:write', (runId: string, data: string) => runner.write(runId, data))
  handle('run:resize', (runId: string, cols: number, rows: number) => {
    runner.resize(runId, cols, rows)
    return true
  })
  handle('run:stop', (runId: string) => runner.stop(runId))
  handle('run:kill', (runId: string) => runner.kill(runId))
  handle('run:pause', (runId: string) => runner.pause(runId))
  handle('run:resume', (runId: string) => runner.resume(runId))
  handle('run:clearFinished', () => {
    runner.clearFinished()
    return runner.list()
  })

  /* -- event forwarding --------------------------------------------- */

  runner.on('output', (payload) => broadcast('run:output', payload))
  runner.on('status', (info) => broadcast('run:status', info))
  bridge.on('notification', (frame) => {
    broadcast('bridge:notification', frame)
    if (frame.type === 'positions' && frame.source !== 'virtual') {
      rosPublisher.positions('bus', frame.positions as Record<string, number>)
    }
  })
  // Same channel as the sidecar's frames, tagged with `source: 'virtual'`, so a
  // panel reading positions does not care which arm it is watching.
  virtualBus.on('notification', (frame) => {
    broadcast('bridge:notification', frame)
    if (frame.type === 'positions') rosPublisher.positions('virtual', frame.positions)
  })
  rosPublisher.on('status', (status: RosStatus) => broadcast('ros:status', status))
  rosClient.on('log', (text: string) => broadcast('bridge:log', text))
  bridge.on('log', (text) => broadcast('bridge:log', text))
  bridge.on('closed', (payload) => broadcast('bridge:closed', payload))
  bridge.on('ready', (payload) => broadcast('bridge:ready', payload))
}

/* ------------------------------------------------------------------ *
 * Command assembly                                                    *
 * ------------------------------------------------------------------ */

function readOfflineSnapshot(profile: DeviceProfile): BusSnapshot {
  const path = calibrationPathFor(profile)
  try {
    const data = readCalibrationFile(path)
    if (data) return snapshotFromCalibration(profile, path, data)
  } catch (err) {
    return {
      ...snapshotFromDefaults(profile),
      warning: `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return snapshotFromDefaults(profile)
}

function buildCommand(kind: RunKind, payload: unknown): CommandSpec {
  switch (kind) {
    case 'calibrate': {
      const { uid } = payload as { uid: string }
      return buildCalibrateCommand(resolver(), requireProfile(uid))
    }
    case 'setup-motors': {
      const { uid } = payload as { uid: string }
      return buildSetupMotorsCommand(resolver(), requireProfile(uid))
    }
    case 'teleoperate': {
      const opts = payload as TeleoperateOptions
      if (drivenInApp(opts)) {
        throw new Error(
          'This setup is driven by the app itself, so there is no LeRobot command to run.'
        )
      }
      const devices = resolveTeleopDevices(opts)
      return opts.record
        ? buildRecordCommand(resolver(), opts, devices)
        : buildTeleoperateCommand(resolver(), opts, devices)
    }
    case 'record': {
      const opts = payload as TeleoperateOptions
      return buildRecordCommand(resolver(), { ...opts, record: true }, resolveTeleopDevices(opts))
    }
    case 'replay': {
      const opts = payload as ReplayOptions
      return buildReplayCommand(resolver(), opts, requireProfile(opts.robotUid))
    }
    case 'infer': {
      const opts = payload as InferOptions
      const caps = capsCache ?? { hasRollout: false }
      return buildInferCommand(resolver(), caps, opts, requireProfile(opts.robotUid))
    }
    case 'venv': {
      const { pythonPath, venvPath, preferUv } = payload as {
        pythonPath: string
        venvPath: string
        preferUv?: boolean
      }
      if (!pythonPath) throw new Error('Choose a Python interpreter first.')
      if (!venvPath) throw new Error('Choose where the environment should live.')
      return buildCreateVenvCommand({ pythonPath, venvPath, preferUv, uvPath: uvPathCache })
    }
    case 'install': {
      const { step, venvPath, sourcePath, extras, upgrade } = payload as {
        step?: 'pip' | 'lerobot' | 'bridge-deps'
        venvPath: string
        sourcePath?: string | null
        extras?: string[]
        upgrade?: boolean
      }
      const venv = venvPath || requireVenv()
      if (step === 'pip') return buildUpgradePipCommand(venv)
      if (step === 'bridge-deps') return buildInstallBridgeDepsCommand(venv)
      return buildInstallLerobotCommand({ venvPath: venv, sourcePath, extras, upgrade })
    }
    case 'pip-list':
      return buildPipListCommand(requireVenv())
    case 'demo':
      // Demos carry their own script rather than a built argv, so they are
      // started through `demos:start`. Listed here so this stays exhaustive.
      throw new Error('Demos are started with demos:start, not run:start.')
    default: {
      const exhaustive: never = kind
      throw new Error(`Unsupported run kind: ${String(exhaustive)}`)
    }
  }
}

function resolveTeleopDevices(opts: TeleoperateOptions) {
  return {
    robot: getProfile(opts.robotUid),
    leader: getProfile(opts.leaderUid),
    leftRobot: getProfile(opts.leftRobotUid),
    rightRobot: getProfile(opts.rightRobotUid),
    leftLeader: getProfile(opts.leftLeaderUid),
    rightLeader: getProfile(opts.rightLeaderUid)
  }
}
