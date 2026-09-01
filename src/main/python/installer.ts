import type { CommandSpec } from '@shared/types'
import { displayOf } from '../runner/commands'
import { venvPython } from '../fs-paths'

/**
 * LeRobot's own extras map (src/lerobot/__init__.py:37-49):
 *   core_scripts = dataset + hardware + viz  -> record / replay / teleoperate
 *   hardware                                 -> calibrate / find-port / setup-motors
 *   feetech                                  -> the SDK the SO-100/SO-101 need
 * `core_scripts,feetech` is therefore the minimum for everything this app does.
 */
export const DEFAULT_EXTRAS = ['core_scripts', 'feetech']

export interface InstallRequest {
  venvPath: string
  /** Editable install from a lerobot checkout instead of PyPI. */
  sourcePath?: string | null
  extras?: string[]
  /** Force reinstall/upgrade of an already-present lerobot. */
  upgrade?: boolean
}

function spec(file: string, args: string[], cwd?: string): CommandSpec {
  return { file, args, cwd, display: displayOf(file, args) }
}

/**
 * Create a virtualenv.
 *
 * `uv venv` is used when available and preferred — it is what lerobot itself
 * locks with — otherwise plain `python -m venv`.
 */
export function buildCreateVenvCommand(opts: {
  pythonPath: string
  venvPath: string
  uvPath?: string | null
  preferUv?: boolean
}): CommandSpec {
  if (opts.preferUv && opts.uvPath) {
    // `--seed` puts pip in the new env: the install steps below shell out to
    // `python -m pip`, which a bare `uv venv` leaves out.
    return spec(opts.uvPath, ['venv', '--seed', '--python', opts.pythonPath, opts.venvPath])
  }
  return spec(opts.pythonPath, ['-m', 'venv', opts.venvPath])
}

/** Bring pip itself up to date first; old pip resolves lerobot's extras poorly. */
export function buildUpgradePipCommand(venvPath: string): CommandSpec {
  return spec(venvPython(venvPath), ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])
}

export function buildInstallLerobotCommand(req: InstallRequest): CommandSpec {
  const extras = (req.extras?.length ? req.extras : DEFAULT_EXTRAS).join(',')
  const python = venvPython(req.venvPath)
  const args = ['-m', 'pip', 'install']
  if (req.upgrade) args.push('--upgrade')

  if (req.sourcePath) {
    // Editable install from a checkout: `pip install -e ".[core_scripts,feetech]"`.
    args.push('-e', `.[${extras}]`)
    return spec(python, args, req.sourcePath)
  }
  args.push(`lerobot[${extras}]`)
  return spec(python, args)
}

/** Extra packages the bridge needs that are not implied by lerobot's extras. */
export function buildInstallBridgeDepsCommand(venvPath: string): CommandSpec {
  // pyserial and opencv come with `hardware` / the base install, but a bespoke
  // env may be missing them; installing explicitly is cheap and idempotent.
  return spec(venvPython(venvPath), ['-m', 'pip', 'install', 'pyserial', 'opencv-python-headless'])
}

export function buildPipListCommand(venvPath: string): CommandSpec {
  return spec(venvPython(venvPath), ['-m', 'pip', 'list'])
}
