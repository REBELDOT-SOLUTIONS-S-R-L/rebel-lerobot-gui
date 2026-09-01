import { app } from 'electron'
import { join, resolve } from 'node:path'

/**
 * Electron-dependent locations. The pure helpers live in `fs-paths.ts` and are
 * re-exported here so callers only need one import.
 */
export {
  VENV_BIN,
  exeName,
  expandHome,
  isLinux,
  isMac,
  isWindows,
  lerobotHome,
  venvExists,
  venvPython,
  venvScript
} from './fs-paths'

/**
 * Repo root during development.
 *
 * Derived from this bundle's own location (`out/main/index.js`) rather than from
 * `app.getAppPath()`, which depends on how Electron was invoked — running a
 * script directly, as the smoke test does, would otherwise resolve assets
 * relative to that script's folder.
 */
function devRoot(): string {
  return resolve(__dirname, '..', '..')
}

/**
 * Project root: the repo while developing, the per-user data dir once packaged
 * (an installed app's own directory is not writable).
 */
export function projectRoot(): string {
  return app.isPackaged ? app.getPath('userData') : devRoot()
}

/** Where the arm renders live. */
export function assetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'assets') : join(devRoot(), 'assets')
}

/** Where the Python bridge script lives. */
export function bridgeScript(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bridge', 'lerobot_gui_bridge.py')
    : join(devRoot(), 'resources', 'bridge', 'lerobot_gui_bridge.py')
}

export function defaultCalibrationDir(): string {
  return join(projectRoot(), 'calibration')
}

export function defaultDatasetRoot(): string {
  return join(projectRoot(), 'samples')
}
