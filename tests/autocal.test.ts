import { autoCalBody, autoCalSummary, autoCalTitle, autoCalTone } from '@shared/autocal'
import type { AutoCalFrame, AutoCalPhase } from '@shared/types'
import { describe, expect, it } from 'vitest'

const PHASES: AutoCalPhase[] = [
  'preparing',
  'seeking',
  'found',
  'moving',
  'writing',
  'parking',
  'done',
  'cancelled',
  'error'
]

describe('auto-calibration copy', () => {
  it('gives every phase a title and a body', () => {
    for (const phase of PHASES) {
      const frame: AutoCalFrame = { phase }
      expect(autoCalTitle(frame), phase).toBeTruthy()
      expect(autoCalBody(frame), phase).toBeTruthy()
    }
  })

  it('warns while the arm is being driven', () => {
    for (const phase of ['preparing', 'seeking', 'found', 'moving', 'writing', 'parking'] as const) {
      expect(autoCalTone({ phase }), phase).toBe('warn')
    }
    expect(autoCalTone({ phase: 'done' })).toBe('success')
    expect(autoCalTone({ phase: 'error' })).toBe('error')
    expect(autoCalTone({ phase: 'cancelled' })).toBe('info')
  })

  it('reports the tick the motor stopped at, which is what becomes the limit', () => {
    const body = autoCalBody({ phase: 'found', motor: 'elbow_flex', target: 'max', position: 3260 })
    expect(body).toContain('3260 ticks')
    expect(body).toContain('max')
  })

  it('flags a limit found without the joint really moving', () => {
    const barely = autoCalBody({ phase: 'found', target: 'min', position: 2000, travel: 0 })
    expect(barely).toMatch(/only moved 0 ticks/)
    expect(barely).toMatch(/check that joint was free/)
    const travelled = autoCalBody({ phase: 'found', target: 'min', position: 900, travel: 1100 })
    expect(travelled).not.toMatch(/check that joint/)
  })

  it('says the previous limits came back when a run does not finish', () => {
    expect(autoCalBody({ phase: 'cancelled', restored: true })).toMatch(/before are back/)
    expect(autoCalBody({ phase: 'cancelled' })).toMatch(/before anything was stored/)
    expect(autoCalBody({ phase: 'error', message: 'x', restored: true })).toMatch(/put back/)
  })

  it('names the joint being searched, with progress', () => {
    const title = autoCalTitle({ phase: 'seeking', motor: 'wrist_flex', target: 'min', index: 3, total: 5 })
    expect(title).toBe('Finding wrist_flex min (3/5)')
  })

  it('names the joints being measured, and says the others are left alone', () => {
    const body = autoCalBody({ phase: 'preparing', motors: ['gripper', 'wrist_flex'] })
    expect(body).toContain('gripper, wrist_flex')
    expect(body).toMatch(/not being measured keeps its own limits/)
  })

  it('says where the arm ended up', () => {
    expect(autoCalBody({ phase: 'done', parked: true })).toMatch(/shoulder down, forearm folded up, gripper closed/)
    expect(autoCalBody({ phase: 'done', parked: false })).toMatch(/holding where it is/)
  })

  it('says which end of the measured range it is moving to', () => {
    // A step can now park a joint at a limit, not only at the midpoint.
    expect(autoCalBody({ phase: 'moving', target: 'min', position: 1700 })).toContain('To the min of')
    expect(autoCalBody({ phase: 'moving', target: 'mid', position: 2040 })).toContain('To the middle of')
    expect(autoCalTitle({ phase: 'moving', motor: 'gripper', target: 'min' })).toBe(
      'Moving gripper to min'
    )
  })

  it('names the joint being parked', () => {
    const frame = { phase: 'parking', motor: 'elbow_flex', target: 'max', position: 2740 } as const
    expect(autoCalTitle(frame)).toBe('Parking elbow_flex')
    expect(autoCalBody(frame)).toContain('2740 ticks')
  })

  it('summarises discovered ranges', () => {
    expect(autoCalSummary({ gripper: { min: 1700, max: 2380 } })).toBe('gripper 1700…2380')
  })
})
