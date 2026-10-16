import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefundRecord, TicketRecord } from '../types'
import type { Show79SettlementInput, Show79SettlementRecord } from './show79-settlement'

const state = vi.hoisted(() => ({
  cloudEnabled: true,
  settings: { localUserId: 'local-user', lastCloudUserId: 'owner-a' as string | null, activeCloudUserId: null as string | null },
  tickets: [] as TicketRecord[],
  refunds: [] as RefundRecord[],
  localReceipts: new Map<string, Show79SettlementRecord>(),
  cloudReceipts: new Map<string, Record<string, unknown>>(),
  confirmedWrites: [] as Show79SettlementRecord[],
  localWrites: [] as { record: Show79SettlementRecord; input: Show79SettlementInput }[],
  reads: [] as { table: string; filters: Record<string, string>; signal: AbortSignal }[],
  rpcCalls: [] as { name: string; params: Record<string, unknown>; signal: AbortSignal }[],
  rpcMode: 'success' as 'success' | 'lost-error' | 'lost-throw' | 'rejected' | 'empty',
  rpcError: '云端分账未确认，请重试。',
  rpcArray: false
}))

vi.mock('./db', () => ({ db: {
  getSettings: async () => ({ ...state.settings }),
  getOrCreateSettings: async () => ({ ...state.settings }),
  activateAccount: async (userId: string | null, cloud: boolean, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error('账号已切换')
    state.settings.activeCloudUserId = cloud ? userId : null
    if (cloud && userId) state.settings.lastCloudUserId = userId
    return { ...state.settings }
  },
  getTickets: async () => structuredClone(state.tickets),
  getRefunds: async () => structuredClone(state.refunds),
  getShow79Settlements: async () => [...state.localReceipts.values()].map(row => ({ ...row })),
  getShow79Settlement: async (id: string) => state.localReceipts.get(id),
  putConfirmedShow79Settlement: async (row: Show79SettlementRecord) => {
    state.confirmedWrites.push({ ...row })
    state.localReceipts.set(row.id, { ...row })
  },
  addLocalShow79Settlement: async (row: Show79SettlementRecord, input: Show79SettlementInput) => {
    state.localWrites.push({ record: { ...row }, input: { ...input } })
    state.localReceipts.set(row.id, { ...row })
    return { ...row }
  }
} }))

vi.mock('./supabase', () => ({ getSupabase: () => state.cloudEnabled ? {
  from: (table: string) => ({ select: () => {
    const filters: Record<string, string> = {}
    const query = {
      eq: (column: string, value: string) => { filters[column] = value; return query },
      abortSignal: async (signal: AbortSignal) => {
        state.reads.push({ table, filters: { ...filters }, signal })
        if (table !== 'show79_settlements') throw new Error(`Unexpected receipt table: ${table}`)
        return { error: null, data: [...state.cloudReceipts.values()].filter(row => Object.entries(filters).every(([column, value]) => row[column] === value)).map(row => ({ ...row })) }
      }
    }
    return query
  } }),
  rpc: (name: string, params: Record<string, unknown>) => ({ abortSignal: async (signal: AbortSignal) => {
    state.rpcCalls.push({ name, params: { ...params }, signal })
    if (state.rpcMode === 'rejected') return { data: null, error: { message: state.rpcError } }
    if (state.rpcMode === 'empty') return { data: null, error: null }
    const row = {
      id: params.p_operation_id,
      user_id: state.settings.lastCloudUserId,
      month: params.p_month,
      snapshot_profit_thb: '100.00',
      snapshot_jimmy_thb: '40.00',
      snapshot_partners_thb: '60.00',
      jimmy_paid_thb: Number(params.p_jimmy_paid_thb).toFixed(2),
      partners_paid_thb: Number(params.p_partners_paid_thb).toFixed(2),
      payment_date: params.p_payment_date,
      note: params.p_note,
      created_at: '2026-10-16T05:00:00.000Z',
      updated_at: '2026-10-16T05:00:00.000Z'
    }
    state.cloudReceipts.set(String(row.id), row)
    if (state.rpcMode === 'lost-throw') throw new Error('网络响应丢失')
    if (state.rpcMode === 'lost-error') return { data: null, error: { message: '网络响应丢失' } }
    return { data: state.rpcArray ? [row] : row, error: null }
  } })
} : null }))

import { ledgerRepository } from './repository'

const input = (overrides: Partial<Show79SettlementInput> = {}): Show79SettlementInput => ({
  operationId: 'a5000000-0000-4000-8000-000000000001', month: '2026-10', paymentDate: '2026-10-16',
  jimmyPaidThb: 40, partnersPaidThb: 60, note: '月底结清', expectedProfitThb: 100,
  expectedJimmyPaidThb: 0, expectedPartnersPaidThb: 0, ...overrides
})
const ticket = (overrides: Partial<TicketRecord> = {}): TicketRecord => ({
  id: 'show79-ticket', userId: 'owner-a', guestName: 'Jimmy', projectId: 'show79', projectName: '79秀',
  subItemName: '门票', supplierId: 'supplier-79', supplierName: '79秀官方', issueDate: '2026-10-15', issueTime: '18:30',
  personCount: 2, amountBasis: 'per_person', quantityUnit: 'person', settlementMode: 'monthly', entryMode: 'standard',
  agentPriceThb: 500, costThb: 450, note: '', deletedAt: null, syncStatus: 'synced',
  createdAt: '2026-10-15T11:30:00.000Z', updatedAt: '2026-10-15T11:30:00.000Z', ...overrides
})
const receipt = (overrides: Partial<Show79SettlementRecord> = {}): Show79SettlementRecord => ({
  id: input().operationId, userId: 'owner-a', month: '2026-10', snapshotProfitThb: 100,
  snapshotJimmyThb: 40, snapshotPartnersThb: 60, jimmyPaidThb: 40, partnersPaidThb: 60,
  paymentDate: '2026-10-16', note: '月底结清', createdAt: '2026-10-16T05:00:00.000Z',
  updatedAt: '2026-10-16T05:00:00.000Z', syncStatus: 'synced', ...overrides
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T05:00:00.000Z'))
  vi.stubGlobal('navigator', { onLine: true })
  state.cloudEnabled = true
  state.settings = { localUserId: 'local-user', lastCloudUserId: 'owner-a', activeCloudUserId: null }
  state.tickets = [ticket()]
  state.refunds = []
  state.localReceipts.clear()
  state.cloudReceipts.clear()
  state.confirmedWrites.length = 0
  state.localWrites.length = 0
  state.reads.length = 0
  state.rpcCalls.length = 0
  state.rpcMode = 'success'
  state.rpcError = '云端分账未确认，请重试。'
  state.rpcArray = false
  await ledgerRepository.activateAccount(null)
  await ledgerRepository.activateAccount('owner-a')
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('confirmed 79 show settlement repository', () => {
  it.each([false, true])('serializes the payment and deserializes the confirmed 40/60 snapshot (array=%s)', async rpcArray => {
    state.rpcArray = rpcArray
    const result = await ledgerRepository.createShow79Settlement(input())
    expect(result).toEqual(receipt())
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.rpcCalls[0]).toMatchObject({
      name: 'record_show79_settlement',
      params: {
        p_operation_id: input().operationId, p_month: '2026-10', p_payment_date: '2026-10-16',
        p_jimmy_paid_thb: 40, p_partners_paid_thb: 60, p_note: '月底结清',
        p_expected_profit_thb: 100, p_expected_jimmy_paid_thb: 0, p_expected_partners_paid_thb: 0
      }
    })
    expect(state.rpcCalls[0].signal).toBeInstanceOf(AbortSignal)
    expect(state.confirmedWrites).toEqual([receipt()])
    expect(state.localWrites).toEqual([])
    expect(state.reads.length).toBeGreaterThan(0)
    for (const read of state.reads) {
      expect(read.table).toBe('show79_settlements')
      expect(read.filters).toMatchObject({ user_id: 'owner-a', id: input().operationId })
      expect(read.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('only returns settlement history belonging to the active owner', async () => {
    state.localReceipts.set('own', receipt({ id: 'own' }))
    state.localReceipts.set('foreign', receipt({ id: 'foreign', userId: 'owner-b' }))
    expect(await ledgerRepository.getShow79Settlements()).toEqual([receipt({ id: 'own' })])
    await ledgerRepository.activateAccount(null)
    state.localReceipts.set('local', receipt({ id: 'local', userId: 'local-user' }))
    expect(await ledgerRepository.getShow79Settlements()).toEqual([])
  })

  it('requires online confirmation rather than caching a pending cloud payment', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await expect(ledgerRepository.createShow79Settlement(input())).rejects.toThrow(/联网/)
    expect(state.rpcCalls).toEqual([])
    expect(state.confirmedWrites).toEqual([])
    expect(state.localReceipts.size).toBe(0)
  })

  it.each(['lost-error', 'lost-throw'] as const)('recovers an accepted payment from its receipt after a %s response', async mode => {
    state.rpcMode = mode
    expect(await ledgerRepository.createShow79Settlement(input())).toEqual(receipt())
    expect(state.cloudReceipts.size).toBe(1)
    expect(state.localReceipts.size).toBe(1)
    expect(state.confirmedWrites).toEqual([receipt()])
    expect(state.reads.length).toBeGreaterThanOrEqual(2)
    expect(await ledgerRepository.createShow79Settlement(input())).toEqual(receipt())
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.cloudReceipts.size).toBe(1)
  })

  it.each(['rejected', 'empty'] as const)('does not cache a payment with an unconfirmed %s response', async mode => {
    state.rpcMode = mode
    await expect(ledgerRepository.createShow79Settlement(input())).rejects.toThrow()
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.localReceipts.size).toBe(0)
    expect(state.confirmedWrites).toEqual([])
    expect(state.localWrites).toEqual([])
  })

  it('returns an existing identical receipt idempotently but rejects changed payment amounts', async () => {
    const original = await ledgerRepository.createShow79Settlement(input())
    expect(await ledgerRepository.createShow79Settlement(input())).toEqual(original)
    await expect(ledgerRepository.createShow79Settlement(input({ jimmyPaidThb: 20 }))).rejects.toThrow(/编号已使用/)
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.cloudReceipts.size).toBe(1)
    expect(state.localReceipts.get(input().operationId)).toEqual(original)
  })

  it('preserves the server stale-profit or stale-payment error without recording a local success', async () => {
    state.rpcMode = 'rejected'
    state.rpcError = '利润或已付金额已变化，请刷新后重新核对。'
    await expect(ledgerRepository.createShow79Settlement(input())).rejects.toThrow(state.rpcError)
    expect(state.localReceipts.size).toBe(0)
    expect(state.confirmedWrites).toEqual([])
  })

  it.each([
    { changes: { jimmyPaidThb: -20, partnersPaidThb: 0, note: '' }, error: /备注/ },
    { changes: { jimmyPaidThb: 0, partnersPaidThb: 0 }, error: /同时为0/ }
  ])('rejects invalid payment input before any RPC: $changes', async ({ changes, error }) => {
    await expect(ledgerRepository.createShow79Settlement(input(changes))).rejects.toThrow(error)
    expect(state.rpcCalls).toEqual([])
    expect(state.localReceipts.size).toBe(0)
  })

  it('refuses to settle while a relevant 79 show ticket is not synced', async () => {
    state.tickets = [ticket({ syncStatus: 'pending' })]
    await expect(ledgerRepository.createShow79Settlement(input())).rejects.toThrow(/同步/)
    expect(state.rpcCalls).toEqual([])
    expect(state.confirmedWrites).toEqual([])
  })

  it('refuses to settle while a refund of a relevant 79 show ticket is not synced', async () => {
    state.refunds = [{
      id: 'pending-refund', userId: 'owner-a', ticketId: ticket().id, personCount: 1, isFull: false,
      refundRevenueThb: 0, returnedCostThb: 0, refundDate: '2026-10-16', refundTime: '10:00',
      note: '尚待确认', cancelledAt: null, createdAt: '2026-10-16T03:00:00.000Z',
      updatedAt: '2026-10-16T03:00:00.000Z', syncStatus: 'pending'
    }]
    await expect(ledgerRepository.createShow79Settlement(input())).rejects.toThrow(/同步/)
    expect(state.rpcCalls).toEqual([])
    expect(state.localReceipts.size).toBe(0)
  })

  it('does not block settlement because an unrelated month, project or account has pending tickets', async () => {
    state.tickets.push(ticket({ id: 'previous-month', issueDate: '2026-09-30', syncStatus: 'pending' }),
      ticket({ id: 'main-ledger', projectName: '其他门票', syncStatus: 'pending' }),
      ticket({ id: 'foreign', userId: 'owner-b', syncStatus: 'pending' }))
    expect(await ledgerRepository.createShow79Settlement(input())).toEqual(receipt())
    expect(state.rpcCalls).toHaveLength(1)
  })

  it('routes local-only settlements through the atomic local write and returns its receipt', async () => {
    state.cloudEnabled = false
    state.settings.lastCloudUserId = null
    state.tickets = [ticket({ userId: 'local-user' })]
    const result = await ledgerRepository.createShow79Settlement(input())
    expect(result).toMatchObject({ ...receipt(), userId: 'local-user' })
    expect(state.localWrites).toEqual([{ record: result, input: input() }])
    expect(state.confirmedWrites).toEqual([])
    expect(state.rpcCalls).toEqual([])
    expect(state.reads).toEqual([])
  })
})
