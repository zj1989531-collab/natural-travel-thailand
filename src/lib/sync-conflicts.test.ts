import { describe, expect, it } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketInput, TicketRecord } from '../types'
import { makeSyncConflict, meaningfulRecordChanged, shouldArchiveRemoteConflict, ticketCreateFingerprint } from './sync-conflicts'

const timestamp = '2026-10-16T08:00:00.000Z'
const ticket = (extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id: 'ticket-1', userId: 'owner', supplierId: 'supplier-1', supplierName: 'Natural Travel', projectId: 'project-1', projectName: '79秀', subItemName: '门票',
  issueDate: '2026-10-16', personCount: 2, agentPriceThb: 500, costThb: 450, note: '', deletedAt: null,
  createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending', ...extra
})
const supplier = (extra: Partial<Supplier> = {}): Supplier => ({
  id: 'supplier-1', userId: 'owner', name: 'Natural Travel', normalizedName: 'natural travel',
  createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending', ...extra
})
const project = (extra: Partial<Project> = {}): Project => ({
  id: 'project-1', userId: 'owner', supplierId: 'supplier-1', supplierName: 'Natural Travel', name: '79秀', normalizedName: '79秀', subItemName: '门票', normalizedSubItemName: '门票',
  defaultAgentPriceThb: 500, defaultCostThb: 450, createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending', ...extra
})
const refund = (extra: Partial<RefundRecord> = {}): RefundRecord => ({
  id: 'refund-1', userId: 'owner', ticketId: 'ticket-1', personCount: 1, isFull: false, refundRevenueThb: 500, returnedCostThb: 450,
  refundDate: '2026-10-16', refundTime: '15:00', note: '', cancelledAt: null,
  createdAt: timestamp, updatedAt: timestamp, syncStatus: 'pending', ...extra
})
const input = (extra: Partial<TicketInput> = {}): TicketInput => ({
  issueDate: '2026-10-16', issueTime: '15:00', supplierName: 'Natural Travel', projectId: 'project-1', projectName: '79秀', subItemName: '门票',
  personCount: 2, agentPriceThb: 500, costThb: 450, note: '', ...extra
})

describe('recoverable sync conflict snapshots', () => {
  it('deduplicates retries by local version, independent of remote changes, reason or detection time', () => {
    const local = ticket()
    const first = makeSyncConflict('tickets', local, ticket({ costThb: 400 }), 'remote_newer', '远端已修改', timestamp)
    const retried = makeSyncConflict('tickets', local, null, 'upload_rejected', '稍后重试', '2026-10-17T00:00:00Z')
    expect(retried.id).toBe(first.id)
    expect(first).toMatchObject({ userId: 'owner', table: 'tickets', recordId: local.id, reason: 'remote_newer', createdAt: timestamp, resolvedAt: null })
  })
  it('keeps a separate snapshot for every owner, record, table and edited version', () => {
    const key = (value = ticket(), table: 'tickets' | 'projects' = 'tickets') => makeSyncConflict(table, value, null, 'upload_rejected', '', timestamp).id
    expect(new Set([key(), key(ticket({ userId: 'other' })), key(ticket({ id: 'ticket-2' })), key(ticket({ updatedAt: '2026-10-16T08:00:01Z' })), key(ticket(), 'projects')]).size).toBe(5)
  })
  it('copies original local and remote records without mutating or automatically restoring either', () => {
    const local = ticket({ refunds: [refund()] })
    const remote = ticket({ guestName: '云端客户' })
    const archived = makeSyncConflict('tickets', local, remote, 'refund_locked', '原票已有退款', timestamp)
    local.note = '后来修改'; local.refunds![0].note = '后来退款'; remote.guestName = '另一客户'
    expect((archived.localRecord as TicketRecord).note).toBe('')
    expect((archived.localRecord as TicketRecord).refunds![0].note).toBe('')
    expect((archived.remoteRecord as TicketRecord).guestName).toBe('云端客户')
    expect(local.syncStatus).toBe('pending')
  })
})

describe('business changes versus transport metadata', () => {
  it('ignores sync markers, timestamps, attached refund history and property ordering', () => {
    const local = ticket()
    const remote = Object.fromEntries(Object.entries(ticket({ syncStatus: 'synced', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', refunds: [refund()] })).reverse()) as unknown as TicketRecord
    expect(meaningfulRecordChanged(local, remote)).toBe(false)
  })
  it('normalizes legacy missing ticket defaults and equivalent zero-second times', () => {
    expect(meaningfulRecordChanged(ticket(), ticket({ guestName: '', amountBasis: 'total', quantityUnit: 'person', entryMode: 'standard', manualProfitThb: null, issueTime: null }))).toBe(false)
    expect(meaningfulRecordChanged(ticket({ personCount: undefined, issueTime: '15:00' }), ticket({ personCount: null, issueTime: '15:00:00.000' }))).toBe(false)
  })
  it('does not infer a rule change when an old client omitted optional settlement/catalogue rules', () => {
    expect(meaningfulRecordChanged(ticket(), ticket({ settlementMode: 'monthly' }))).toBe(false)
    expect(meaningfulRecordChanged(ticket({ settlementMode: null }), ticket({ settlementMode: 'daily' }))).toBe(false)
    expect(meaningfulRecordChanged(project(), project({ defaultAmountBasis: 'per_person', settlementMode: 'monthly', entryMode: 'standard', quantityUnit: 'person', manualAgentPrice: false }))).toBe(false)
  })
  it('still detects changes between two explicit settlement or amount rules', () => {
    expect(meaningfulRecordChanged(ticket({ settlementMode: 'daily' }), ticket({ settlementMode: 'monthly' }))).toBe(true)
    expect(meaningfulRecordChanged(project({ defaultAmountBasis: 'total' }), project({ defaultAmountBasis: 'per_person' }))).toBe(true)
  })
  it.each([
    { guestName: 'Jimmy' }, { agentPriceThb: 501 }, { costThb: 449 }, { personCount: 3 }, { issueDate: '2026-10-17' },
    { issueTime: '15:01' }, { projectId: 'another-project' }, { supplierId: 'another-supplier' }, { subItemName: 'VIP' },
    { note: '待联系' }, { deletedAt: '2026-10-17T00:00:00Z' }, { amountBasis: 'per_person' },
    { quantityUnit: 'item' }, { entryMode: 'profit_only', manualProfitThb: 50 }
  ] satisfies Partial<TicketRecord>[] )('detects a genuine ticket edit: %j', (edit) => {
    expect(meaningfulRecordChanged(ticket(), ticket(edit))).toBe(true)
  })
  it('ignores catalogue indexes and local merge pointers but preserves real supplier/project edits', () => {
    expect(meaningfulRecordChanged(supplier(), supplier({ normalizedName: 'stale-index', mergedIntoId: 'canonical' }))).toBe(false)
    expect(meaningfulRecordChanged(supplier(), supplier({ name: '另一供货商' }))).toBe(true)
    expect(meaningfulRecordChanged(project(), project({ normalizedName: 'stale', normalizedSubItemName: 'stale', mergedIntoId: 'canonical' }))).toBe(false)
    expect(meaningfulRecordChanged(project(), project({ defaultCostThb: 400 }))).toBe(true)
  })
  it('detects refund cancellation, values and original-ticket identity changes', () => {
    expect(meaningfulRecordChanged(refund(), refund({ syncStatus: 'synced', updatedAt: '2026-10-17T00:00:00Z', refundTime: '15:00:00' }))).toBe(false)
    expect(meaningfulRecordChanged(refund(), refund({ cancelledAt: '2026-10-17T00:00:00Z' }))).toBe(true)
    expect(meaningfulRecordChanged(refund(), refund({ refundRevenueThb: 499 }))).toBe(true)
    expect(meaningfulRecordChanged(refund(), refund({ ticketId: 'ticket-2' }))).toBe(true)
  })
})

describe('archive only local edits about to be replaced', () => {
  it('archives equal-version different content as well as newer remote content', () => {
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400 }))).toBe(true)
    expect(shouldArchiveRemoteConflict(ticket({ syncStatus: 'error' }), ticket({ costThb: 400, updatedAt: '2026-10-17T00:00:00Z' }))).toBe(true)
  })
  it('compares timestamp instants rather than timezone spelling', () => {
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400, updatedAt: '2026-10-16T15:00:00+07:00' }))).toBe(true)
  })
  it('does not archive synced, unchanged, older, foreign-account or unrelated records', () => {
    expect(shouldArchiveRemoteConflict(ticket({ syncStatus: 'synced' }), ticket({ costThb: 400 }))).toBe(false)
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ syncStatus: 'synced', updatedAt: '2026-10-17T00:00:00Z' }))).toBe(false)
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400, updatedAt: '2026-10-15T00:00:00Z' }))).toBe(false)
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400, userId: 'other' }))).toBe(false)
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400, id: 'ticket-2' }))).toBe(false)
    expect(shouldArchiveRemoteConflict(ticket(), ticket({ costThb: 400, updatedAt: 'invalid' }))).toBe(false)
  })
})

describe('stable ticket create input fingerprints', () => {
  it('normalizes boundary whitespace, supplier case/spacing, adult aliases and missing harmless defaults', () => {
    const original = input({ guestName: 'Jimmy', note: '接送', projectName: '79秀', subItemName: '门票', issueTime: '15:00' })
    const equivalent = input({ guestName: ' Jimmy ', note: ' 接送 ', supplierName: ' NATURAL   TRAVEL ', projectName: ' 79成人秀 ', subItemName: ' 成人门票 ', issueTime: '15:00:00', entryMode: 'standard', quantityUnit: 'person', manualProfitThb: null })
    expect(ticketCreateFingerprint(equivalent)).toBe(ticketCreateFingerprint(original))
  })
  it('preserves unspecified pricing rather than replacing it with mutable catalogue defaults', () => {
    expect(ticketCreateFingerprint(input())).not.toBe(ticketCreateFingerprint(input({ amountBasis: 'total' })))
    expect(ticketCreateFingerprint(input())).not.toBe(ticketCreateFingerprint(input({ amountBasis: 'per_person' })))
    expect(ticketCreateFingerprint(input())).toBe(ticketCreateFingerprint(input({ amountBasis: undefined })))
  })
  it('normalizes absent quantities/times/names and does not mutate the submitted input', () => {
    const missing = input({ personCount: undefined, issueTime: undefined })
    const prior = structuredClone(missing)
    expect(ticketCreateFingerprint(missing)).toBe(ticketCreateFingerprint(input({ personCount: null, issueTime: '', guestName: '' })))
    expect(missing).toEqual(prior)
  })
  it.each([
    { guestName: 'Aditya' }, { issueDate: '2026-10-17' }, { issueTime: '16:00' }, { supplierName: 'Other Travel' },
    { projectId: 'project-2' }, { projectName: '69秀' }, { subItemName: 'VIP' }, { personCount: 3 },
    { agentPriceThb: 501 }, { costThb: 449 }, { manualProfitThb: 50 }, { entryMode: 'profit_only' },
    { quantityUnit: 'item' }, { settlementMode: 'monthly' }, { note: '待收款' }
  ] satisfies Partial<TicketInput>[])('gives a materially different submission its own operation: %j', (edit) => {
    expect(ticketCreateFingerprint(input(edit))).not.toBe(ticketCreateFingerprint(input()))
  })
})
