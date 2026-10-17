import type { SyncStatus } from '../types'

export interface VersionedRecord {
  id: string
  userId: string
  updatedAt: string
  syncStatus: SyncStatus
}

// Cloud-enabled ledgers must not silently fork new anonymous local data.
// Network availability is intentionally not checked: signed-in offline edits
// remain queued locally and are uploaded when connectivity returns.
export const canWriteLedger = (configured: boolean, authenticatedUserId: string | null | undefined) =>
  !configured || Boolean(authenticatedUserId)

export const isNewer = (left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()

// Ensure consecutive local edits remain distinct, even within one millisecond.
export const nextModifiedAt = (...previousVersions: (string | undefined)[]) =>
  new Date(Math.max(Date.now(), ...previousVersions.map((value) => value ? new Date(value).getTime() + 1 : 0))).toISOString()

export const needsUpload = <T extends VersionedRecord>(local: T, remote?: T) =>
  !remote || isNewer(local.updatedAt, remote.updatedAt)

// Older caches/clients have no rule fields. A newer price/note edit must not
// erase explicit settings that were already synchronized by another device.
export const preserveRuleFields = <T>(preferred: T, fallback: T): T => {
  let result = preferred as T & Record<string, unknown>
  const other = fallback as T & Record<string, unknown>
  for (const key of ['defaultAmountBasis', 'settlementMode', 'manualCostPrice', 'manualSupplier']) {
    if (result[key] == null && other[key] != null) result = { ...result, [key]: other[key] }
  }
  return result
}

// Called inside an IndexedDB read/write transaction. A newer edit made while a
// network request was in flight must not be replaced or marked as synchronized.
export const mergeRemoteRecord = <T extends VersionedRecord>(current: T | undefined, remote: T): T => {
  if (!current) return { ...remote, syncStatus: 'synced' }
  if (current.userId !== remote.userId) return current
  if (isNewer(current.updatedAt, remote.updatedAt)) return preserveRuleFields(current, remote)
  return { ...preserveRuleFields(remote, current), syncStatus: 'synced' }
}

export interface SyncQueue {
  request: () => Promise<void>
  clearPending: () => void
}

// Overlapping requests share one worker; changes arriving during a run schedule
// one follow-up pass instead of starting parallel pulls and pushes.
export function createSyncQueue(run: () => Promise<void>): SyncQueue {
  let active: Promise<void> | null = null
  let pending = false
  return {
    request() {
      pending = true
      active ??= (async () => {
        await Promise.resolve()
        try {
          while (pending) {
            pending = false
            await run()
          }
        } finally {
          active = null
        }
      })()
      return active
    },
    clearPending() {
      pending = false
    }
  }
}
