import { STS3215_MAX_TICK } from '@shared/devices'
import type { MotorState } from '@shared/types'
import type { ReactNode } from 'react'

/**
 * One motor's information card, sitting in the diagram gutter with a leader line
 * pointing at the joint it describes.
 */
export function MotorCallout({
  motor,
  align,
  selected,
  onSelect
}: {
  motor: MotorState
  align: 'left' | 'right'
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const min = motor.rangeMin
  const max = motor.rangeMax
  const hasLimits = min !== null && max !== null && max > min
  const span = hasLimits ? max - min : STS3215_MAX_TICK
  const base = hasLimits ? min : 0
  const fraction =
    motor.position === null ? null : Math.min(1, Math.max(0, (motor.position - base) / span))
  const outOfRange =
    hasLimits && motor.position !== null && (motor.position < min || motor.position > max)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
        align === 'right' ? 'text-left' : 'text-right'
      } ${
        selected
          ? 'border-accent-500 bg-accent-600/12'
          : 'border-shell-700 bg-shell-850/85 hover:border-shell-500'
      }`}
    >
      <div
        className={`flex items-center gap-1.5 ${align === 'left' ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <span
          className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold ${
            motor.online ? 'bg-live-400 text-shell-950' : 'bg-shell-600 text-ink-300'
          }`}
        >
          {motor.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-100">{motor.label}</span>
      </div>

      {/* Position readout: raw encoder ticks, which is what the limits are in. */}
      <div className={`mt-1.5 flex items-baseline gap-1 ${align === 'left' ? 'justify-end' : ''}`}>
        <span
          className={`font-mono text-base leading-none tabular-nums ${
            outOfRange ? 'text-warn-400' : motor.position === null ? 'text-ink-600' : 'text-ink-100'
          }`}
        >
          {motor.position ?? '—'}
        </span>
        <span className="text-[10px] text-ink-600">ticks</span>
      </div>

      <div className="mt-1.5">
        <div className="relative h-1.5 overflow-hidden rounded-full bg-shell-700">
          {fraction !== null && (
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${
                outOfRange ? 'bg-warn-400' : 'bg-accent-500'
              }`}
              style={{ width: `${fraction * 100}%` }}
            />
          )}
        </div>
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] tabular-nums text-ink-600">
          <span>{min ?? '—'}</span>
          <span>{max ?? '—'}</span>
        </div>
      </div>

      <div
        className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-600 ${
          align === 'left' ? 'justify-end' : ''
        }`}
      >
        <span>
          offset <span className="font-mono tabular-nums">{motor.homingOffset ?? '—'}</span>
        </span>
        {motor.gearRatio && <span>gear {motor.gearRatio}</span>}
      </div>
    </button>
  )
}
