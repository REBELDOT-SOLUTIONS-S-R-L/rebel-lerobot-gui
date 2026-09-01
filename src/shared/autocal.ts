/**
 * Wording for each stage of an auto-calibration run.
 *
 * Kept beside the motion-test copy and unit-tested the same way: this banner is
 * what tells a user the arm is about to push itself into its own hard stops, so
 * a phase that rendered nothing would be a safety problem rather than a
 * cosmetic one.
 */
import type { AutoCalFrame } from './types'

export function autoCalTone(m: AutoCalFrame): 'info' | 'warn' | 'error' | 'success' {
  if (m.phase === 'error') return 'error'
  if (m.phase === 'done') return 'success'
  if (m.phase === 'cancelled') return 'info'
  return 'warn'
}

export function autoCalTitle(m: AutoCalFrame): string {
  const progress = m.index && m.total ? ` (${m.index}/${m.total})` : ''
  switch (m.phase) {
    case 'preparing':
      return 'Clearing the stored limits'
    case 'seeking':
      return `Finding ${m.motor ?? 'joint'} ${m.target ?? ''}${progress}`.replace('  ', ' ')
    case 'found':
      return `${m.motor ?? 'Joint'} ${m.target ?? ''} found${progress}`
    case 'moving':
      return `Moving ${m.motor ?? 'joint'} to ${m.target ?? 'position'}${progress}`
    case 'writing':
      return 'Writing the new limits to the motors'
    case 'parking':
      return `Parking ${m.motor ?? 'the arm'}`
    case 'done':
      return 'Auto-calibration finished'
    case 'cancelled':
      return 'Auto-calibration cancelled'
    case 'error':
      return 'Auto-calibration failed'
  }
}

export function autoCalBody(m: AutoCalFrame): string {
  switch (m.phase) {
    case 'preparing':
      return `${
        m.motors?.length ? `${m.motors.join(', ')} are` : 'The measured joints are'
      } opened up to their full 0…4095 span — a joint cannot be driven past a limit it already holds. Any joint not being measured keeps its own limits.`
    case 'seeking':
      return `Driving ${m.motor ?? 'the joint'} slowly toward its ${
        m.target ?? 'limit'
      } until it stops moving. Torque is on: keep clear.`
    case 'found': {
      const where = `The motor stopped at ${m.position ?? '—'} ticks, which becomes its ${
        m.target ?? 'limit'
      }.`
      // Barely moving means it may have been against the stop already — fine — or
      // never have started, which would record a limit where it happened to sit.
      return m.travel !== undefined && m.travel < 20
        ? `${where} It only moved ${m.travel} ticks getting there, so check that joint was free.`
        : where
    }
    case 'moving':
      return `${
        m.target === 'mid' ? 'To the middle of' : `To the ${m.target ?? 'end'} of`
      } the range just measured${m.position !== undefined ? ` (${m.position} ticks)` : ''}.`
    case 'writing':
      return `Travel limits live in the motors, so torque drops for a moment while ${
        m.motors?.length ? `${m.motors.length} of them are` : 'they are'
      } stored, then comes straight back.`
    case 'parking':
      return `Moving to the home pose — shoulder down, forearm folded up, gripper closed. ${
        m.motor ?? 'This joint'
      } to ${m.target ?? 'mid'}${m.position !== undefined ? ` (${m.position} ticks)` : ''}.`
    case 'done': {
      const measured = m.ranges
        ? `${Object.keys(m.ranges).length} joints measured and stored.`
        : 'Limits measured and stored.'
      const pose =
        m.parked === false
          ? ' Stopped before the arm reached its home pose, so it is holding where it is.'
          : ' The arm is at its home pose: shoulder down, forearm folded up, gripper closed.'
      return `${measured}${pose} Save them to the calibration file to make them permanent.`
    }
    case 'cancelled':
      return m.restored
        ? 'The limits the motors had before are back in place, so nothing was left half-calibrated.'
        : 'Stopped before anything was stored.'
    case 'error':
      return `${m.message ?? 'The run stopped unexpectedly.'}${
        m.restored ? ' The previous limits have been put back.' : ''
      }`
  }
}

/** Compact one-line summary of a finished run, for the result notice. */
export function autoCalSummary(ranges: Record<string, { min: number; max: number }>): string {
  return Object.entries(ranges)
    .map(([name, r]) => `${name} ${r.min}…${r.max}`)
    .join(' · ')
}
