import {
  AXIS_LABELS,
  EE_ANGULAR_SPEED,
  EE_AXES,
  EE_FINE_SCALE,
  EE_LINEAR_SPEED,
  GAMEPAD_BINDINGS,
  KEYBOARD_BINDINGS,
  keyLabel
} from '@shared/teleop-input'
import type { TeleopController } from '@shared/types'
import type { ReactNode } from 'react'
import type { EeDriveState } from '../lib/use-ee-drive'
import { Badge, Field, Notice } from './ui'

/**
 * What the keys and sticks do, and what they are asking for right now.
 *
 * The legend is rendered from the same tables the control loop obeys
 * (`@shared/teleop-input`), so a remapped key cannot end up documented wrong.
 */
export function EeControls({
  controller,
  state,
  speed,
  onSpeed
}: {
  controller: Exclude<TeleopController, 'leader'>
  state: EeDriveState
  speed: number
  onSpeed: (next: number) => void
}): ReactNode {
  const scale = speed * (state.command.fine ? EE_FINE_SCALE : 1)


  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {EE_AXES.map((axis) => (
          <AxisMeter
            key={axis}
            label={AXIS_LABELS[axis].short}
            sense={AXIS_LABELS[axis].sense}
            value={state.command[axis]}
          />
        ))}
        <AxisMeter label="Jaws" sense="open" value={state.command.gripper} />
      </div>

      <Field
        label={`Speed — ${(EE_LINEAR_SPEED * scale * 100).toFixed(1)} cm/s, ${(
          (EE_ANGULAR_SPEED * scale * 180) /
          Math.PI
        ).toFixed(0)}°/s`}
        hint={
          state.command.fine
            ? `Fine control held — a quarter of the set speed.`
            : 'Hold the fine modifier for a quarter of this.'
        }
      >
        <input
          type="range"
          min={10}
          max={200}
          step={5}
          value={Math.round(speed * 100)}
          onChange={(e) => onSpeed(Number(e.currentTarget.value) / 100)}
          className="w-full accent-accent-500"
        />
      </Field>

      {state.tool && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-600">Tool at</dt>
          <dd className="font-mono tabular-nums text-ink-100">
            {state.tool.position.map((v) => `${(v * 1000).toFixed(0)}`).join(', ')}
            <span className="ml-1 text-ink-600">mm</span>
          </dd>
          <dt className="text-ink-600">Pointing</dt>
          <dd className="font-mono tabular-nums text-ink-300">
            {state.tool.rotation.map((v) => `${((v * 180) / Math.PI).toFixed(0)}`).join(', ')}
            <span className="ml-1 text-ink-600">deg</span>
          </dd>
          <dt className="text-ink-600">Solver</dt>
          <dd className="font-mono tabular-nums text-ink-300">
            {(state.positionError * 1000).toFixed(1)} mm,{' '}
            {((state.orientationError * 180) / Math.PI).toFixed(1)}°
          </dd>
        </dl>
      )}

      {state.stalled && (
        <Notice
          tone="warn"
          title={
            state.clamped.length > 0
              ? `${state.clamped.join(', ')} is against an end stop`
              : 'Out of reach'
          }
        >
          The tool is not moving, though it is being asked to.{' '}
          {state.clamped.length > 0
            ? 'That joint cannot go any further.'
            : 'The arm is not long enough to reach where it is being sent.'}{' '}
          Back off, or return to the middle of every range.
        </Notice>
      )}

      {controller === 'keyboard' ? <KeyboardLegend /> : <GamepadLegend state={state} />}
    </div>
  )
}

/** A signed bar: left of centre is negative, right positive. */
function AxisMeter({
  label,
  sense,
  value
}: {
  label: string
  sense: string
  value: number
}): ReactNode {
  const magnitude = Math.min(1, Math.abs(value)) * 50
  return (
    <div className="flex items-center gap-2" title={sense}>
      <span className="w-9 shrink-0 font-mono text-[11px] text-ink-500">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-shell-800">
        <span className="absolute top-0 bottom-0 left-1/2 w-px bg-shell-600" aria-hidden />
        <span
          className="absolute top-0 bottom-0 bg-accent-500 transition-[width,left] duration-75"
          style={{
            left: value < 0 ? `${50 - magnitude}%` : '50%',
            width: `${magnitude}%`
          }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-600">
        {value === 0 ? '—' : value.toFixed(1)}
      </span>
    </div>
  )
}

function Key({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-shell-600 bg-shell-800 px-1 py-0.5 font-mono text-[10px] text-ink-200">
      {children}
    </kbd>
  )
}

function KeyboardLegend(): ReactNode {
  return (
    <div className="rounded-lg border border-shell-700 bg-shell-900 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-600">
        Keys
      </p>
      <table className="w-full text-xs">
        <tbody>
          {KEYBOARD_BINDINGS.map((binding) => (
            <tr key={binding.target} className="border-t border-shell-800 first:border-0">
              <td className="py-1 pr-2 whitespace-nowrap">
                {binding.positive.map((code) => (
                  <Key key={code}>{keyLabel(code)}</Key>
                ))}
                <span className="mx-1 text-ink-700">/</span>
                {binding.negative.map((code) => (
                  <Key key={code}>{keyLabel(code)}</Key>
                ))}
              </td>
              <td className="py-1 text-ink-500">{binding.sense}</td>
            </tr>
          ))}
          <tr className="border-t border-shell-800">
            <td className="py-1 pr-2 whitespace-nowrap">
              <Key>Shift</Key>
            </td>
            <td className="py-1 text-ink-500">hold for fine control</td>
          </tr>
          <tr className="border-t border-shell-800">
            <td className="py-1 pr-2 whitespace-nowrap">
              <Key>0</Key>
            </td>
            <td className="py-1 text-ink-500">back to the middle of every range</td>
          </tr>
          <tr className="border-t border-shell-800">
            <td className="py-1 pr-2 whitespace-nowrap">
              <Key>Esc</Key>
            </td>
            <td className="py-1 text-ink-500">stop driving</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-600">
        The keys work while this window has focus; the app swallows them so they cannot also scroll
        the panel.
      </p>
    </div>
  )
}

function GamepadLegend({ state }: { state: EeDriveState }): ReactNode {
  return (
    <div className="rounded-lg border border-shell-700 bg-shell-900 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-600">
          Controller
        </p>
        {state.pad ? (
          <Badge tone={state.pad.standard ? 'live' : 'warn'}>
            {state.pad.standard ? 'connected' : 'non-standard layout'}
          </Badge>
        ) : (
          <Badge tone="neutral">none detected</Badge>
        )}
      </div>

      {state.pad ? (
        <p className="mb-2 truncate font-mono text-[11px] text-ink-500" title={state.pad.id}>
          {state.pad.id}
        </p>
      ) : (
        <p className="mb-2 text-xs leading-relaxed text-ink-500">
          Plug in a controller and press a button on it — browsers only report a gamepad once it has
          been used.
        </p>
      )}

      {state.pad && !state.pad.standard && (
        <Notice tone="warn">
          This controller does not report the standard layout, so the sticks and buttons below may
          not be where the app expects them.
        </Notice>
      )}

      <table className="w-full text-xs">
        <tbody>
          {GAMEPAD_BINDINGS.map((binding) => (
            <tr key={binding.control} className="border-t border-shell-800 first:border-0">
              <td className="py-1 pr-3 whitespace-nowrap text-ink-200">{binding.control}</td>
              <td className="py-1 text-ink-500">{binding.sense}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-600">
        <kbd>Esc</kbd> stops driving, whichever controller is in use.
      </p>
    </div>
  )
}
