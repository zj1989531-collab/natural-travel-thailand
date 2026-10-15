import { describe, expect, it, vi } from 'vitest'
import { canWriteLedger, createSyncQueue, mergeRemoteRecord, needsUpload, nextModifiedAt, type VersionedRecord } from './sync'

describe('cloud-first writes', () => {
  it.each([
    [false, null, true],
    [true, null, false],
    [true, '', false],
    [true, 'user-1', true]
  ] as const)('configured=%s, account=%s permits writes=%s', (configured, account, allowed) => {
    expect(canWriteLedger(configured, account)).toBe(allowed)
  })

  it('still permits signed-in offline edits for automatic upload after reconnect', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(canWriteLedger(true, 'user-1')).toBe(true)
    vi.unstubAllGlobals()
  })
})

const record = (updatedAt: string, syncStatus: VersionedRecord['syncStatus'] = 'pending') => ({
  id: 'ticket-1', userId: 'user-1', updatedAt, syncStatus, note: 'local'
})

describe('synchronization versions', () => {
  it('preserves rule fields missing from an older client in either merge direction', () => {
    const old = record('2026-10-13T01:00:02.000Z')
    const configured: ReturnType<typeof record> & { defaultAmountBasis?: string; settlementMode?: string } = { ...record('2026-10-13T01:00:01.000Z'), defaultAmountBasis: 'total', settlementMode: 'monthly' }
    expect(mergeRemoteRecord(old, configured)).toMatchObject({ ...old, defaultAmountBasis: 'total', settlementMode: 'monthly' })
    expect(mergeRemoteRecord(configured, old)).toMatchObject({ ...old, syncStatus: 'synced', defaultAmountBasis: 'total', settlementMode: 'monthly' })
    expect(mergeRemoteRecord(configured, { ...old, settlementMode: 'daily' })).toMatchObject({ settlementMode: 'daily', defaultAmountBasis: 'total' })
    expect(mergeRemoteRecord(configured, { ...old, userId: 'other' })).toBe(configured)
  })
  it('does not upload equal versions again after a realtime event', () => {
    const local = record('2026-10-13T01:00:00.000Z')
    const remote = { ...local, updatedAt: '2026-10-13T01:00:00+00:00', syncStatus: 'synced' as const }
    expect(needsUpload(local, remote)).toBe(false)
    expect(mergeRemoteRecord(local, remote).syncStatus).toBe('synced')
  })

  it('keeps a local edit made while the previous version was uploading', () => {
    const editedDuringUpload = record('2026-10-13T01:00:02.000Z')
    const uploadedSnapshot = record('2026-10-13T01:00:01.000Z', 'synced')
    expect(mergeRemoteRecord(editedDuringUpload, uploadedSnapshot)).toBe(editedDuringUpload)
    expect(needsUpload(editedDuringUpload, uploadedSnapshot)).toBe(true)
  })

  it('accepts the server winner after a newer concurrent device write', () => {
    const local = record('2026-10-13T01:00:01.000Z')
    const serverWinner = { ...record('2026-10-13T01:00:03.000Z', 'synced'), note: 'other device' }
    expect(mergeRemoteRecord(local, serverWinner)).toEqual(serverWinner)
    expect(needsUpload(serverWinner, serverWinner)).toBe(false)
  })

  it('gives successive same-millisecond edits different timestamps', () => {
    const priorVersion = new Date(Date.now() + 1000).toISOString()
    expect(new Date(nextModifiedAt(priorVersion)).getTime()).toBe(new Date(priorVersion).getTime() + 1)
  })
})

describe('serialized synchronization', () => {
  it('coalesces overlapping requests and performs a follow-up pass without overlap', async () => {
    let finishFirst!: () => void
    const heldFirstRun = new Promise<void>((resolve) => { finishFirst = resolve })
    let running = 0
    let maximumRunning = 0
    const run = vi.fn(async () => {
      running += 1
      maximumRunning = Math.max(maximumRunning, running)
      if (run.mock.calls.length === 1) await heldFirstRun
      running -= 1
    })
    const queue = createSyncQueue(run)
    const first = queue.request()
    await Promise.resolve()
    const second = queue.request()
    const third = queue.request()
    expect(first).toBe(second)
    expect(first).toBe(third)
    finishFirst()
    await Promise.all([first, second, third])
    expect(run).toHaveBeenCalledTimes(2)
    expect(maximumRunning).toBe(1)
  })

  it('can sync again after a failed worker and can clear a queued logout retry', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const queue = createSyncQueue(run)
    await expect(queue.request()).rejects.toThrow('offline')
    await queue.request()
    expect(run).toHaveBeenCalledTimes(2)
    const canceled = queue.request()
    queue.clearPending()
    await canceled
    expect(run).toHaveBeenCalledTimes(2)
  })
})
