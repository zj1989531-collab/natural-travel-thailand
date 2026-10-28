import { describe, expect, it } from 'vitest'
import { canAutoApplyAppUpdate } from './app-update-policy'

describe('automatic app updates', () => {
  it('reloads immediately after background sync, even when a disposable draft is open', () => {
    expect(canAutoApplyAppUpdate({ syncing: false })).toBe(true)
    expect(canAutoApplyAppUpdate({ syncing: true })).toBe(false)
  })
})
