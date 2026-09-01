import type { RunInfo } from '@shared/types'
import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { Button, Notice } from './ui'

/**
 * Start / Pause / Stop for a long-running lerobot process.
 *
 * Stop sends SIGINT rather than killing: teleoperate and record catch
 * KeyboardInterrupt and only then disconnect the motors and finalize the
 * dataset. Pause is SIGSTOP/SIGCONT, which Windows has no equivalent for, so the
 * button is disabled there with an explanation instead of silently doing nothing.
 */
export function TransportBar({
  run,
  onStart,
  startLabel = 'Start',
  disabled,
  disabledReason,
  children
}: {
  run: RunInfo | null
  onStart: () => Promise<void> | void
  startLabel?: string
  disabled?: boolean
  disabledReason?: string | null
  children?: ReactNode
}): ReactNode {
  const canPause = useAppStore((s) => s.appInfo?.canPause ?? false)
  const [busy, setBusy] = useState(false)
  const [showKill, setShowKill] = useState(false)

  const active = run?.status === 'running' || run?.status === 'paused' || run?.status === 'starting'

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!active ? (
          <Button
            variant="live"
            disabled={busy || disabled}
            onClick={() =>
              void act(async () => {
                setShowKill(false)
                await onStart()
              })
            }
          >
            {startLabel}
          </Button>
        ) : (
          <>
            {run?.status === 'paused' ? (
              <Button
                variant="live"
                disabled={busy || !canPause}
                onClick={() => void act(() => api.runs.resume(run.runId))}
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={busy || !canPause || run?.status !== 'running'}
                title={
                  canPause
                    ? 'Suspend the process (SIGSTOP)'
                    : 'Pause is not available on Windows — use Stop instead.'
                }
                onClick={() => void act(() => api.runs.pause(run!.runId))}
              >
                Pause
              </Button>
            )}
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.runs.stop(run!.runId)
                  // Offer the hard kill only once a graceful stop has been tried.
                  setTimeout(() => setShowKill(true), 4000)
                })
              }
            >
              Stop
            </Button>
            {showKill && (
              <Button
                variant="ghost"
                disabled={busy}
                title="Sends SIGKILL. Motors may stay torqued and a recording will not be finalized."
                onClick={() => void act(() => api.runs.kill(run!.runId))}
              >
                Force quit
              </Button>
            )}
          </>
        )}
        {children}
      </div>

      {!active && disabled && disabledReason && <Notice tone="warn">{disabledReason}</Notice>}

      {run?.prompt && (
        <Notice tone="info" title={run.prompt.title}>
          <p>{run.prompt.detail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {run.prompt.choices.map((choice) => (
              <Button
                key={choice.label}
                size="sm"
                variant={choice.primary ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => void act(() => api.runs.respond(run.runId, choice.send))}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </Notice>
      )}

      {run?.status === 'failed' && !run.prompt && (
        <Notice tone="error" title={`Exited with code ${run.exitCode ?? 'unknown'}`}>
          Check the output below for the reason.
        </Notice>
      )}
    </div>
  )
}
