import { pythonSupport } from '@shared/devices'
import type { PythonCandidate } from '@shared/types'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isWindows, venvPython } from '../fs-paths'
import { execCapture, onPath } from './exec'

const VERSION_PROBE = 'import sys;print("%d.%d.%d" % sys.version_info[:3])'

/**
 * Names to try on PATH, best first. 3.14 is probed last but still probed: it is
 * listed as unsupported with a reason, which beats leaving a user who only has
 * 3.14 staring at an empty list.
 */
const PATH_NAMES = ['python3.13', 'python3.12', 'python3.14', 'python3', 'python']

async function probe(path: string, source: string): Promise<PythonCandidate | null> {
  const res = await execCapture(path, ['-c', VERSION_PROBE], { timeoutMs: 8000 })
  if (res.code !== 0) return null
  const raw = res.stdout.trim().split(/\r?\n/).pop() ?? ''
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
  if (!m) return null
  const tuple: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const { supported, reason } = pythonSupport(tuple)
  return {
    path,
    version: raw,
    versionTuple: tuple,
    supported,
    unsupportedReason: reason ?? undefined,
    source,
    label: `Python ${raw} — ${source}`
  }
}

function envDirs(): { dir: string; source: string }[] {
  const home = homedir()
  return [
    { dir: join(home, 'miniforge3', 'envs'), source: 'conda (miniforge)' },
    { dir: join(home, 'miniconda3', 'envs'), source: 'conda (miniconda)' },
    { dir: join(home, 'anaconda3', 'envs'), source: 'conda (anaconda)' },
    { dir: join(home, '.conda', 'envs'), source: 'conda' },
    { dir: join(home, '.pyenv', 'versions'), source: 'pyenv' },
    { dir: join(home, '.virtualenvs'), source: 'virtualenv' }
  ]
}

/**
 * Enumerate usable interpreters.
 *
 * Anything outside LeRobot's version window is still listed but flagged
 * unsupported with a reason — silently hiding a user's only interpreter is more
 * confusing than explaining why it will not work.
 */
export async function discoverPythons(): Promise<PythonCandidate[]> {
  const found = new Map<string, PythonCandidate>()
  const add = (c: PythonCandidate | null): void => {
    if (c && !found.has(c.path)) found.set(c.path, c)
  }

  // 1. Plain names on PATH.
  const pathProbes = await Promise.all(
    PATH_NAMES.map(async (name) => {
      const resolved = await onPath(name)
      return resolved ? probe(resolved, 'PATH') : null
    })
  )
  pathProbes.forEach(add)

  // 2. Windows py launcher: `py -0p` lists installed interpreters with paths.
  if (isWindows) {
    const res = await execCapture('py', ['-0p'], { timeoutMs: 8000 })
    if (res.code === 0) {
      const paths = res.stdout
        .split(/\r?\n/)
        .map((line) => {
          const m = /([A-Za-z]:\\[^\s].*python\.exe)/i.exec(line)
          return m?.[1]
        })
        .filter((p): p is string => !!p)
      for (const p of paths) add(await probe(p, 'py launcher'))
    }
  }

  // 3. conda / pyenv / virtualenv directories.
  for (const { dir, source } of envDirs()) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const envRoot = join(dir, entry)
      const candidates = [venvPython(envRoot), join(envRoot, 'bin', 'python3')]
      for (const c of candidates) {
        if (existsSync(c)) {
          add(await probe(c, `${source}: ${entry}`))
          break
        }
      }
    }
  }

  // 4. uv-managed interpreters.
  const uv = await onPath('uv')
  if (uv) {
    const res = await execCapture(uv, ['python', 'list', '--output-format=json'], { timeoutMs: 10000 })
    if (res.code === 0) {
      try {
        const parsed = JSON.parse(res.stdout) as { path?: string | null }[]
        for (const entry of parsed) {
          if (entry.path && existsSync(entry.path)) add(await probe(entry.path, 'uv'))
        }
      } catch {
        // uv's JSON shape varies across versions; a failure here is not fatal.
      }
    }
  }

  const list = [...found.values()]
  list.sort((a, b) => {
    if (a.supported !== b.supported) return a.supported ? -1 : 1
    for (let i = 0; i < 3; i++) {
      if (a.versionTuple[i] !== b.versionTuple[i]) return b.versionTuple[i] - a.versionTuple[i]
    }
    return a.path.localeCompare(b.path)
  })
  return list
}

/** Probe one interpreter the user picked by hand. */
export async function inspectPython(path: string): Promise<PythonCandidate | null> {
  return probe(path, 'chosen manually')
}

/**
 * Detect an existing virtualenv/conda env from its root, so pointing the app at
 * a prepared `lerobot` env just works.
 */
export async function inspectVenv(venvPath: string): Promise<PythonCandidate | null> {
  const py = venvPython(venvPath)
  if (!existsSync(py)) return null
  return probe(py, `venv: ${basename(venvPath)}`)
}

export async function uvPath(): Promise<string | null> {
  return onPath('uv')
}
