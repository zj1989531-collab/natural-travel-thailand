import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { summarise, ticketsInMonth, ticketsInYear, yearDateRange } from './stats'
import { getBangkokDate } from './format'

const ticket = (id: string, overrides: Partial<TicketRecord> = {}): TicketRecord => ({ id, userId: 'test-user', issueDate: '2026-10-14', projectId: null, projectName: '测试项目', subItemName: '', supplierId: 'test-supplier', supplierName: '测试供货商', personCount: 2, amountBasis: 'per_person', agentPriceThb: 150, costThb: 100, note: '', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', deletedAt: null, syncStatus: 'synced', ...overrides })

describe('Bangkok natural-year statistics', () => {
  it('includes January 1 and December 31, excluding adjacent years and invalid dates', () => {
    const rows = ['2025-12-31', '2026-01-01', '2026-12-31', '2027-01-01', '2026-02-29', '2026-04-31'].map((date) => ticket(date, { issueDate: date }))
    expect(yearDateRange('2026')).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(ticketsInYear(rows, '2026').map((row) => row.issueDate)).toEqual(['2026-01-01', '2026-12-31'])
    expect(ticketsInYear([ticket('leap', { issueDate: '2024-02-29' })], '2024')).toHaveLength(1)
  })
  it.each(['', '26', '2026-10', '0000', ' 2026', '2026 ', 'NaN'])('rejects invalid year %s', (year) => {
    expect(() => ticketsInYear([], year)).toThrow('年份')
  })
  it('uses the Bangkok year at midnight, rather than the UTC year', () => {
    const before = getBangkokDate(new Date('2026-12-31T16:59:59Z')).slice(0, 4)
    const after = getBangkokDate(new Date('2026-12-31T17:00:00Z')).slice(0, 4)
    expect(before).toBe('2026')
    expect(after).toBe('2027')
    const rows = [ticket('old', { issueDate: '2026-12-31' }), ticket('new', { issueDate: '2027-01-01' })]
    expect(ticketsInYear(rows, before).map((row) => row.id)).toEqual(['old'])
    expect(ticketsInYear(rows, after).map((row) => row.id)).toEqual(['new'])
  })
  it('includes monthly-settlement projects, manual commissions and items, excluding deleted records', () => {
    const rows = [ticket('ordinary'), ticket('monthly', { projectName: '嘉年华', issueDate: '2026-02-01' }), ticket('commission', { entryMode: 'profit_only', manualProfitThb: 25, agentPriceThb: 0, costThb: 0, issueDate: '2026-12-31' }), ticket('item', { quantityUnit: 'item', projectName: '药品', issueDate: '2026-01-01' }), ticket('deleted', { deletedAt: '2026-10-14T01:00:00Z' })]
    expect(summarise(ticketsInYear(rows, '2026'))).toMatchObject({ count: 3, profitThb: 350 })
    const monthlyTotal = Array.from({ length: 12 }, (_, i) => summarise(ticketsInMonth(rows, `2026-${String(i + 1).padStart(2, '0')}`)).profitThb).reduce((sum, profit) => sum + profit, 0)
    expect(summarise(ticketsInYear(rows, '2026')).profitThb).toBe(monthlyTotal)
  })
  it('updates after edits and retains refund losses in the original year, not the refund year', () => {
    const original = ticket('refunded', { issueDate: '2026-12-31', refunds: [{ id: 'refund-test', userId: 'test-user', ticketId: 'refunded', personCount: 2, isFull: true, refundRevenueThb: 300, returnedCostThb: 150, refundDate: '2027-01-01', refundTime: '09:30', note: '', cancelledAt: null, createdAt: '2027-01-01T02:30:00Z', updatedAt: '2027-01-01T02:30:00Z', syncStatus: 'synced' }] })
    expect(summarise(ticketsInYear([original], '2026'))).toMatchObject({ count: 0, profitThb: -50 })
    expect(summarise(ticketsInYear([original], '2027')).profitThb).toBe(0)
    expect(summarise(ticketsInYear([{ ...original, refunds: original.refunds?.map((refund) => ({ ...refund, cancelledAt: '2027-01-02T00:00:00Z' })) }], '2026')).profitThb).toBe(100)
    expect(summarise(ticketsInYear([ticket('edit', { personCount: 3 })], '2026')).profitThb).toBe(150)
    expect(summarise(ticketsInYear([], '2026')).profitThb).toBe(0)
  })
})
