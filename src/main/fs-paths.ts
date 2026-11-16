import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Path helpers that do NOT touch Electron.
 *
 * Kept separate from `paths.ts` so that unit tests (and anything else running
 * under plain Node) can use them without pulling in the electron module.
 */

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

/** `bin` on POSIX, `Scripts` on Windows. */
export const VENV_BIN = isWindows ? 'Scripts' : 'bin'

/** Add `.exe` on Windows. */
export function exeName(name: string): string {
  return isWindows ? `${name}.exe` : name
}

export function venvPython(venvPath: string): string {
  return join(venvPath, VENV_BIN, exeName('python'))
}

/** Path to a console script inside a venv, e.g. `lerobot-calibrate`. */
export function venvScript(venvPath: string, script: string): string {
  return join(venvPath, VENV_BIN, exeName(script))
}

export function venvExists(venvPath: string | null | undefined): boolean {
  return !!venvPath && existsSync(venvPython(venvPath))
}

/**
 * LeRobot's own cache root: `$HF_LEROBOT_HOME`, else `$HF_HOME/lerobot`, else
 * `~/.cache/huggingface/lerobot` (utils/constants.py:59-75).
 *
 * Note `LEROBOT_HOME` is deliberately ignored: LeRobot *raises on import* if it
 * is set, so we must never read or propagate it.
 */
export function lerobotHome(): string {
  const explicit = process.env.HF_LEROBOT_HOME
  if (explicit) return explicit
  const hfHome = process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface')
  return join(hfHome, 'lerobot')
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/* ------------------------------------------------------------------ *
 * Folders kept relative to the project                                *
 * ------------------------------------------------------------------ */

/** The project's own folder for calibration files. */
export const CALIBRATION_FOLDER = 'calibration'

/** The project's own folder for recorded datasets. */
export const DATASET_FOLDER = 'data'

/**
 * A folder as it is stored: relative to the project when it is inside it,
 * absolute otherwise.
 *
 * Settings and profiles used to store absolute paths, so moving or re-cloning
 * the project left every one of them pointing at a folder that no longer
 * existed. Stored relative, the project's own `calibration/` and `data/` follow
 * it wherever it goes; a folder elsewhere on the disk is still remembered as is.
 */
export function toProjectRelative(path: string, root: string): string {
  if (!path) return path
  const absolute = resolve(expandHome(path))
  const rel = relative(resolve(root), absolute)
  if (rel === '') return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return absolute
  return rel.split(sep).join('/')
}

/** The inverse: a stored folder as an absolute path. */
export function fromProjectRelative(stored: string, root: string): string {
  if (!stored) return stored
  const expanded = expandHome(stored)
  return isAbsolute(expanded) ? expanded : join(root, expanded)
}

/**
 * A stored folder, repaired if it belongs to a project that has since moved.
 *
 * An absolute path ending in one of the project's own folder names was that
 * folder in the project's old location when it no longer exists, or when it sits
 * in a folder named like the project (`…/rebel-lerobot-gui/calibration`) that is
 * not this one — the app used to recreate its default folder there on every
 * launch, so existing proves nothing. Either way it becomes the relative
 * default. A folder of that name anywhere else is a deliberate choice and is
 * kept. `renamed` lists older names for the same folder: datasets used to go in
 * `samples/`.
 */
export function relocateProjectFolder(
  stored: string,
  root: string,
  folder: string,
  exists: (path: string) => boolean = existsSync,
  renamed: readonly string[] = []
): string {
  if (!stored) return folder
  const relativeForm = toProjectRelative(stored, root)
  if (renamed.includes(relativeForm)) return folder
  if (!isAbsolute(relativeForm)) return relativeForm
  const name = basename(relativeForm)
  if (name !== folder && !renamed.includes(name)) return relativeForm
  const oldProject = basename(dirname(relativeForm)) === basename(resolve(root))
  return oldProject || !exists(relativeForm) ? folder : relativeForm
}
