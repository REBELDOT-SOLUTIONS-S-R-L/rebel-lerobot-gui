import type { ReactNode } from 'react'
import { EE_CONTROLLERS, type ArmControl as ArmControlState } from '../lib/use-arm-control'
import { EeControls } from './EeControls'
import { Button, Field, Notice, Select } from './ui'

/**
 * Start and stop flying the arm, from a panel's header.
 *
 * Sits beside the badge that says what the arm is doing, because starting and
 * stopping control is a change to exactly that.
 */
export function ArmControlButton({ control }: { control: ArmControlState }): ReactNode {
  if (control.engaged) {
    return (
      <Button
        size="sm"
        variant="danger"
        title="Give up control of the arm. Escape does the same."
        onClick={control.stop}
      >
        Stop Control
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      variant="live"
      disabled={!control.ready}
      title={
        control.ready
          ? `Read the ${control.controller} and fly the arm from this screen.`
          : 'Loading this model’s kinematics…'
      }
      onClick={control.start}
    >
      Start Control
    </Button>
  )
}

/**
 * Which controller to fly with, and what it is doing.
 *
 * The same legend and meters the Teleoperate panel shows, so the keys mean the
 * same thing wherever they are pressed.
 */
export function ArmControlFields({
  control,
  hint
}: {
  control: ArmControlState
  hint?: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {control.error && <Notice tone="error">{control.error}</Notice>}

      <Field
        label="Controller"
        hint={
          hint ??
          'The keys or sticks command where the tool goes; the app solves the joint angles for it.'
        }
      >
        <Select
          value={control.controller}
          onChange={control.setController}
          // Swapping controller mid-flight would leave the loop seeded from a
          // pose the new one never asked for, so it waits for a stop.
          disabled={control.engaged}
          options={EE_CONTROLLERS}
        />
      </Field>

      {control.engaged ? (
        <EeControls
          controller={control.controller}
          state={control.drive}
          speed={control.speed}
          onSpeed={control.setSpeed}
        />
      ) : (
        <p className="text-xs leading-relaxed text-ink-600">
          Press <span className="text-ink-300">Start Control</span> above to fly the arm from here.
          Press <kbd>Esc</kbd> to stop.
        </p>
      )}
    </div>
  )
}
