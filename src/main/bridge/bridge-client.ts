import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { bridgeScript, venvPython } from '../paths'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * Owns the Python sidecar that talks to the motors.
 *
 * Only the Configure panel's live features need this; every real LeRobot
 * workflow goes through the console scripts instead. Keeping the two channels
 * separate means a lerobot API change can break live telemetry without breaking
 * calibrate/teleop/record.
 */
export class BridgeClient extends EventEmitter {
  private child: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private buffer = ''
  private seq = 0
  private currentVenv: string | null = null
  private starting: Promise<void> | null = null

  get running(): boolean {
    return this.child !== null && !this.child.killed
  }

  get venvPath(): string | null {
    return this.currentVenv
  }

  /** Start (or restart, if the venv changed) the sidecar. */
  async ensure(venvPath: string): Promise<void> {
    if (this.running && this.currentVenv === venvPath) return
    if (this.starting) {
      await this.starting
      if (this.running && this.currentVenv === venvPath) return
    }
    this.starting = this.startInternal(venvPath).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(venvPath: string): Promise<void> {
    this.stop()

    const python = venvPython(venvPath)
    const script = bridgeScript()
    if (!existsSync(python)) {
      throw new BridgeError(`No Python interpreter at ${python}. Configure the environment in Settings.`)
    }
    if (!existsSync(script)) {
      throw new BridgeError(`Bridge script missing at ${script}. The install may be incomplete.`)
    }

    const env = { ...process.env, PYTHONUNBUFFERED: '1' } as Record<string, string>
    delete env.LEROBOT_HOME

    const child = spawn(python, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.currentVenv = venvPath
    this.buffer = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // The sidecar logs to stderr on purpose so stdout stays a clean channel.
      this.emit('log', chunk)
    })
    child.on('error', (err) => this.onDeath(`bridge failed to start: ${err.message}`))
    child.on('exit', (code, signal) =>
      this.onDeath(`bridge exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`)
    )

    // Confirm it can actually import and respond before we call it ready.
    await this.request('ping', {}, 30_000)
    this.emit('ready', { venvPath })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.emit('log', `[bridge] unparseable frame: ${line.slice(0, 400)}\n`)
        continue
      }
      if (frame.id === undefined || frame.id === null) {
        // Notification: positions, rom, streamError, ready.
        this.emit('notification', frame)
        continue
      }
      const pending = this.pending.get(Number(frame.id))
      if (!pending) continue
      this.pending.delete(Number(frame.id))
      clearTimeout(pending.timer)
      if (frame.ok === true) pending.resolve(frame.value)
      else
        pending.reject(
          new BridgeError(String(frame.error ?? 'Bridge call failed.'), frame.detail as string | undefined)
        )
    }
  }

  private onDeath(reason: string): void {
    const wasRunning = this.child !== null
    this.child = null
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new BridgeError(`${reason} (during ${pending.method})`))
    }
    this.pending.clear()
    if (wasRunning) this.emit('closed', { reason })
  }

  /** Send a request. Callers must have called `ensure()` first. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const child = this.child
    if (!child?.stdin?.writable) {
      return Promise.reject(new BridgeError('The motor bridge is not running. Check Settings.'))
    }
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`'${method}' timed out after ${timeoutMs}ms.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method
      })
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Best-effort tidy-up so motors are never left torqued on quit. */
  async shutdown(): Promise<void> {
    if (this.running) {
      try {
        await this.request('bus.close', {}, 5000)
      } catch {
        // Nothing useful to do — we are on the way out.
      }
    }
    this.stop()
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.end()
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
}

export const bridge = new BridgeClient()
