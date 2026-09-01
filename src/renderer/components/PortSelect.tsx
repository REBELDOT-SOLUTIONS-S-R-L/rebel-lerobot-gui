import { useEffect, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'
import { Button, Select, Spinner } from './ui'

/**
 * Serial port dropdown, fed by pyserial's comports() through the bridge.
 *
 * Ports that look like a USB-serial adapter are listed first and labelled;
 * `lerobot-find-port` remains available for the unplug-diff test when the
 * description alone is not enough to tell two identical arms apart.
 */
export function PortSelect({
  value,
  onChange,
  onIdentify,
  disabled
}: {
  value: string
  onChange: (port: string) => void
  onIdentify?: () => void
  disabled?: boolean
}): ReactNode {
  const { ports, portsLoading, portsError, refreshPorts } = useAppStore(useShallow((s) => ({
    ports: s.ports,
    portsLoading: s.portsLoading,
    portsError: s.portsError,
    refreshPorts: s.refreshPorts
  })))

  useEffect(() => {
    if (ports.length === 0 && !portsLoading && !portsError) void refreshPorts()
  }, [ports.length, portsLoading, portsError, refreshPorts])

  const options = ports.map((p) => ({
    value: p.device,
    label: p.likelyMotorBus
      ? `${p.device} — ${p.description || 'USB serial'}`
      : `${p.device} — ${p.description || 'other'}`
  }))

  // Keep a saved port selectable even when the arm is currently unplugged.
  if (value && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: `${value} — not detected right now` })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select
          value={value || null}
          onChange={onChange}
          options={options}
          placeholder={portsLoading ? 'Scanning…' : 'Select a serial port…'}
          disabled={disabled || portsLoading}
          className="flex-1"
        />
        <Button size="sm" variant="secondary" disabled={portsLoading} onClick={() => void refreshPorts()}>
          {portsLoading ? <Spinner /> : 'Rescan'}
        </Button>
        {onIdentify && (
          <Button
            size="sm"
            variant="ghost"
            title="Run lerobot-find-port: unplug the arm and the port that disappears is its port."
            onClick={onIdentify}
          >
            Identify…
          </Button>
        )}
      </div>
      {portsError && <span className="text-xs text-warn-400">{portsError}</span>}
      {!portsError && ports.length === 0 && !portsLoading && (
        <span className="text-xs text-ink-600">
          No serial ports found. Connect the controller board over USB and give it power, then rescan.
        </span>
      )}
    </div>
  )
}
