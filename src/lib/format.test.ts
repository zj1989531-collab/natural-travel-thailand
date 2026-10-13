import { describe, expect, it } from 'vitest'
import { getBangkokDate, getBangkokTime, isValidIssueTime } from './format'

describe('Bangkok issue time', () => {
  it('defaults to Bangkok time independent of the device time zone', () => {
    expect(getBangkokTime(new Date('2026-10-13T15:37:00Z'))).toBe('22:37')
  })
  it('uses 00:00 at Bangkok midnight and changes the Bangkok date together', () => {
    const midnight = new Date('2026-10-13T17:00:00Z')
    expect(getBangkokTime(midnight)).toBe('00:00')
    expect(getBangkokDate(midnight)).toBe('2026-10-14')
  })
  it.each(['00:00', '09:05', '23:59'])('accepts manually selected time %s', (time) => expect(isValidIssueTime(time)).toBe(true))
  it.each(['24:00', '23:60', '9:5', '', 'no time'])('rejects invalid time %s', (time) => expect(isValidIssueTime(time)).toBe(false))
})
