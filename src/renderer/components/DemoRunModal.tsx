import type { Demo } from '@shared/demos'
import { deviceLabels, missingDeviceUids } from '@shared/demos'
import type { DeviceProfile, RunInfo } from '@shared/types'
import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { ConsolePane } from './ConsolePane'
import { Badge, Button, Modal, Notice, Spinner } from './ui'

/**
 * Run one demo: status, transport, and the script's output.
 *
 * The console is the point of this dialog — a demo is someone else's script, so
 * when it misbehaves the output is the only thing that explains why. It is a
 * full terminal rather than a log list, so a script that prompts can still be
 * answered by typing into it.
 */
export function DemoRunModal({
  demo,
  devices,
  run,
  onStart,
  onEdit,
  onClose
}: {
  demo: Demo
  devices: readonly DeviceProfile[]
  /** This demo's run, or null when it has not been started this session. */
  run: RunInfo | null
  onStart: () => Promise<string | null>
  onEdit: () => void
  onClose: () => void
}): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const status = run?.status ?? null
  const running = status === 'running' || status === 'starting'
  const paused = status === 'paused'
  const active = running || paused
  const missing = missingDeviceUids(demo, devices)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(await onStart())
    setBusy(false)
  }

  const stop = async (): Promise<void> => {
    if (!run) return
    setBusy(true)
    await api.runs.stop(run.runId)
    setBusy(false)
  }

  /**
   * Stop, then start once the child has actually gone.
   *
   * The runner stops with SIGINT and the script may take a moment to unwind, so
   * this waits for the status to settle rather than starting straight away —
   * `demos:start` refuses a second instance while the first is alive, and
   * without the wait a restart would usually hit exactly that.
   */
  const restart = async (): Promise<void> => {
    if (!run) return
    setBusy(true)
    await api.runs.stop(run.runId)
    const gone = await waitForExit(run.runId)
    if (!gone) {
      setError('The demo is still shutting down. Give it a moment, then start it again.')
      setBusy(false)
      return
    }
    setError(await onStart())
    setBusy(false)
  }

  return (
    <Modal
      title={demo.name}
      subtitle={demo.description || undefined}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          {active ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void restart()}>
                {busy ? <Spinner /> : 'Restart'}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void stop()}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void start()}>
              {busy ? <Spinner /> : run ? 'Start again' : 'Start'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge run={run} />
          <span className="font-mono text-[11px] text-ink-600">
            {deviceLabels(demo, devices).join(' · ') || 'no devices'}
          </span>
        </div>

        {missing.length > 0 && (
          <Notice tone="warn">
            {missing.length} of this demo&rsquo;s devices no longer exist, so their DEMO_* variables
            will not be set. Edit the demo to pick the profiles again.
          </Notice>
        )}

        {/* Closing the dialog does not stop the demo — worth saying, since the
            console disappearing looks a lot like the script being killed. */}
        {active && (
          <p className="text-xs text-ink-600">
            Closing this window leaves the demo running; the card keeps its status.
          </p>
        )}

        <ConsolePane run={run} heightClass="h-80" />

        {run && !active && run.exitCode !== null && run.exitCode !== 0 && (
          <Notice tone="error">
            The script exited with code {run.exitCode}. The output above is the whole run.
          </Notice>
        )}

        {error && (
          <Notice tone="error" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}

function StatusBadge({ run }: { run: RunInfo | null }): ReactNode {
  if (!run) return <Badge>not started</Badge>
  switch (run.status) {
    case 'starting':
    case 'running':
      return (
        <Badge tone="live">
          <Spinner className="h-2.5 w-2.5" />
          running
        </Badge>
      )
    case 'paused':
      return <Badge tone="warn">suspended</Badge>
    case 'failed':
      return <Badge tone="error">failed{run.exitCode !== null ? ` (${run.exitCode})` : ''}</Badge>
    default:
      return <Badge>stopped</Badge>
  }
}

/**
 * Wait for a run to leave the running state, up to a few seconds.
 *
 * Polled rather than driven by the status event because this is a one-shot
 * question asked inside an async handler; the store's subscription still updates
 * the rest of the UI.
 */
async function waitForExit(runId: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const res = await api.runs.get(runId)
    const status = res.ok ? res.value?.status : null
    if (!status || status === 'exited' || status === 'failed') return true
  }
  return false
}
