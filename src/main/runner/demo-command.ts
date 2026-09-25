import type { Demo } from '@shared/demos'
import { demoEnv } from '@shared/demos'
import type { CommandSpec, DeviceProfile } from '@shared/types'
import { existsSync } from 'node:fs'
import { VENV_BIN, isWindows } from '../fs-paths'
import { join } from 'node:path'

/**
 * Turn a demo's script into something the runner can spawn.
 *
 * The script is written to a file and handed to the OS's own shell rather than
 * being executed inline: `-c` has a length limit, it mangles quoting, and a real
 * file is what makes a multi-line script with functions and heredocs behave the
 * way it does when the user runs it by hand. It also means a failing demo can be
 * opened and read.
 *
 * Nothing is ever passed through a shell *by the app* — argv is always an array,
 * and the only shell involved is the one the user's own script asked for.
 */

/** Shell chosen for a demo, and how its script file has to be named. */
export interface DemoShell {
  file: string
  /** Args that come before the script path. */
  leadingArgs: string[]
  /** Extension the script file needs, so the shell recognises it. */
  extension: string
  /** What to call it in the UI. */
  label: string
}

/**
 * The shell a demo script runs in.
 *
 * POSIX follows `$SHELL` — the user's login shell is what they wrote the script
 * against, and on macOS that is zsh while `/bin/bash` is a decade-old 3.2. It
 * falls back through bash to sh, which POSIX guarantees exists.
 *
 * Windows uses PowerShell, which every supported release ships, and which is
 * what "the default shell" now means there. `-NoProfile` keeps a user's profile
 * from changing how a demo behaves, and `-ExecutionPolicy Bypass` is required
 * because the default policy refuses to run an unsigned local .ps1 at all.
 */
export function demoShell(): DemoShell {
  if (isWindows) {
    return {
      file: 'powershell.exe',
      leadingArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
      extension: 'ps1',
      label: 'PowerShell'
    }
  }
  const login = process.env.SHELL
  const file = login && existsSync(login) ? login : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return {
    file,
    leadingArgs: [],
    extension: 'sh',
    label: file.split('/').pop() || 'sh'
  }
}

/**
 * Build the spawn spec for a demo whose script has already been written out.
 *
 * `cwd` is the script's own directory so a demo can keep data files beside
 * itself and reach them with a relative path.
 */
export function buildDemoCommand(opts: {
  demo: Demo
  devices: readonly DeviceProfile[]
  /** Where the script was written. */
  scriptPath: string
  /** Configured venv, so the demo gets `lerobot-*` on PATH. Null when unset. */
  venvPath: string | null
  shell?: DemoShell
}): CommandSpec {
  const { demo, devices, scriptPath, venvPath } = opts
  const shell = opts.shell ?? demoShell()

  return {
    file: shell.file,
    args: [...shell.leadingArgs, scriptPath],
    cwd: dirOf(scriptPath),
    env: {
      ...demoEnv(demo, devices),
      ...venvEnv(venvPath)
    },
    // The script path is noise in the footer; the demo's name is what the user
    // started. The real argv is still what gets spawned.
    display: `${shell.label} — ${demo.name}`
  }
}

/**
 * Put the venv's scripts first on PATH.
 *
 * This is what `activate` does that matters to a script: `lerobot-teleoperate`
 * and friends resolve without the demo knowing where the venv lives.
 * VIRTUAL_ENV is set alongside it because prompts and some tools read it, and
 * it is what an activated shell looks like.
 *
 * PATH's case differs on Windows (`Path`), so the existing value is found
 * case-insensitively — writing a fresh `PATH` key there would shadow nothing and
 * the venv would silently not apply.
 */
function venvEnv(venvPath: string | null): Record<string, string> {
  if (!venvPath) return {}
  const bin = join(venvPath, VENV_BIN)
  if (!existsSync(bin)) return {}
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = process.env[key] ?? ''
  return {
    VIRTUAL_ENV: venvPath,
    [key]: current ? `${bin}${isWindows ? ';' : ':'}${current}` : bin
  }
}

function dirOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut > 0 ? file.slice(0, cut) : file
}

/**
 * Prologue that makes a shell script fail loudly.
 *
 * Without it a demo whose first command fails runs on to the end and exits 0,
 * which the panel would report as a successful demo. The user's script follows
 * unmodified.
 */
export function scriptPrologue(shell: DemoShell): string {
  if (shell.extension === 'ps1') {
    return ['# Added by LeRobot Control: stop on the first failure.', '$ErrorActionPreference = "Stop"', ''].join('\n')
  }
  return ['# Added by LeRobot Control: stop on the first failure.', 'set -e', ''].join('\n')
}
