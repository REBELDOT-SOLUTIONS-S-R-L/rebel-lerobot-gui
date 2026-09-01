import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
