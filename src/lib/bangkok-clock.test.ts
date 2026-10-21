import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchBangkokDate } from './bangkok-clock'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('offline-safe Bangkok date watcher', () => {
  it('updates through Bangkok midnight, refreshes on foreground and removes listeners on cleanup', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-31T16:59:50Z'))
    const browser = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', { setInterval, clearInterval, addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser) })
    vi.stubGlobal('document', doc)
    const receive = vi.fn()
    const stop = watchBangkokDate(receive)
    expect(receive).toHaveBeenLastCalledWith('2026-12-31')
    vi.advanceTimersByTime(30000)
    expect(receive).toHaveBeenLastCalledWith('2027-01-01')
    vi.setSystemTime(new Date('2027-02-01T00:00:00Z')); doc.dispatchEvent(new Event('visibilitychange'))
    expect(receive).toHaveBeenLastCalledWith('2027-02-01')
    vi.setSystemTime(new Date('2027-03-01T00:00:00Z')); browser.dispatchEvent(new Event('focus'))
    expect(receive).toHaveBeenLastCalledWith('2027-03-01')
    browser.dispatchEvent(new Event('pageshow'))
    stop(); const count = receive.mock.calls.length
    browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('pageshow')); doc.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60000)
    expect(receive).toHaveBeenCalledTimes(count)
  })
})
