import type { DatasetMeta } from '@shared/types'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { lerobotHome } from './fs-paths'

/**
 * `lerobot-replay` addresses a dataset by `--dataset.repo_id` plus an optional
 * `--dataset.root`, never by file path. The Replay panel lets the user browse to
 * a dataset directory, so we read `meta/info.json` for fps/episode count and
 * infer a repo_id from the path.
 *
 * info.json fields per datasets/feature_utils.py:94-108.
 */
interface RawInfo {
  codebase_version?: string
  robot_type?: string | null
  total_episodes?: number
  total_frames?: number
  fps?: number
  splits?: Record<string, string>
}

export function isDatasetRoot(dir: string): boolean {
  return existsSync(join(dir, 'meta', 'info.json'))
}

/**
 * LeRobot's local layout is `<root>/<owner>/<name>`, so the trailing two path
 * segments are the repo_id. If the user picked a directory that is not nested
 * that way, fall back to the folder name alone — `lerobot-replay` accepts any
 * repo_id as long as `--dataset.root` points at the data.
 */
export function inferRepoId(root: string): string {
  const cleaned = root.replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '')
  const parts = cleaned.split(sep).filter(Boolean)
  if (parts.length >= 2) {
    const [owner, name] = [parts[parts.length - 2], parts[parts.length - 1]]
    // Only treat it as owner/name when it really looks like a repo pair.
    if (owner && name && !owner.includes('.')) return `${owner}/${name}`
  }
  return basename(cleaned)
}

export function readDatasetMeta(root: string): DatasetMeta {
  const infoPath = join(root, 'meta', 'info.json')
  const base: DatasetMeta = {
    root,
    repoId: inferRepoId(root),
    fps: null,
    totalEpisodes: null,
    totalFrames: null,
    robotType: null,
    episodes: []
  }

  if (!existsSync(infoPath)) {
    return {
      ...base,
      warning: `No meta/info.json in ${root}. Pick the dataset's root folder (the one containing meta/ and data/).`
    }
  }

  let info: RawInfo
  try {
    info = JSON.parse(readFileSync(infoPath, 'utf8')) as RawInfo
  } catch (err) {
    return { ...base, warning: `meta/info.json could not be parsed: ${String(err)}` }
  }

  const total = typeof info.total_episodes === 'number' ? info.total_episodes : null
  const episodes = total && total > 0 ? Array.from({ length: total }, (_, i) => i) : []

  return {
    ...base,
    fps: typeof info.fps === 'number' ? info.fps : null,
    totalEpisodes: total,
    totalFrames: typeof info.total_frames === 'number' ? info.total_frames : null,
    robotType: info.robot_type ?? null,
    episodes,
    warning:
      total === 0
        ? 'This dataset has no episodes recorded yet.'
        : total === null
          ? 'meta/info.json has no total_episodes field.'
          : undefined
  }
}

/**
 * Datasets already on this machine, so Replay does not force a file dialog.
 * Scans `$HF_LEROBOT_HOME/<owner>/<name>` plus any extra roots the user set.
 */
export function discoverLocalDatasets(extraRoots: string[] = []): DatasetMeta[] {
  const roots = [lerobotHome(), ...extraRoots].filter((r) => r && existsSync(r))
  const found: DatasetMeta[] = []
  const seen = new Set<string>()

  const consider = (dir: string): void => {
    if (seen.has(dir) || !isDatasetRoot(dir)) return
    seen.add(dir)
    found.push(readDatasetMeta(dir))
  }

  for (const root of roots) {
    // A root may itself be a dataset, hold datasets, or hold owner dirs.
    consider(root)
    for (const level1 of safeDirs(root)) {
      consider(level1)
      for (const level2 of safeDirs(level1)) consider(level2)
    }
  }

  return found.sort((a, b) => a.repoId.localeCompare(b.repoId))
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name !== 'hub')
      .map((name) => join(dir, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}
