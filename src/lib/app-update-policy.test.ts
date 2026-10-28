import { describe, expect, it } from 'vitest'
import { canAutoApplyAppUpdate } from './app-update-policy'

describe('automatic app updates', () => {
  it('reloads only after background sync and visible editing have finished', () => {
    expect(canAutoApplyAppUpdate({ syncing: false, hasOpenEditor: false, isIndependentLedger: false })).toBe(true)
    expect(canAutoApplyAppUpdate({ syncing: true, hasOpenEditor: false, isIndependentLedger: false })).toBe(false)
    expect(canAutoApplyAppUpdate({ syncing: false, hasOpenEditor: true, isIndependentLedger: false })).toBe(false)
    expect(canAutoApplyAppUpdate({ syncing: false, hasOpenEditor: false, isIndependentLedger: true })).toBe(false)
  })
})
