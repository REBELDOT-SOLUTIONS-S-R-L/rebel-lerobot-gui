import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run a short-lived command and collect its output.
 *
 * For anything long-running or interactive use the pty-backed ProcessRunner
 * instead — this is for probes (`python -V`, `pip list --format=json`).
 */
export function execCapture(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...opts.env },
      windowsHide: true
    })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += `\n[timed out after ${opts.timeoutMs ?? 15000}ms]`
      finish(null)
    }, opts.timeoutMs ?? 15000)

    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** True when `name` resolves on PATH. */
export async function onPath(name: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const res = await execCapture(probe, [name], { timeoutMs: 5000 })
  if (res.code !== 0) return null
  const first = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
  return first?.trim() ?? null
}
