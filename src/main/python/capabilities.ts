import { pythonSupport } from '@shared/devices'
import type { LerobotCapabilities } from '@shared/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VENV_BIN, exeName, venvPython } from '../fs-paths'
import { execCapture } from './exec'

/** Console scripts LeRobot may ship, per `[project.scripts]` in its pyproject. */
const KNOWN_SCRIPTS = [
  'lerobot-calibrate',
  'lerobot-setup-motors',
  'lerobot-find-port',
  'lerobot-find-cameras',
  'lerobot-find-joint-limits',
  'lerobot-teleoperate',
  'lerobot-record',
  'lerobot-replay',
  'lerobot-rollout',
  'lerobot-eval',
  'lerobot-train',
  'lerobot-info',
  'lerobot-dataset-viz',
  'lerobot-edit-dataset',
  'lerobot-imgtransform-viz',
  'lerobot-setup-can'
]

/**
 * Probe run inside the venv. Reports what is importable and where LeRobot keeps
 * calibration, so the app adapts to the installed release instead of assuming
 * one. Notably: `lerobot-rollout` only exists in newer releases, and the
 * calibration subdirectory changed from `so101_follower` to `so_follower` when
 * the SO arms were consolidated (PR #2763).
 */
const PROBE = `
import json, sys, importlib
out = {
    "python": "%d.%d.%d" % sys.version_info[:3],
    "lerobotVersion": None,
    "modules": {},
    "calibrationRoot": None,
    "calibrationSegments": {"robot": None, "teleop": None},
}
def has(mod):
    try:
        importlib.import_module(mod)
        return True
    except Exception:
        return False

for name, mod in [
    ("pyserial", "serial"),
    ("opencv", "cv2"),
    ("rerun", "rerun"),
    ("feetech", "scservo_sdk"),
    ("torch", "torch"),
    ("draccus", "draccus"),
]:
    out["modules"][name] = has(mod)

try:
    import lerobot
    out["lerobotVersion"] = getattr(lerobot, "__version__", "unknown")
except Exception as exc:
    out["lerobotError"] = "%s: %s" % (type(exc).__name__, exc)

try:
    from lerobot.utils.constants import HF_LEROBOT_CALIBRATION, ROBOTS, TELEOPERATORS
    root = str(HF_LEROBOT_CALIBRATION)
    out["calibrationRoot"] = root
    from pathlib import Path
    for key, seg in (("robot", ROBOTS), ("teleop", TELEOPERATORS)):
        base = Path(root) / seg
        # Newer releases share one directory between SO-100 and SO-101.
        for candidate in ("so_follower", "so_leader", "so101_follower", "so101_leader"):
            if (base / candidate).is_dir():
                out["calibrationSegments"][key] = candidate
                break
except Exception:
    pass

try:
    from lerobot.robots import RobotConfig
    out["robotTypes"] = sorted(RobotConfig.get_known_choices())
except Exception:
    pass
try:
    from lerobot.teleoperators import TeleoperatorConfig
    out["teleopTypes"] = sorted(TeleoperatorConfig.get_known_choices())
except Exception:
    pass

print("<<<JSON>>>" + json.dumps(out))
`

interface ProbeOut {
  python: string
  lerobotVersion: string | null
  lerobotError?: string
  modules: Record<string, boolean>
  calibrationRoot: string | null
  calibrationSegments: { robot: string | null; teleop: string | null }
  robotTypes?: string[]
  teleopTypes?: string[]
}

export async function probeCapabilities(venvPath: string): Promise<LerobotCapabilities> {
  const base: LerobotCapabilities = {
    ok: false,
    venvPath,
    pythonVersion: '',
    lerobotVersion: null,
    scripts: [],
    hasRollout: false,
    hasReplay: false,
    hasCalibrate: false,
    hasSetupMotors: false,
    hasTeleoperate: false,
    hasRecord: false,
    hasPyserial: false,
    hasFeetech: false,
    hasOpencv: false,
    hasRerun: false,
    calibrationSegments: { robot: null, teleop: null },
    defaultCalibrationRoot: null,
    pythonSupported: true
  }

  const py = venvPython(venvPath)
  if (!existsSync(py)) {
    return { ...base, error: `No Python interpreter at ${py}. Is this a virtualenv root?` }
  }

  // Which console scripts actually landed in the env.
  const binDir = join(venvPath, VENV_BIN)
  const scripts = KNOWN_SCRIPTS.filter((s) => existsSync(join(binDir, exeName(s))))

  const res = await execCapture(py, ['-c', PROBE], { timeoutMs: 60000 })
  const marker = res.stdout.indexOf('<<<JSON>>>')
  if (marker < 0) {
    return {
      ...base,
      scripts,
      error:
        res.stderr.trim() ||
        res.stdout.trim() ||
        'The environment probe produced no output. Check that the venv is intact.'
    }
  }

  let parsed: ProbeOut
  try {
    parsed = JSON.parse(res.stdout.slice(marker + '<<<JSON>>>'.length)) as ProbeOut
  } catch (err) {
    return { ...base, scripts, error: `Could not parse the environment probe output: ${String(err)}` }
  }

  // An env on an out-of-window interpreter imports lerobot fine but cannot run a
  // single console script, so it is not "ok" no matter what is installed.
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(parsed.python)
  const support = m
    ? pythonSupport([Number(m[1]), Number(m[2]), Number(m[3])])
    : { supported: true, reason: null }

  const caps: LerobotCapabilities = {
    ...base,
    ok: parsed.lerobotVersion !== null && support.supported,
    error: parsed.lerobotError,
    pythonSupported: support.supported,
    pythonSupportReason: support.reason ?? undefined,
    pythonVersion: parsed.python,
    lerobotVersion: parsed.lerobotVersion,
    scripts,
    hasRollout: scripts.includes('lerobot-rollout'),
    hasReplay: scripts.includes('lerobot-replay'),
    hasCalibrate: scripts.includes('lerobot-calibrate'),
    hasSetupMotors: scripts.includes('lerobot-setup-motors'),
    hasTeleoperate: scripts.includes('lerobot-teleoperate'),
    hasRecord: scripts.includes('lerobot-record'),
    hasPyserial: !!parsed.modules.pyserial,
    hasFeetech: !!parsed.modules.feetech,
    hasOpencv: !!parsed.modules.opencv,
    hasRerun: !!parsed.modules.rerun,
    calibrationSegments: parsed.calibrationSegments ?? { robot: null, teleop: null },
    defaultCalibrationRoot: parsed.calibrationRoot
  }
  return caps
}

/** `pip list --format=json` inside the venv. */
export async function listPackages(venvPath: string): Promise<{ name: string; version: string }[]> {
  const py = venvPython(venvPath)
  const res = await execCapture(py, ['-m', 'pip', 'list', '--format=json'], { timeoutMs: 60000 })
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'pip list failed.')
  }
  const parsed = JSON.parse(res.stdout) as { name: string; version: string }[]
  return parsed.sort((a, b) => a.name.localeCompare(b.name))
}
