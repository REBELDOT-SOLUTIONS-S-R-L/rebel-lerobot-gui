import {
  VOLTAGE_HIGH_RAW,
  VOLTAGE_LOW_RAW,
  decodeStatus,
  formatCurrent,
  formatFirmware,
  formatLoad,
  formatModelNumber,
  formatTemperature,
  formatVelocity,
  formatVoltage,
  modelMismatch,
  temperatureTone,
  voltageTone
} from '@shared/feetech'
import { describe, expect, it } from 'vitest'

/**
 * The scaling factors are the part worth pinning: they are the difference
 * between "11.8 V" and "118 V" on a panel someone uses to decide whether their
 * supply is sagging, and nothing else in the app would catch a wrong one.
 */
describe('unit conversion', () => {
  it('scales voltage by 0.1 V per unit', () => {
    expect(formatVoltage(118)).toBe('11.8 V')
    expect(formatVoltage(0)).toBe('0.0 V')
  })

  it('scales current by 6.5 mA per unit and switches to amps past 1 A', () => {
    expect(formatCurrent(100)).toBe('650 mA')
    expect(formatCurrent(200)).toBe('1.30 A')
  })

  it('scales load by 0.1% per unit and keeps the sign', () => {
    expect(formatLoad(250)).toBe('25.0 %')
    expect(formatLoad(-250)).toBe('-25.0 %')
  })

  it('reports temperature and velocity as the motor gives them', () => {
    expect(formatTemperature(42)).toBe('42 °C')
    expect(formatVelocity(-300)).toBe('-300 ticks/s')
  })

  it('renders an unread register as an em dash rather than a zero', () => {
    for (const fn of [formatVoltage, formatCurrent, formatLoad, formatTemperature, formatVelocity]) {
      expect(fn(null)).toBe('—')
    }
  })
})

describe('decodeStatus', () => {
  it('reports nothing for a healthy motor', () => {
    expect(decodeStatus(0)).toEqual([])
  })

  it('names the bits that Feetech documents consistently', () => {
    expect(decodeStatus(0b100)).toEqual(['Overheated'])
    expect(decodeStatus(0b100001)).toEqual(['Voltage out of range', 'Overloaded'])
  })

  /**
   * An unnamed bit still has to surface: silently dropping it would show a
   * faulting motor as healthy, which is the one failure this must not have.
   */
  it('surfaces undocumented bits instead of dropping them', () => {
    expect(decodeStatus(0b1000)).toEqual(['Unknown fault (0x08)'])
    expect(decodeStatus(0b1100)).toEqual(['Overheated', 'Unknown fault (0x08)'])
  })
})

describe('model identity', () => {
  it('names a known model number and passes an unknown one through', () => {
    expect(formatModelNumber(777)).toBe('sts3215 (777)')
    expect(formatModelNumber(4242)).toBe('4242')
    expect(formatModelNumber(null)).toBe('—')
  })

  it('flags a motor that is not the model the arm is configured for', () => {
    expect(modelMismatch(2825, 'sts3215')).toBe(true)
    expect(modelMismatch(777, 'sts3215')).toBe(false)
  })

  /**
   * An unrecognised number means the app's table is out of date, not that the
   * arm is wrong — warning there would cry wolf on every new Feetech model.
   */
  it('does not treat an unknown model number as a mismatch', () => {
    expect(modelMismatch(4242, 'sts3215')).toBe(false)
    expect(modelMismatch(null, 'sts3215')).toBe(false)
  })

  it('formats firmware only when both halves were read', () => {
    expect(formatFirmware(3, 9)).toBe('3.9')
    expect(formatFirmware(3, null)).toBe('—')
  })
})

describe('advisory tones', () => {
  it('escalates temperature in two steps', () => {
    expect(temperatureTone(30)).toBe('ok')
    expect(temperatureTone(55)).toBe('warn')
    expect(temperatureTone(65)).toBe('error')
  })

  it('warns on a supply outside the band the arm expects', () => {
    expect(voltageTone(VOLTAGE_LOW_RAW - 1)).toBe('warn')
    expect(voltageTone(VOLTAGE_HIGH_RAW + 1)).toBe('warn')
    expect(voltageTone(120)).toBe('ok')
  })

  it('stays quiet when a register was not read', () => {
    expect(temperatureTone(null)).toBe('ok')
    expect(voltageTone(null)).toBe('ok')
  })
})
