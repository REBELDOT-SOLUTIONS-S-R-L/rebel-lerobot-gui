import type { CommandSpec, PromptInfo, RunInfo, RunKind, RunStatus } from '@shared/types'
import { EventEmitter } from 'node:events'
import { isWindows } from '../fs-paths'
import { detectPrompt, stripAnsi } from './prompts'

/**
 * node-pty is a native module. If the electron rebuild did not happen we still
 * want the app to start, so fall back to plain pipes and simply disable the
 * features that need a tty (record's arrow-key episode controls).
 */
interface PtyLike {
  pid: number
  write(data: string): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  resize?(cols: number, rows: number): void
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; name?: string }
  ) => PtyLike
}

let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

function loadPty(): PtyModule | null {
  if (ptyModule || ptyLoadError) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    console.error('[runner] node-pty unavailable, falling back to pipes:', ptyLoadError)
  }
  return ptyModule
}

export function ptyAvailable(): boolean {
  return loadPty() !== null
}

export function ptyError(): string | null {
  loadPty()
  return ptyLoadError
}

interface Run {
  info: RunInfo
  child: PtyLike | null
  pipeChild: import('node:child_process').ChildProcess | null
  /** Rolling ANSI-stripped tail, used for prompt detection. */
  tail: string
  /** Full stripped log, for "copy output". */
  log: string
  answeredPrompts: Set<string>
}

export interface RunnerEvents {
  output: (payload: { runId: string; data: string }) => void
  status: (info: RunInfo) => void
}

const TAIL_LIMIT = 4000
const LOG_LIMIT = 400_000

export class ProcessRunner extends EventEmitter {
  private runs = new Map<string, Run>()
  private seq = 0

  list(): RunInfo[] {
    return [...this.runs.values()].map((r) => r.info)
  }

  get(runId: string): RunInfo | null {
    return this.runs.get(runId)?.info ?? null
  }

  logOf(runId: string): string {
    return this.runs.get(runId)?.log ?? ''
  }

  /**
   * Start a command. Long-running lerobot scripts get a pty because they print
   * ANSI live tables, block on bare `input()`, and — for `lerobot-record` —
   * read episode-control keystrokes straight from the terminal.
   */
  start(kind: RunKind, command: CommandSpec): RunInfo {
    const runId = `run-${++this.seq}-${Date.now().toString(36)}`
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Without this, prompts printed with no trailing newline sit in Python's
      // stdout buffer and prompt detection deadlocks.
      PYTHONUNBUFFERED: '1',
      // Keep lerobot's own colour output modest inside our log pane.
      FORCE_COLOR: '1',
      ...command.env
    }
    // Setting LEROBOT_HOME at all makes lerobot raise on import
    // (utils/constants.py:59-64), so make sure we never inherit it.
    delete env.LEROBOT_HOME

    const info: RunInfo = {
      runId,
      kind,
      command: command.display,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      prompt: null,
      canPause: !isWindows
    }

    const run: Run = {
      info,
      child: null,
      pipeChild: null,
      tail: '',
      log: '',
      answeredPrompts: new Set()
    }
    this.runs.set(runId, run)

    const pty = loadPty()
    try {
      if (pty) {
        const child = pty.spawn(command.file, command.args, {
          cwd: command.cwd,
          env,
          cols: 120,
          rows: 34,
          name: 'xterm-256color'
        })
        run.child = child
        child.onData((data) => this.ingest(run, data))
        child.onExit(({ exitCode, signal }) => {
          this.finish(run, exitCode, signal ? `signal ${signal}` : null)
        })
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { spawn } = require('node:child_process') as typeof import('node:child_process')
        const child = spawn(command.file, command.args, {
          cwd: command.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        run.pipeChild = child
        child.stdout?.on('data', (d) => this.ingest(run, String(d)))
        child.stderr?.on('data', (d) => this.ingest(run, String(d)))
        child.on('error', (err) => {
          this.ingest(run, `\r\n[failed to start: ${err.message}]\r\n`)
          this.finish(run, null, err.message)
        })
        child.on('close', (code) => this.finish(run, code ?? null, null))
      }
      this.setStatus(run, 'running')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.ingest(run, `\r\n[failed to start: ${message}]\r\n`)
      this.finish(run, null, message)
    }

    return run.info
  }

  private ingest(run: Run, data: string): void {
    this.emit('output', { runId: run.info.runId, data })

    const clean = stripAnsi(data)
    run.log = (run.log + clean).slice(-LOG_LIMIT)
    run.tail = (run.tail + clean).slice(-TAIL_LIMIT)

    if (run.info.status !== 'running') return

    const prompt = detectPrompt(run.info.kind, run.tail)
    if (prompt && !run.answeredPrompts.has(prompt.raw)) {
      if (run.info.prompt?.raw !== prompt.raw) {
        run.info = { ...run.info, prompt }
        this.emit('status', run.info)
      }
    }
  }

  /** Answer an interactive prompt by writing to the child's stdin. */
  respond(runId: string, send: string): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    if (run.info.prompt) {
      run.answeredPrompts.add(run.info.prompt.raw)
      // Clear the tail so the same prompt text cannot re-trigger.
      run.tail = ''
      run.info = { ...run.info, prompt: null }
      this.emit('status', run.info)
    }
    return this.write(runId, send)
  }

  /** Raw keystroke passthrough — this is what makes record's -> / <- / ESC work. */
  write(runId: string, data: string): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    try {
      if (run.child) run.child.write(data)
      else if (run.pipeChild?.stdin?.writable) run.pipeChild.stdin.write(data)
      else return false
      return true
    } catch (err) {
      console.error(`[runner] write to ${runId} failed:`, err)
      return false
    }
  }

  resize(runId: string, cols: number, rows: number): void {
    const run = this.runs.get(runId)
    run?.child?.resize?.(Math.max(20, cols), Math.max(5, rows))
  }

  /**
   * Stop with SIGINT, never SIGKILL: teleoperate and record catch
   * KeyboardInterrupt and only then disconnect the motors and finalize the
   * dataset. A hard kill leaves motors torqued and datasets unfinalized.
   */
  stop(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    // Resume first — a stopped process cannot handle SIGINT.
    if (run.info.status === 'paused') this.resume(runId)
    try {
      if (run.child) run.child.kill('SIGINT')
      else if (run.pipeChild) run.pipeChild.kill('SIGINT')
      return true
    } catch (err) {
      console.error(`[runner] stop ${runId} failed:`, err)
      return false
    }
  }

  /** Last resort, offered in the UI only after a stop has not taken effect. */
  kill(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    try {
      if (run.info.status === 'paused') this.resume(runId)
      if (run.child) run.child.kill('SIGKILL')
      else if (run.pipeChild) run.pipeChild.kill('SIGKILL')
      return true
    } catch {
      return false
    }
  }

  /**
   * True pause via SIGSTOP. Windows has no equivalent, so the UI disables the
   * button there rather than pretending.
   */
  pause(runId: string): boolean {
    if (isWindows) return false
    const run = this.runs.get(runId)
    if (!run || run.info.status !== 'running') return false
    const pid = run.child?.pid ?? run.pipeChild?.pid
    if (!pid) return false
    try {
      process.kill(pid, 'SIGSTOP')
      this.setStatus(run, 'paused')
      return true
    } catch (err) {
      console.error(`[runner] pause ${runId} failed:`, err)
      return false
    }
  }

  resume(runId: string): boolean {
    if (isWindows) return false
    const run = this.runs.get(runId)
    if (!run || run.info.status !== 'paused') return false
    const pid = run.child?.pid ?? run.pipeChild?.pid
    if (!pid) return false
    try {
      process.kill(pid, 'SIGCONT')
      this.setStatus(run, 'running')
      return true
    } catch (err) {
      console.error(`[runner] resume ${runId} failed:`, err)
      return false
    }
  }

  /** SIGINT everything still alive — called on app quit. */
  stopAll(): void {
    for (const runId of this.runs.keys()) {
      const status = this.runs.get(runId)?.info.status
      if (status === 'running' || status === 'paused' || status === 'starting') this.stop(runId)
    }
  }

  clearFinished(): void {
    for (const [runId, run] of this.runs) {
      if (run.info.status === 'exited' || run.info.status === 'failed') this.runs.delete(runId)
    }
  }

  private setStatus(run: Run, status: RunStatus, prompt?: PromptInfo | null): void {
    run.info = { ...run.info, status, ...(prompt !== undefined ? { prompt } : {}) }
    this.emit('status', run.info)
  }

  private finish(run: Run, code: number | null, note: string | null): void {
    if (run.info.status === 'exited' || run.info.status === 'failed') return
    if (note) this.ingest(run, `\r\n[${note}]\r\n`)
    run.info = {
      ...run.info,
      status: code === 0 ? 'exited' : 'failed',
      exitCode: code,
      endedAt: Date.now(),
      prompt: null
    }
    this.emit('status', run.info)
  }
}

export const runner = new ProcessRunner()
