import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Minimal atomic JSON store under the app's userData dir.
 *
 * Deliberately hand-rolled: electron-store's current major is ESM-only, which
 * fights electron-vite's CJS main bundle for ~40 lines of behaviour we need.
 */
export class JsonStore<T extends object> {
  private readonly file: string
  private data: T

  constructor(name: string, private readonly defaults: T) {
    this.file = join(app.getPath('userData'), `${name}.json`)
    this.data = this.load()
  }

  private load(): T {
    try {
      if (!existsSync(this.file)) return structuredClone(this.defaults)
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<T>
      return { ...structuredClone(this.defaults), ...parsed }
    } catch (err) {
      console.error(`[store:${this.file}] unreadable, falling back to defaults:`, err)
      return structuredClone(this.defaults)
    }
  }

  get(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch }
    this.flush()
    return this.data
  }

  replace(next: T): T {
    this.data = next
    this.flush()
    return this.data
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
