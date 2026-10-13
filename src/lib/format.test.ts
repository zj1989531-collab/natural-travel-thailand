import { describe, expect, it } from 'vitest'
import { getBangkokDate, getBangkokTime, isValidIssueTime, isValidPersonCount, MAX_PERSON_COUNT } from './format'

describe('person count', () => {
  it.each([1, 2, 100, MAX_PERSON_COUNT])('accepts positive integer %s', (count) => expect(isValidPersonCount(count)).toBe(true))
  it.each([0, -1, 1.5, NaN, Infinity, MAX_PERSON_COUNT + 1])('rejects invalid count %s', (count) => expect(isValidPersonCount(count)).toBe(false))
})

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
