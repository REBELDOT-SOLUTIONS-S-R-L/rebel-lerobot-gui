import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { RunInfo } from '@shared/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { useResolvedTheme, type ResolvedTheme } from '../lib/theme'
import { Badge, Button } from './ui'

/**
 * Terminal view for a run.
 *
 * A real terminal rather than a log list, because lerobot-teleoperate and
 * lerobot-record redraw live tables with ANSI cursor moves, and because
 * lerobot-record reads its episode controls (arrow keys / n, r, q) straight from
 * the terminal when no global key backend is available. Keystrokes typed here
 * are forwarded to the child.
 */
/**
 * xterm paints its own surface from a JS palette, so it cannot inherit the CSS
 * tokens — these mirror them. Both keep the same hues; the light set darkens the
 * foreground colours enough to read on a pale background.
 */
const TERMINAL_THEMES: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    background: '#0e0e0e',
    foreground: '#cfcfcf',
    cursor: '#ffd000',
    selectionBackground: 'rgba(255,208,0,0.28)',
    black: '#222222',
    brightBlack: '#595959',
    red: '#ff8090',
    green: '#46e0a8',
    yellow: '#ffd000',
    blue: '#7fb4ff',
    magenta: '#c9a2ff',
    cyan: '#61dafb',
    white: '#ffffff'
  },
  light: {
    background: '#ececec',
    foreground: '#414141',
    cursor: '#121212',
    selectionBackground: 'rgba(255,208,0,0.45)',
    black: '#121212',
    brightBlack: '#6b6b6b',
    red: '#c0293e',
    green: '#0a8f60',
    yellow: '#8a6a00',
    blue: '#1f5fb8',
    magenta: '#7b3fc4',
    cyan: '#0b7f96',
    white: '#414141'
  }
}

export function ConsolePane({
  run,
  className = '',
  heightClass = 'h-64'
}: {
  run: RunInfo | null
  className?: string
  heightClass?: string
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const runIdRef = useRef<string | null>(null)
  const [focused, setFocused] = useState(false)
  const theme = useResolvedTheme()
  // Read by the create-once effect, so a theme flip repaints instead of
  // rebuilding the terminal and losing its scrollback.
  const themeRef = useRef<ResolvedTheme>(theme)

  useEffect(() => {
    themeRef.current = theme
    const term = termRef.current
    if (term) term.options.theme = TERMINAL_THEMES[theme]
  }, [theme])

  // Create the terminal once and keep it for the pane's lifetime.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: false,
      convertEol: true,
      scrollback: 5000,
      theme: TERMINAL_THEMES[themeRef.current]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Forward keystrokes so record's episode controls work.
    const keyDisposable = term.onData((data) => {
      const runId = runIdRef.current
      if (runId) void api.runs.write(runId, data)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        const runId = runIdRef.current
        if (runId) void api.runs.resize(runId, term.cols, term.rows)
      } catch {
        // Fitting can throw while the pane is hidden; harmless.
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      keyDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Stream output for the selected run, replaying its backlog on switch.
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    runIdRef.current = run?.runId ?? null
    term.clear()
    term.reset()

    if (!run) {
      term.write('\u001B[38;5;242mNo run selected.\u001B[0m\r\n')
      return
    }

    let cancelled = false
    void api.runs.log(run.runId).then((res) => {
      if (cancelled || !res.ok) return
      if (res.value) term.write(res.value.replace(/\n/g, '\r\n'))
    })
    void api.runs.resize(run.runId, term.cols, term.rows)

    const off = api.runs.onOutput(({ runId, data }) => {
      if (runId !== runIdRef.current) return
      termRef.current?.write(data)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [run?.runId])

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-shell-700 ${className}`}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-shell-700 bg-shell-850 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-ink-600">Output</span>
          {run && <StatusBadge run={run} />}
          {focused && run && (run.status === 'running' || run.status === 'paused') && (
            <span className="hidden text-[11px] text-ink-600 sm:inline">
              keystrokes go to the process
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void api.runs.log(run.runId).then((res) => {
                  if (res.ok) void navigator.clipboard.writeText(res.value)
                })
              }}
            >
              Copy log
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              termRef.current?.clear()
            }}
          >
            Clear
          </Button>
        </div>
      </div>
      <div
        ref={hostRef}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`min-h-0 flex-1 bg-plate px-2 py-1.5 ${heightClass}`}
      />
    </div>
  )
}

function StatusBadge({ run }: { run: RunInfo }): ReactNode {
  switch (run.status) {
    case 'starting':
      return <Badge tone="accent">starting</Badge>
    case 'running':
      return <Badge tone="live">running</Badge>
    case 'paused':
      return <Badge tone="warn">paused</Badge>
    case 'exited':
      return <Badge tone="neutral">finished</Badge>
    case 'failed':
      return <Badge tone="error">exit {run.exitCode ?? 'error'}</Badge>
  }
}
