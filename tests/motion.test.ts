import { motionBody, motionTitle, motionTone } from '@shared/motion'
import type { MotionTestFrame, MotionTestPhase } from '@shared/types'
import { describe, expect, it } from 'vitest'

const PHASES: MotionTestPhase[] = [
  'countdown',
  'centering',
  'settle',
  'joint',
  'homing',
  'done',
  'cancelled',
  'error'
]

/**
 * This banner is the only thing between a user and an arm that is about to move,
 * so every phase must say something — a phase that fell through to an empty
 * string would leave the Cancel button sitting under a blank warning.
 */
describe('motion test copy', () => {
  it('gives every phase a title and a body', () => {
    for (const phase of PHASES) {
      const frame: MotionTestFrame = { phase }
      expect(motionTitle(frame), phase).toBeTruthy()
      expect(motionBody(frame), phase).toBeTruthy()
    }
  })

  it('warns for every phase where the arm is about to move or is moving', () => {
    for (const phase of ['countdown', 'centering', 'settle', 'joint', 'homing'] as const) {
      expect(motionTone({ phase }), phase).toBe('warn')
    }
  })

  it('reports the outcome tones', () => {
    expect(motionTone({ phase: 'done' })).toBe('success')
    expect(motionTone({ phase: 'error' })).toBe('error')
    expect(motionTone({ phase: 'cancelled' })).toBe('info')
  })

  it('rounds the countdown up, so 4.2s left never reads as 4s of warning', () => {
    expect(motionTitle({ phase: 'countdown', remaining: 4.2 })).toContain('5s')
    expect(motionTitle({ phase: 'countdown', remaining: 0.3 })).toContain('1s')
  })

  it('says whether a cancelled test had already moved the arm', () => {
    expect(motionBody({ phase: 'cancelled', moved: false })).toMatch(/never moved/)
    expect(motionBody({ phase: 'cancelled', moved: true })).toMatch(/holding where it stopped/)
  })

  it('names the joint and target mid-sweep', () => {
    const title = motionTitle({ phase: 'joint', motor: 'elbow_flex', index: 3, total: 6 })
    expect(title).toContain('elbow_flex')
    expect(title).toContain('3/6')
    const body = motionBody({ phase: 'joint', motor: 'elbow_flex', target: 'max', position: 3100 })
    expect(body).toContain('elbow_flex')
    expect(body).toContain('3100 ticks')
  })

  it('credits the turn to the group, but names the joint that moves', () => {
    // Inside shoulder_lift's paired plan the elbow is what travels.
    const frame = {
      phase: 'joint',
      group: 'shoulder_lift',
      motor: 'elbow_flex',
      target: 'max',
      position: 3200,
      index: 2,
      total: 6
    } as const
    expect(motionTitle(frame)).toBe('Sweeping shoulder_lift (2/6)')
    expect(motionBody(frame)).toContain('Moving elbow_flex to max')
    expect(motionBody(frame)).toMatch(/clear of the table/)
  })

  it('does not claim a pairing when the joint moves on its own', () => {
    const solo = { phase: 'joint', group: 'wrist_flex', motor: 'wrist_flex', target: 'min' } as const
    expect(motionBody(solo)).toContain('The other joints hold position')
    expect(motionBody(solo)).not.toMatch(/table/)
  })
})
