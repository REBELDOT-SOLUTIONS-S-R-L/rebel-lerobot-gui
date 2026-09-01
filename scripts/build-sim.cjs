#!/usr/bin/env node
/**
 * Rebuild the 3D scenes the "3D View" panel renders.
 *
 *   npm run build:sim              # both models
 *   npm run build:sim -- --model SO101
 *
 * The work is done by `tools/blender/build_sim_scene.py` inside Blender; this
 * only finds Blender and hands the arguments over. The outputs are committed, so
 * developers and users never need Blender — only whoever changes the scene does.
 *
 * Set BLENDER to point at a specific binary if the search below misses yours.
 */
const { spawnSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const REPO = resolve(__dirname, '..')
const SCRIPT = join(REPO, 'tools', 'blender', 'build_sim_scene.py')

/** Where each platform's installer puts Blender, newest first. */
function candidates() {
  if (process.env.BLENDER) return [process.env.BLENDER]
  if (process.platform === 'darwin') {
    return ['/Applications/Blender.app/Contents/MacOS/Blender', 'blender']
  }
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)
    const installs = []
    for (const root of roots) {
      const base = join(root, 'Blender Foundation')
      if (!existsSync(base)) continue
      for (const dir of readdirSync(base).sort().reverse()) {
        installs.push(join(base, dir, 'blender.exe'))
      }
    }
    return [...installs, 'blender.exe', 'blender']
  }
  return ['blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']
}

function findBlender() {
  for (const candidate of candidates()) {
    // A bare name has to be resolved through PATH, which `--version` does for us.
    const isPath = candidate.includes('/') || candidate.includes('\\')
    if (isPath && !existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return { path: candidate, version: (probe.stdout || '').split('\n')[0].trim() }
  }
  return null
}

const blender = findBlender()
if (!blender) {
  console.error(
    'Could not find Blender.\n' +
      'Install it from https://www.blender.org/download/, or set BLENDER to its executable:\n' +
      '  BLENDER=/path/to/blender npm run build:sim'
  )
  process.exit(1)
}

console.log(`Using ${blender.version} (${blender.path})`)
const args = ['--background', '--python', SCRIPT, '--', '--repo', REPO, ...process.argv.slice(2)]
const run = spawnSync(blender.path, args, { stdio: 'inherit', cwd: REPO })
process.exit(run.status ?? 1)
