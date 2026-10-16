import type { Project, RefundRecord, Supplier, TicketInput, TicketRecord } from '../types'
import { normalizeSupplier } from './format'
import { cleanProjectLabel } from './project-labels'

export type SyncConflictTable = 'tickets' | 'suppliers' | 'projects' | 'ticket_refunds'
export type SyncConflictReason = 'remote_newer' | 'refund_locked' | 'upload_rejected'
export type SyncConflictSource = TicketRecord | Project | Supplier | RefundRecord

/** A recoverable local snapshot, never an instruction to overwrite a paid/refunded ticket. */
export interface SyncConflictRecord {
  id: string
  userId: string
  table: SyncConflictTable
  recordId: string
  reason: SyncConflictReason
  message: string
  localRecord: SyncConflictSource
  remoteRecord: SyncConflictSource | null
  createdAt: string
  resolvedAt: string | null
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]))
  }
  return value
}
const stableJson = (value: unknown): string => JSON.stringify(stableValue(value))
const normalizedTime = (time: string | null | undefined): string | null =>
  time?.trim().replace(/^(\d{2}:\d{2}):00(?:\.0+)?$/, '$1') || null

const businessRecord = (record: SyncConflictSource): Record<string, unknown> => {
  const value: Record<string, unknown> = { ...record }
  // Transport metadata, attached refunds and catalogue indexes are not editable business fields.
  for (const field of ['syncStatus', 'updatedAt', 'createdAt', 'refunds', 'normalizedName', 'normalizedSubItemName', 'mergedIntoId']) delete value[field]
  if ('issueDate' in record) {
    value.guestName = record.guestName ?? ''
    value.amountBasis = record.amountBasis ?? 'total'
    value.personCount = record.personCount ?? null
    value.entryMode = record.entryMode ?? 'standard'
    value.quantityUnit = record.quantityUnit ?? 'person'
    value.manualProfitThb = record.manualProfitThb ?? null
    value.issueTime = normalizedTime(record.issueTime)
    value.deletedAt = record.deletedAt ?? null
  } else if ('defaultAgentPriceThb' in record) {
    value.entryMode = record.entryMode ?? 'standard'
    value.quantityUnit = record.quantityUnit ?? 'person'
    value.manualAgentPrice = record.manualAgentPrice ?? false
  } else if ('ticketId' in record) {
    value.personCount = record.personCount ?? null
    value.cancelledAt = record.cancelledAt ?? null
    value.refundTime = normalizedTime(record.refundTime)
  }
  return value
}

/** Missing optional rules on an old client do not constitute an edit to a newer rule. */
export const meaningfulRecordChanged = (local: SyncConflictSource, remote: SyncConflictSource): boolean => {
  const localValue = businessRecord(local)
  const remoteValue = businessRecord(remote)
  for (const rule of ['settlementMode', 'defaultAmountBasis']) {
    if (localValue[rule] == null || remoteValue[rule] == null) {
      delete localValue[rule]
      delete remoteValue[rule]
    }
  }
  return stableJson(localValue) !== stableJson(remoteValue)
}

/** Archive dirty local content before an equal/newer cloud record replaces it. */
export const shouldArchiveRemoteConflict = (current: SyncConflictSource, remote: SyncConflictSource): boolean => {
  if (current.userId !== remote.userId || current.id !== remote.id || current.syncStatus === 'synced') return false
  const localTime = Date.parse(current.updatedAt)
  const remoteTime = Date.parse(remote.updatedAt)
  return Number.isFinite(localTime) && Number.isFinite(remoteTime) && remoteTime >= localTime && meaningfulRecordChanged(current, remote)
}

export const makeSyncConflict = (
  table: SyncConflictTable,
  localRecord: SyncConflictSource,
  remoteRecord: SyncConflictSource | null,
  reason: SyncConflictReason,
  message: string,
  now: string
): SyncConflictRecord => ({
  // An injective composite key avoids both random retry duplicates and hash collisions.
  id: stableJson([localRecord.userId, table, localRecord.id, localRecord.updatedAt]),
  userId: localRecord.userId,
  table,
  recordId: localRecord.id,
  reason,
  message,
  localRecord: structuredClone(localRecord),
  remoteRecord: remoteRecord ? structuredClone(remoteRecord) : null,
  createdAt: now,
  resolvedAt: null
})

/** Fingerprint what the user submitted, before mutable catalogue defaults are applied. */
export const ticketCreateFingerprint = (input: TicketInput): string => stableJson({
  guestName: input.guestName?.trim() ?? '',
  issueDate: input.issueDate.trim(),
  issueTime: normalizedTime(input.issueTime),
  supplierName: normalizeSupplier(input.supplierName),
  projectId: input.projectId,
  projectName: cleanProjectLabel(input.projectName.trim()),
  subItemName: cleanProjectLabel(input.subItemName.trim()),
  amountBasis: input.amountBasis ?? null,
  quantityUnit: input.quantityUnit ?? 'person',
  personCount: input.personCount ?? null,
  entryMode: input.entryMode ?? 'standard',
  settlementMode: input.settlementMode ?? null,
  agentPriceThb: input.agentPriceThb,
  costThb: input.costThb,
  manualProfitThb: input.manualProfitThb ?? null,
  note: input.note.trim()
})
