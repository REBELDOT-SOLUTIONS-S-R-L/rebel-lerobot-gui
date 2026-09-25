import type { Demo, DemoDraft } from '@shared/demos'
import { validateDemo } from '@shared/demos'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { JsonStore } from './json-store'

/**
 * Demo storage: the demos themselves, their thumbnails and their script files.
 *
 * All three live under the app's userData directory, next to `profiles.json`.
 * Thumbnails are copied in rather than referenced where they were picked, so a
 * demo keeps its card image after the original is moved, renamed or deleted.
 */

let demosStore: JsonStore<{ demos: Demo[] }> | null = null

/** Lazily constructed: `app.getPath('userData')` is only valid after `ready`. */
function store(): JsonStore<{ demos: Demo[] }> {
  demosStore ??= new JsonStore<{ demos: Demo[] }>('demos', { demos: [] })
  return demosStore
}

export function listDemos(): Demo[] {
  return store().get().demos
}

export function getDemo(uid: string): Demo | null {
  return listDemos().find((d) => d.uid === uid) ?? null
}

export function upsertDemo(draft: DemoDraft): Demo[] {
  const existing = listDemos()
  const reason = validateDemo(draft, existing)
  if (reason) throw new Error(reason)

  const now = Date.now()
  const list = [...existing]
  const idx = list.findIndex((d) => d.uid === draft.uid)
  const demo: Demo = {
    ...draft,
    name: draft.name.trim(),
    createdAt: idx >= 0 ? list[idx].createdAt : now,
    updatedAt: now
  }
  if (idx >= 0) list[idx] = demo
  else list.push(demo)
  store().replace({ demos: list })
  return list
}

/**
 * Delete a demo and everything the app generated for it.
 *
 * The thumbnail is the app's own copy and the script file is regenerated on
 * every start, so both go with the demo — leaving them would accumulate files
 * nothing can reach.
 */
export function deleteDemo(uid: string): Demo[] {
  const demo = getDemo(uid)
  if (demo?.thumbnail) removeThumbnail(demo.thumbnail)
  discardScript(uid)
  const list = listDemos().filter((d) => d.uid !== uid)
  store().replace({ demos: list })
  return list
}

/* ------------------------------------------------------------------ *
 * Thumbnails                                                          *
 * ------------------------------------------------------------------ */

export function thumbnailsDir(): string {
  return join(app.getPath('userData'), 'demo-thumbnails')
}

/**
 * Copy a chosen image in and return the filename to store on the demo.
 *
 * The name is derived from the demo's uid plus a timestamp rather than the
 * source filename: it keeps the name free of anything the `thumb://` handler
 * would have to sanitise, and the timestamp means replacing a thumbnail writes a
 * new file, so the renderer's `<img>` cache cannot keep showing the old one.
 */
export function saveThumbnail(uid: string, sourcePath: string): string {
  if (!existsSync(sourcePath)) throw new Error(`No such image: ${sourcePath}`)
  const dir = thumbnailsDir()
  mkdirSync(dir, { recursive: true })

  const ext = extname(sourcePath).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png'
  const name = `${uid}-${Date.now().toString(36)}${ext}`
  copyFileSync(sourcePath, join(dir, name))

  // Drop any earlier image for this demo; only the newest is ever referenced.
  for (const file of safeReaddir(dir)) {
    if (file !== name && file.startsWith(`${uid}-`)) rmSync(join(dir, file), { force: true })
  }
  return name
}

export function removeThumbnail(name: string): void {
  // Guard the join: `name` reaches here from the renderer, and a demo record is
  // editable JSON on disk.
  if (!isSafeName(name)) return
  rmSync(join(thumbnailsDir(), name), { force: true })
}

/** A thumbnail filename is only ever one the app generated, so keep it narrow. */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..')
}

/* ------------------------------------------------------------------ *
 * Script files                                                        *
 * ------------------------------------------------------------------ */

export function scriptsDir(): string {
  return join(app.getPath('userData'), 'demo-scripts')
}

/**
 * Write a demo's script out ready to be spawned, and return its path.
 *
 * Rewritten on every start so an edited demo never runs its previous script,
 * and kept afterwards so a failing demo can be opened and read.
 */
export function writeScript(uid: string, contents: string, extension: string): string {
  const dir = scriptsDir()
  mkdirSync(dir, { recursive: true })
  // Clear the other extension: switching OS (or a shell that changed under the
  // user) would otherwise leave a stale sibling next to the real script.
  for (const file of safeReaddir(dir)) {
    if (file.startsWith(`${uid}.`) && file !== `${uid}.${extension}`) {
      rmSync(join(dir, file), { force: true })
    }
  }
  const path = join(dir, `${uid}.${extension}`)
  // 0o700: the script carries whatever the user put in it, and it sits in a
  // per-user directory. No reason for anyone else on the machine to read it.
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o700 })
  return path
}

function discardScript(uid: string): void {
  const dir = scriptsDir()
  for (const file of safeReaddir(dir)) {
    if (file.startsWith(`${uid}.`)) rmSync(join(dir, file), { force: true })
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
