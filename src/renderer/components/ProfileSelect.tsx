import type { DeviceRole } from '@shared/devices'
import { isVirtual } from '@shared/virtual'
import type { ReactNode } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Select } from './ui'

/**
 * Picks a saved device profile. Profiles carry port, model, id and calibration
 * directory, so every panel selects one instead of re-entering four fields.
 *
 * The virtual follower is always in the list, first, and reads as simulated
 * rather than as an arm on a port it does not have.
 */
export function ProfileSelect({
  role,
  value,
  onChange,
  placeholder,
  disabled
}: {
  role: DeviceRole
  value: string | null
  onChange: (uid: string) => void
  placeholder?: string
  disabled?: boolean
}): ReactNode {
  const profiles = useAppStore((s) => s.profiles)
  const setPanel = useAppStore((s) => s.setPanel)
  const matching = profiles.filter((p) => p.role === role)

  if (matching.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-shell-600 px-2.5 py-1.5 text-xs text-ink-600">
        No {role === 'robot' ? 'follower' : 'leader'} arms yet.{' '}
        <button
          type="button"
          className="text-accent-400 underline hover:text-accent-500"
          onClick={() => setPanel('configure')}
        >
          Create one in Configure
        </button>
        .
      </div>
    )
  }

  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder ?? `Select a ${role === 'robot' ? 'follower' : 'leader'}…`}
      options={matching.map((p) => ({
        value: p.uid,
        label: isVirtual(p.uid)
          ? `${p.id} — ${p.model}, simulated`
          : `${p.id} — ${p.model} on ${p.port || 'no port'}`
      }))}
    />
  )
}
