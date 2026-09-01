import { MAX_MOTOR_ID, checkMotorIdWrite } from '@shared/devices'
import { describe, expect, it } from 'vitest'

/**
 * These mirror the refusals in the bridge's `BusSession.write_id`. The two
 * "needs force" cases are the ones worth pinning: a duplicate ID makes the bus
 * unusable until one of the pair is moved again, so it must never become a
 * silent default, and it must stay reachable for the user who means it.
 */
describe('checkMotorIdWrite', () => {
  it('accepts a free ID that differs from the current one', () => {
    expect(checkMotorIdWrite({ toId: 4, fromId: 2 })).toEqual({
      invalid: false,
      needsForce: false,
      reason: null
    })
  })

  it('rejects anything outside 0…MAX_MOTOR_ID, force or not', () => {
    for (const toId of [-1, MAX_MOTOR_ID + 1, 1.5, Number.NaN]) {
      const res = checkMotorIdWrite({ toId, fromId: 2 })
      expect(res.invalid, String(toId)).toBe(true)
      expect(res.needsForce, String(toId)).toBe(false)
    }
  })

  it('needs force to rewrite the ID a motor already has', () => {
    const res = checkMotorIdWrite({ toId: 3, fromId: 3 })
    expect(res).toMatchObject({ invalid: false, needsForce: true })
    expect(res.reason).toMatch(/already has ID 3/)
  })

  it('needs force to move a motor onto an ID another one holds', () => {
    const res = checkMotorIdWrite({ toId: 6, fromId: 2, takenBy: 'Gripper' })
    expect(res).toMatchObject({ invalid: false, needsForce: true })
    expect(res.reason).toMatch(/Gripper/)
  })

  it('reports the range problem before the collision', () => {
    // An out-of-range ID cannot be forced, so it must win over the softer refusal.
    expect(checkMotorIdWrite({ toId: 300, fromId: 300, takenBy: 'Elbow' }).invalid).toBe(true)
  })
})
