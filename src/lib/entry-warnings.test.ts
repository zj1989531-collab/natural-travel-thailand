import { describe, expect, it } from 'vitest'
import type { Project, RefundRecord, TicketInput, TicketRecord } from '../types'
import { projectPriceWarnings, ticketWarnings, validateDraftAmounts } from './entry-warnings'

const project = { id: 'p', userId: 'u', supplierId: 's' } as Project
const input: TicketInput = { issueDate: '2026-10-15', issueTime: '09:30', personCount: 2, amountBasis: 'per_person', projectId: 'p', projectName: '景点', subItemName: '普通票', supplierName: '供货商', agentPriceThb: 105.05, costThb: 95.01, note: '' }
const ticket: TicketRecord = { ...input, id: 't', userId: 'u', supplierId: 's', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', deletedAt: null, syncStatus: 'pending' }
const refund: RefundRecord = { id: 'r', userId: 'u', ticketId: 't', personCount: 1, isFull: false, refundRevenueThb: 105.05, returnedCostThb: 95.01, refundDate: '2026-10-15', refundTime: '10:00', note: '', createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, cancelledAt: null, syncStatus: 'synced' }

describe('advisory duplicate and loss checks', () => {
  it('ignores time and notes; compares original totals in cents even with a different pricing basis', () => {
    const check = ticketWarnings({ ...input, issueTime: '20:00', note: '另一位旅客' }, project, [{ ...ticket, amountBasis: 'total', agentPriceThb: 210.10, costThb: 190.02 }])
    expect(check.messages).toHaveLength(1)
    expect(check.messages[0]).toContain('可能重复')
    expect(ticketWarnings({ ...input, agentPriceThb: 105.06 }, project, [ticket]).messages).toHaveLength(0)
  })
  it.each([
    { userId: 'other' }, { supplierId: 'other' }, { projectId: 'other' }, { issueDate: '2026-10-14' }, { personCount: 3 }, { quantityUnit: 'item' }, { entryMode: 'profit_only', manualProfitThb: 20.08 }, { deletedAt: '2026-10-15T01:00:00Z' }
  ] as Partial<TicketRecord>[])('does not match a different field or deleted record: %j', patch => {
    expect(ticketWarnings(input, project, [{ ...ticket, ...patch }]).messages).toHaveLength(0)
  })
  it('excludes the edited record and fully refunded records, but uses original amounts after a partial refund', () => {
    expect(ticketWarnings(input, project, [ticket], ticket.id).messages).toHaveLength(0)
    expect(ticketWarnings(input, project, [{ ...ticket, refunds: [refund] }]).messages).toHaveLength(1)
    expect(ticketWarnings(input, project, [{ ...ticket, refunds: [{ ...refund, isFull: true, personCount: 2 }] }]).messages).toHaveLength(0)
    expect(ticketWarnings(input, project, [{ ...ticket, refunds: [{ ...refund, isFull: true, personCount: 2, cancelledAt: '2026-10-15T02:00:00Z' }] }]).messages).toHaveLength(1)
  })
  it('compares profit-only totals, not fictitious sales or costs', () => {
    const profitInput = { ...input, entryMode: 'profit_only' as const, agentPriceThb: 0, costThb: 0, manualProfitThb: 50 }
    const commission = { ...ticket, ...profitInput, amountBasis: 'total' as const, manualProfitThb: 100 }
    expect(ticketWarnings(profitInput, project, [commission]).messages).toHaveLength(1)
    expect(ticketWarnings({ ...profitInput, manualProfitThb: 50.01 }, project, [commission]).messages).toHaveLength(0)
  })
  it('combines duplicate and exact total loss warnings, and changes acknowledgement after any edit', () => {
    const losing = { ...input, agentPriceThb: 90.01, costThb: 95.01 }
    const check = ticketWarnings(losing, project, [{ ...ticket, ...losing }])
    expect(check.messages).toHaveLength(2)
    expect(check.messages[1]).toContain('฿10.00')
    expect(ticketWarnings({ ...losing, note: '已核对' }, project, [{ ...ticket, ...losing }]).key).not.toBe(check.key)
    expect(ticketWarnings(losing, project, [{ ...ticket, ...losing, updatedAt: '2026-10-15T02:00:00Z' }]).key).not.toBe(check.key)
  })
  it('validates before warning: required, nonnegative, finite, cents precision, totals bounds', () => {
    for (const value of [NaN, Infinity, -1, 1.001]) expect(() => validateDraftAmounts({ ...input, agentPriceThb: value })).toThrow()
    expect(() => validateDraftAmounts({ ...input, manualProfitThb: null, entryMode: 'profit_only' })).toThrow()
    expect(() => validateDraftAmounts({ ...input, agentPriceThb: 999999999999.99 })).toThrow()
    expect(() => validateDraftAmounts(input)).not.toThrow()
    expect(projectPriceWarnings(95.01, 90.01, false, false)[0]).toContain('฿5.00')
    expect(projectPriceWarnings(95, 0, true, false)).toEqual([])
    expect(projectPriceWarnings(95, 0, false, true)).toEqual([])
  })
})
