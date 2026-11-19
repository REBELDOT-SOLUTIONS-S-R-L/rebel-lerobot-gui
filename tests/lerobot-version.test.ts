import { describe, expect, it } from 'vitest'
import { LEROBOT_REQUIREMENT, MAX_LEROBOT, lerobotSupport } from '../src/shared/devices'
import { buildInstallLerobotCommand } from '../src/main/python/installer'

/**
 * LeRobot 0.7.0 replaced the Feetech motor bus, and the bridge's direct motor
 * calls stopped working with it. An unpinned install picks up whatever is newest
 * on PyPI, so a new user would get a Configure panel that cannot connect. The pin
 * and the Settings warning both hang off MAX_LEROBOT.
 */
describe('lerobotSupport', () => {
  it('accepts the releases the bridge was written against', () => {
    for (const v of ['0.5.1', '0.6.0', '0.6.1']) expect(lerobotSupport(v).supported).toBe(true)
  })

  it('rejects the release that changed the motor bus, and says what to install', () => {
    const res = lerobotSupport('0.7.0')
    expect(res.supported).toBe(false)
    expect(res.reason).toContain(`lerobot${LEROBOT_REQUIREMENT}`)
    expect(lerobotSupport('1.0.0').supported).toBe(false)
  })

  it('does not guess about builds it cannot parse', () => {
    for (const v of [null, undefined, 'unknown', '']) expect(lerobotSupport(v).supported).toBe(true)
  })
})

describe('installing LeRobot', () => {
  it('pins a PyPI install below the first unsupported release', () => {
    const cmd = buildInstallLerobotCommand({ venvPath: '/venv' })
    expect(LEROBOT_REQUIREMENT).toBe(`<${MAX_LEROBOT[0]}.${MAX_LEROBOT[1] + 1}`)
    expect(cmd.args.at(-1)).toBe(`lerobot[core_scripts,feetech]${LEROBOT_REQUIREMENT}`)
  })

  it('leaves an editable install from a checkout alone', () => {
    const cmd = buildInstallLerobotCommand({ venvPath: '/venv', sourcePath: '/src/lerobot' })
    expect(cmd.args).toContain('.[core_scripts,feetech]')
    expect(cmd.args.join(' ')).not.toContain('<')
  })
})
