import { MOTOR_NAMES, SO_ARM_MOTORS, lerobotBimanualType, lerobotDeviceType } from '@shared/devices'
import { SIDEBAR_MIN, clampSidebarWidth } from '@shared/layout'
import { DIAGRAM, anchorPoint, anchorsFor, armImageFor, leaderPoints } from '@shared/motor-layout'
import { describe, expect, it } from 'vitest'

describe('device tables', () => {
  it('keeps the six SO-arm motors in LeRobot dict order', () => {
    // This order drives observation keys, action keys and calibration file order.
    expect(MOTOR_NAMES).toEqual([
      'shoulder_pan',
      'shoulder_lift',
      'elbow_flex',
      'wrist_flex',
      'wrist_roll',
      'gripper'
    ])
  })

  it('assigns factory IDs 1..6 in that order', () => {
    expect(SO_ARM_MOTORS.map((m) => m.defaultId)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('normalizes the gripper on 0..100 and the joints in degrees', () => {
    const gripper = SO_ARM_MOTORS.find((m) => m.name === 'gripper')
    expect(gripper?.normMode).toBe('range_0_100')
    expect(SO_ARM_MOTORS.filter((m) => m.name !== 'gripper').every((m) => m.normMode === 'degrees')).toBe(
      true
    )
  })

  it('builds the registered lerobot type strings', () => {
    expect(lerobotDeviceType('SO101', 'robot')).toBe('so101_follower')
    expect(lerobotDeviceType('SO101', 'teleop')).toBe('so101_leader')
    expect(lerobotDeviceType('SO100', 'robot')).toBe('so100_follower')
    expect(lerobotDeviceType('SO100', 'teleop')).toBe('so100_leader')
    expect(lerobotBimanualType('robot')).toBe('bi_so_follower')
    expect(lerobotBimanualType('teleop')).toBe('bi_so_leader')
  })
})

describe('diagram layout', () => {
  for (const role of ['robot', 'teleop'] as const) {
    describe(role, () => {
      const anchors = anchorsFor(role)

      it('has exactly one anchor per motor', () => {
        expect(anchors.map((a) => a.motor).sort()).toEqual([...MOTOR_NAMES].sort())
      })

      it('keeps every anchor inside the image', () => {
        for (const a of anchors) {
          expect(a.x).toBeGreaterThan(0)
          expect(a.x).toBeLessThan(1)
          expect(a.y).toBeGreaterThan(0)
          expect(a.y).toBeLessThan(1)
        }
      })

      it('balances callouts across the two gutters', () => {
        const left = anchors.filter((a) => a.side === 'left').length
        expect(left).toBe(3)
        expect(anchors.length - left).toBe(3)
      })

      it('spaces callout slots enough that cards cannot overlap', () => {
        for (const side of ['left', 'right'] as const) {
          const slots = anchors
            .filter((a) => a.side === side)
            .map((a) => a.calloutY)
            .sort((p, q) => p - q)
          for (let i = 1; i < slots.length; i++) {
            expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(0.15)
          }
        }
      })

      it('maps anchors into the image band of the diagram canvas', () => {
        for (const a of anchors) {
          const p = anchorPoint(a)
          expect(p.x).toBeGreaterThanOrEqual(DIAGRAM.image.x)
          expect(p.x).toBeLessThanOrEqual(DIAGRAM.image.x + DIAGRAM.image.width)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThanOrEqual(DIAGRAM.height)
        }
      })

      it('ends each leader line at its own gutter', () => {
        for (const a of anchors) {
          const points = leaderPoints(a).split(' ')
          expect(points).toHaveLength(3)
          const [lastX, lastY] = points[2].split(',').map(Number)
          expect(lastX).toBe(
            a.side === 'left' ? DIAGRAM.leaderStop.left : DIAGRAM.leaderStop.right
          )
          expect(lastY).toBeCloseTo(a.calloutY * DIAGRAM.height, 5)
        }
      })
    })
  }

  it('uses a distinct render per role', () => {
    expect(armImageFor('robot')).toBe('so101-robot.png')
    expect(armImageFor('teleop')).toBe('so101-leader.png')
  })

  it('centres the 800x1200 render in the canvas', () => {
    expect(DIAGRAM.image.x * 2 + DIAGRAM.image.width).toBe(DIAGRAM.width)
    expect(DIAGRAM.image.height).toBe(DIAGRAM.height)
  })
})

/**
 * The split's ceiling is the rule a user can actually feel: drag as far right as
 * you like and the side column stops at half the window. The awkward case is a
 * window too narrow to satisfy both limits at once, where the ceiling has to win
 * — otherwise the main column silently loses its floor instead.
 */
describe('clampSidebarWidth', () => {
  const base = { containerWidth: 1600, windowWidth: 1600, minMain: 380 }

  it('leaves a width inside the limits alone', () => {
    expect(clampSidebarWidth({ ...base, width: 420 })).toBe(420)
  })

  it('caps the side column at half the window', () => {
    expect(clampSidebarWidth({ ...base, width: 5000 })).toBe(800)
    expect(clampSidebarWidth({ ...base, windowWidth: 1200, width: 5000 })).toBe(600)
  })

  it('measures the cap against the window, not the container', () => {
    // A panel inset from the window edge still cannot exceed half the window.
    expect(clampSidebarWidth({ containerWidth: 3000, windowWidth: 1000, minMain: 380, width: 900 })).toBe(500)
  })

  it('keeps the main column above its floor before the cap applies', () => {
    expect(clampSidebarWidth({ ...base, containerWidth: 900, width: 800 })).toBe(520)
  })

  it('raises a too-small width to the minimum', () => {
    expect(clampSidebarWidth({ ...base, width: 40 })).toBe(SIDEBAR_MIN)
  })

  it('lets the ceiling win when the window cannot fit both limits', () => {
    // 25% of 900 is 225, below SIDEBAR_MIN: the side column gives way.
    expect(clampSidebarWidth({ containerWidth: 500, windowWidth: 900, minMain: 380, width: 400 })).toBe(120)
  })

  it('always returns whole pixels', () => {
    expect(clampSidebarWidth({ ...base, width: 419.6 })).toBe(420)
  })
})
