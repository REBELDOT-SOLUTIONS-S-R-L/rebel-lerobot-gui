/**
 * Wording for each stage of a motion test.
 *
 * Kept out of the panel and free of JSX so every phase's copy is unit-testable:
 * this is the only thing standing between a user and a moving arm, and a phase
 * that renders an empty banner would be a safety problem, not a cosmetic one.
 */
import type { MotionTestFrame } from './types'

export function motionTone(m: MotionTestFrame): 'info' | 'warn' | 'error' | 'success' {
  if (m.phase === 'error') return 'error'
  if (m.phase === 'done') return 'success'
  if (m.phase === 'cancelled') return 'info'
  // Every other phase means the arm is about to move, or is moving.
  return 'warn'
}

export function motionTitle(m: MotionTestFrame): string {
  switch (m.phase) {
    case 'countdown':
      return `Motion test starts in ${Math.ceil(m.remaining ?? 0)}s — stand clear of the arm`
    case 'centering':
      return 'Moving every joint to the middle of its range'
    case 'settle':
      return 'Holding still'
    case 'joint':
      return `Sweeping ${m.group ?? m.motor ?? 'joint'} (${m.index ?? 0}/${m.total ?? 0})`
    case 'homing':
      return 'Returning to the starting position'
    case 'done':
      return 'Motion test finished'
    case 'cancelled':
      return m.moved ? 'Motion test stopped' : 'Motion test cancelled'
    case 'error':
      return 'Motion test failed'
  }
}

export function motionBody(m: MotionTestFrame): string {
  switch (m.phase) {
    case 'countdown':
      return 'Cancel now if anything is in the way. Nothing has moved yet.'
    case 'centering':
      return 'Each joint travels to the midpoint of its calibrated limits.'
    case 'settle':
      return `Pausing for ${m.seconds ?? 2}s.`
    case 'joint': {
      const where = `Moving ${m.motor ?? 'the joint'} to ${m.target ?? '—'}${
        m.position !== undefined ? ` (${m.position} ticks)` : ''
      }.`
      // A paired plan drives a joint other than the one whose turn it is, which
      // is worth explaining while the arm is doing something unexpected.
      return m.group && m.motor && m.group !== m.motor
        ? `${where} It is swept together with ${m.group} so the arm stays clear of the table.`
        : `${where} The other joints hold position.`
    }
    case 'homing':
      return 'Every joint goes back to where it was when you pressed the button.'
    case 'done':
      return 'The arm is back at its starting position and still holding torque.'
    case 'cancelled':
      return m.moved
        ? 'The arm is holding where it stopped. Torque is still on, so it will not drop.'
        : 'The arm never moved.'
    case 'error':
      return m.message ?? 'The sequence stopped unexpectedly.'
  }
}
