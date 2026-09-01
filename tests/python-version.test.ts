import { describe, expect, it } from 'vitest'
import { MAX_PYTHON, MIN_PYTHON, PYTHON_RANGE, pythonSupport } from '../src/shared/devices'

/**
 * The upper bound is the part worth pinning. Python 3.14 turned `X | None` into a
 * non-callable `typing.Union`, and draccus passes that annotation straight to
 * `argparse.add_argument(type=...)`, so every LeRobot command dies with
 * "TypeError: str | None is not callable" before doing any work. Offering a 3.14
 * interpreter looks fine right up until the user hits Calibrate.
 */
describe('pythonSupport', () => {
  it('accepts the whole supported window', () => {
    expect(pythonSupport([3, 12, 0]).supported).toBe(true)
    expect(pythonSupport([3, 12, 13]).supported).toBe(true)
    expect(pythonSupport([3, 13, 12]).supported).toBe(true)
  })

  it('rejects interpreters older than LeRobot supports', () => {
    const res = pythonSupport([3, 11, 9])
    expect(res.supported).toBe(false)
    expect(res.reason).toMatch(/too old/)
  })

  it('rejects 3.14+, where draccus cannot build the arg parser', () => {
    for (const v of [[3, 14, 4], [3, 15, 0], [4, 0, 0]] as [number, number, number][]) {
      const res = pythonSupport(v)
      expect(res.supported).toBe(false)
      expect(res.reason).toMatch(/too new/)
    }
  })

  it('describes the window the UI advertises', () => {
    expect(PYTHON_RANGE).toBe(`${MIN_PYTHON.major}.${MIN_PYTHON.minor}–${MAX_PYTHON.major}.${MAX_PYTHON.minor}`)
  })
})
