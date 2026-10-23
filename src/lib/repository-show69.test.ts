import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { assertLedgerOwner, type LedgerOwnerContext, type TicketCreateOperation } from './ledger-account'

const state = vi.hoisted(() => ({
  settings: { localUserId: 'local-user', lastCloudUserId: null as string | null, activeCloudUserId: null as string | null },
  suppliers: new Map<string, Supplier>(), projects: new Map<string, Project>(), tickets: new Map<string, TicketRecord>(),
  refunds: [] as RefundRecord[], operations: new Map<string, TicketCreateOperation>(),
  beforeTicketWrite: null as null | (() => Promise<void>), beforeProjectRead: null as null | (() => Promise<void>)
}))
const copy = <T,>(value: T): T => structuredClone(value)
const guard = (owner: LedgerOwnerContext, userId = owner.userId) => assertLedgerOwner(state.settings, owner, userId)
const key = (owner: LedgerOwnerContext, id: string) => JSON.stringify([owner.userId, id])

vi.mock('./supabase', () => ({ getSupabase: () => ({}) }))
vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ ...state.settings }), getOrCreateSettings: async () => ({ ...state.settings }),
  activateAccount: async (userId: string | null, cloud: boolean, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error('账号已切换')
    state.settings.activeCloudUserId = cloud ? userId : null
    state.settings.lastCloudUserId = userId
    return { ...state.settings }
  },
  getSuppliers: async () => [...state.suppliers.values()].map(copy),
  getProjects: async () => { await state.beforeProjectRead?.(); return [...state.projects.values()].map(copy) },
  putSupplier: async (row: Supplier, owner: LedgerOwnerContext) => { guard(owner, row.userId); state.suppliers.set(row.id, copy(row)) },
  putProject: async (row: Project, owner: LedgerOwnerContext) => { guard(owner, row.userId); state.projects.set(row.id, copy(row)) },
  getTicket: async (id: string) => { const row = state.tickets.get(id); return row && copy(row) },
  getRefunds: async () => state.refunds.map(copy),
  putTicket: async (row: TicketRecord, owner: LedgerOwnerContext) => { await state.beforeTicketWrite?.(); guard(owner, row.userId); state.tickets.set(row.id, copy(row)) },
  getTicketCreateOperation: async (id: string, owner: LedgerOwnerContext) => {
    guard(owner)
    const receipt = state.operations.get(key(owner, id))
    return receipt && { receipt: copy(receipt), ticket: copy(state.tickets.get(receipt.ticketId) ?? receipt.acceptedRecord) }
  },
  putNewTicketOnce: async (row: TicketRecord, fingerprint: string, owner: LedgerOwnerContext) => {
    await state.beforeTicketWrite?.()
    guard(owner, row.userId)
    const receipt = state.operations.get(key(owner, row.id))
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('这次提交已经保存过不同内容')
      return copy(state.tickets.get(receipt.ticketId) ?? receipt.acceptedRecord)
    }
    if (state.tickets.has(row.id)) throw new Error('此提交编号已有其他记录')
    state.tickets.set(row.id, copy(row))
    state.operations.set(key(owner, row.id), { id: key(owner, row.id), userId: owner.userId, ticketId: row.id, fingerprint, acceptedRecord: copy(row) })
    return copy(row)
  }
} }))

import { ledgerRepository } from './repository'

const input = { date: '2026-10-23', guestName: '韩廷富,邵建华,江华兴', people: 3 }
const historical = (): TicketRecord => ({
  id: 'old69', userId: 'user-1', issueDate: '2026-10-22', issueTime: '17:45', guestName: '旧姓名', personCount: 2,
  supplierId: 'old-supplier', supplierName: '原供货商', projectId: null, projectName: '69成人秀', subItemName: '旧套餐',
  agentPriceThb: 1300, costThb: 1100, amountBasis: 'total', entryMode: 'standard', quantityUnit: 'person',
  settlementMode: 'daily', manualProfitThb: null, note: '保留原始财务快照',
  createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', deletedAt: null, syncStatus: 'synced'
})

beforeEach(async () => {
  vi.useRealTimers()
  state.suppliers.clear(); state.projects.clear(); state.tickets.clear(); state.operations.clear()
  state.refunds = []; state.beforeTicketWrite = null; state.beforeProjectRead = null
  await ledgerRepository.activateAccount(null)
  await ledgerRepository.activateAccount('user-1')
})

describe('69秀 independent record persistence', () => {
  it('accepts the three record fields without a user-selected catalogue or monetary input', async () => {
    const record = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'save69')
    expect(record).toMatchObject({ id: 'save69', userId: 'user-1', issueDate: input.date, guestName: input.guestName, personCount: 3, projectName: '69秀', subItemName: '独立记录', agentPriceThb: 0, costThb: 0, entryMode: 'standard', quantityUnit: 'person', settlementMode: 'monthly', syncStatus: 'pending' })
    expect(record.issueTime).toMatch(/^\d{2}:\d{2}$/)
    expect(state.suppliers.size).toBe(1)
    expect(state.projects.size).toBe(1)
    expect(state.tickets.size).toBe(1)
  })

  it('deduplicates concurrent saves and retries after time or catalogue changes', async () => {
    const [first, concurrent] = await Promise.all([
      ledgerRepository.createOrUpdateShow69Record(input, undefined, 'same-operation'),
      ledgerRepository.createOrUpdateShow69Record(input, undefined, 'same-operation')
    ])
    expect(concurrent).toEqual(first)
    expect(state.suppliers.size).toBe(1)
    expect(state.projects.size).toBe(1)
    expect(state.tickets.size).toBe(1)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T12:00:00Z'))
    state.suppliers.clear(); state.projects.clear()
    expect(await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'same-operation')).toEqual(first)
    expect(state.suppliers.size).toBe(0)
    await expect(ledgerRepository.createOrUpdateShow69Record({ ...input, people: 4 }, undefined, 'same-operation')).rejects.toThrow('不同内容')
    expect(state.tickets.size).toBe(1)
  })

  it('changes only the requested fields on a historical record with no remaining catalogue', async () => {
    const original = historical()
    state.tickets.set(original.id, original)
    const updated = await ledgerRepository.createOrUpdateShow69Record(input, original)
    expect(updated).toEqual({ ...original, issueDate: input.date, guestName: input.guestName, personCount: input.people, updatedAt: updated.updatedAt, syncStatus: 'pending', refunds: [] })
    expect(updated.updatedAt).not.toBe(original.updatedAt)
    expect(state.suppliers.size).toBe(0)
    expect(state.projects.size).toBe(0)
  })

  it('rejects editing a refunded record, including a cancelled refund', async () => {
    const original = historical()
    state.tickets.set(original.id, original)
    state.refunds.push({ id: 'refund', userId: 'user-1', ticketId: original.id, cancelledAt: '2026-10-23T00:00:00Z' } as RefundRecord)
    await expect(ledgerRepository.createOrUpdateShow69Record(input, original)).rejects.toThrow('已有退票')
    expect(state.tickets.get(original.id)).toEqual(original)
  })

  it('does not resurrect a deleted record or overwrite a stale financial snapshot', async () => {
    const stale = historical()
    const current = { ...stale, agentPriceThb: 1500, note: '另一台设备已更新' }
    state.tickets.set(current.id, current)
    const updated = await ledgerRepository.createOrUpdateShow69Record(input, stale)
    expect(updated.agentPriceThb).toBe(1500)
    expect(updated.note).toBe(current.note)
    const deleted = { ...updated, deletedAt: '2026-10-23T00:00:00Z' }
    state.tickets.set(current.id, deleted)
    await expect(ledgerRepository.createOrUpdateShow69Record(input, stale)).rejects.toThrow('无法编辑')
    expect(state.tickets.get(current.id)).toEqual(deleted)
  })

  it('keeps a pending save pinned to the initiating account when account switches before storage', async () => {
    state.beforeTicketWrite = () => ledgerRepository.activateAccount('user-2')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, undefined, 'switch-operation')).rejects.toThrow('账号已切换')
    expect(state.tickets.size).toBe(0)
    expect(state.operations.size).toBe(0)
    expect([...state.suppliers.values()].every(row => row.userId === 'user-1')).toBe(true)
  })

  it('does not create a project for the new account if account switches during catalogue preparation', async () => {
    state.beforeProjectRead = () => ledgerRepository.activateAccount('user-2')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, undefined, 'catalogue-switch')).rejects.toThrow('账号已切换')
    expect(state.projects.size).toBe(0)
    expect(state.tickets.size).toBe(0)
  })

  it('rejects foreign edits and operation IDs while giving each account its own catalogue', async () => {
    const first = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'account-operation')
    await ledgerRepository.activateAccount('user-2')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, first)).rejects.toThrow('当前账号')
    await expect(ledgerRepository.createOrUpdateShow69Record(input, undefined, 'account-operation')).rejects.toThrow('提交编号已有其他记录')
    const second = await ledgerRepository.createOrUpdateShow69Record(input, undefined, 'second-operation')
    expect(second.userId).toBe('user-2')
    expect(second.supplierId).not.toBe(first.supplierId)
    expect(second.projectId).not.toBe(first.projectId)
    expect(state.tickets.get(first.id)?.userId).toBe('user-1')
  })
})
