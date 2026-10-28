import { describe, expect, it, vi } from 'vitest'
import type { RefundInput, RefundRecord, TicketRecord } from '../types'
import { attachRefunds, getEffectivePersonCount, getRefundState } from './refunds'
import { defaultRefundAmounts, validateRefundInput } from './refund-input'
import { getOriginalTicketAmounts, getTicketAmounts } from './ticket-amounts'
import { summarise, ticketsForDailyStats, ticketsInMonth, bySupplier } from './stats'
import { buildReport } from './reports'
import { buildTicketExportRows, createLedgerBackup } from './export'
import { isValidCalendarDate } from './format'
import { buildShow79Report } from './show79'

const ticket: TicketRecord = { id: 't1', userId: 'u1', issueDate: '2026-09-30', issueTime: '23:59', supplierId: 's1', supplierName: '测试', projectId: null, projectName: '普通门票', subItemName: '', personCount: 3, amountBasis: 'per_person', agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-09-30T16:59:00Z', updatedAt: '2026-09-30T16:59:00Z', syncStatus: 'synced', deletedAt: null }
const refund: RefundRecord = { id: 'r1', userId: ticket.userId, ticketId: ticket.id, personCount: 1, isFull: false, refundRevenueThb: 650, returnedCostThb: 550, refundDate: '2026-10-01', refundTime: '00:01', note: '手续费50', cancelledAt: null, createdAt: '2026-09-30T17:01:00Z', updatedAt: '2026-09-30T17:01:00Z', syncStatus: 'synced' }
const input: RefundInput = { ...refund, operationId: refund.id }
const projected = (rows: RefundRecord[] = [refund], original = ticket) => attachRefunds([original], rows)[0]

describe('refund amounts, quantities and original-period accounting', () => {
  it('keeps original prices and quantities while deducting actual refunds only once', () => {
    const row = projected()
    expect(getEffectivePersonCount(row)).toBe(2)
    expect(getTicketAmounts(row)).toEqual({ agentPriceThb: 1300, costThb: 1250, profitThb: 50 })
    expect(getOriginalTicketAmounts(row).profitThb).toBe(150)
    expect(ticket.refunds).toBeUndefined()
    expect(row.personCount).toBe(3)
    expect(getRefundState(row).full).toBe(false)
    expect(defaultRefundAmounts(row, true, 1)).toEqual({ refundRevenueThb: 1300, returnedCostThb: 1200 })
    expect(defaultRefundAmounts(row, false, 1)).toEqual({ refundRevenueThb: 650, returnedCostThb: 600 })
  })
  it('does not erase a previous supplier fee when refunding the remaining people at default prices', () => {
    const defaults = defaultRefundAmounts(projected(), true, 1)
    const row = projected([refund, { ...refund, id: 'r2', personCount: 2, isFull: true, ...defaults }])
    expect(getRefundState(row).remainingPeople).toBe(0)
    expect(getTicketAmounts(row)).toEqual({ agentPriceThb: 0, costThb: 50, profitThb: -50 })
  })
  it('keeps losses when every ticket is refunded but the supplier returns no cost', () => {
    const row = projected([{ ...refund, personCount: 3, isFull: true, refundRevenueThb: 1950, returnedCostThb: 0 }])
    expect(getEffectivePersonCount(row)).toBe(0)
    expect(summarise([row])).toEqual({ count: 0, agentPriceThb: 0, costThb: 1800, profitThb: -1800 })
    expect(bySupplier([row])[0]).toMatchObject({ count: 0, profitThb: -1800 })
    expect(getRefundState(row).full).toBe(true)
    expect(() => validateRefundInput(row, { ...input, operationId: 'second' })).toThrow('全部退票')
  })
  it('recalculates the original day and month, not the refund date across midnight/month-end', () => {
    const row = projected()
    expect(summarise(ticketsForDailyStats([row], '2026-09-30')).profitThb).toBe(50)
    expect(summarise(ticketsForDailyStats([row], '2026-10-01')).profitThb).toBe(0)
    expect(summarise(ticketsInMonth([row], '2026-09')).profitThb).toBe(50)
    expect(summarise(ticketsInMonth([row], '2026-10')).profitThb).toBe(0)
    const report = buildReport([row], { mode: 'month', month: '2026-09', date: '2026-09-30', startDate: '2026-09-01', endDate: '2026-09-30', supplierId: '', projectName: ticket.projectName })
    expect(report.quantity).toMatchObject({ recordCount: 1, peopleCount: 2, unknownCount: 0 })
    expect(report.summary.profitThb).toBe(50)
    expect(report.quantity.days).toEqual([{ date: '2026-09-30', recordCount: 1, peopleCount: 2, unknownCount: 0 }])
    const monthlyOnly = { ...row, projectName: '嘉年华' }
    expect(summarise(ticketsForDailyStats([monthlyOnly], row.issueDate)).profitThb).toBe(0)
    expect(summarise(ticketsInMonth([monthlyOnly], '2026-09')).profitThb).toBe(0)
    const independentReport = buildReport([monthlyOnly], { mode: 'month', month: '2026-09', date: '2026-09-30', startDate: '2026-09-01', endDate: '2026-09-30', supplierId: '' })
    expect(independentReport).toMatchObject({ records: [], summary: { profitThb: 0 }, quantity: { recordCount: 0 } })
  })
  it('retains voided history but restores all quantities and money', () => {
    const row = projected([{ ...refund, cancelledAt: '2026-10-02T00:00:00Z' }])
    expect(getRefundState(row)).toMatchObject({ full: false, remainingPeople: 3, refundedPeople: 0, refundRevenueThb: 0, returnedCostThb: 0 })
    expect(getRefundState(row).history).toHaveLength(1)
    expect(getTicketAmounts(row).profitThb).toBe(150)
  })
  it('does not multiply legacy whole-order amounts by recorded headcount', () => {
    const whole = { ...ticket, amountBasis: undefined, agentPriceThb: 1950, costThb: 1800 }
    expect(defaultRefundAmounts(whole, false, 1)).toEqual({ refundRevenueThb: 650, returnedCostThb: 600 })
    expect(getTicketAmounts(projected([refund], whole)).profitThb).toBe(50)
  })
  it('handles unknown old headcounts only as full refunds, without inventing quantities', () => {
    const unknown = { ...ticket, personCount: null, amountBasis: 'total' as const }
    expect(() => validateRefundInput(unknown, input)).toThrow('人数未知')
    expect(validateRefundInput(unknown, { ...input, isFull: true, personCount: null })).toEqual({ personCount: null, isFull: true })
    expect(getEffectivePersonCount(projected([{ ...refund, isFull: true, personCount: null }], unknown))).toBe(0)
  })
  it('never attaches other-user or unrelated-ticket refund data', () => {
    const row = projected([{ ...refund, userId: 'other' }, { ...refund, id: 'r2', ticketId: 'other' }])
    expect(row.refunds).toEqual([])
    expect(getRefundState({ ...ticket, refunds: [{ ...refund, userId: 'other' }] }).active).toEqual([])
  })
  it.each([
    { personCount: 0 }, { personCount: 1.5 }, { personCount: 4 },
    { refundRevenueThb: -1 }, { refundRevenueThb: NaN }, { refundRevenueThb: Infinity },
    { refundRevenueThb: 1951 }, { returnedCostThb: 1801 }, { returnedCostThb: 550.001 },
    { refundDate: '2026-10-17' }, { refundDate: '2026-02-30' }, { refundDate: '2026-13-01' },
    { refundTime: '24:00' }, { refundTime: '' }, { ticketId: 'other' }
  ])('rejects invalid inputs %j', (override) => {
    expect(() => validateRefundInput(ticket, { ...input, ...override }, '2026-10-16')).toThrow()
  })
  it('permits actual refunds before a future viewing date while keeping 79 profit in the original month', () => {
    const future = { ...ticket, projectName: '79秀', issueDate: '2026-11-20' }
    const actualRefund = { ...refund, refundDate: '2026-10-16' }
    expect(validateRefundInput(future, { ...input, refundDate: actualRefund.refundDate }, '2026-10-16')).toEqual({ personCount: 1, isFull: false })
    const row = projected([actualRefund], future)
    expect(row.issueDate).toBe('2026-11-20')
    expect(row.refunds?.[0].refundDate).toBe('2026-10-16')
    expect(buildShow79Report([row], '2026-11-20', '2026-11')).toMatchObject({ profitThb: 50, monthPeople: 2, jimmyThb: 20, partnersThb: 30 })
    expect(buildShow79Report([row], '2026-10-16', '2026-10')).toMatchObject({ profitThb: 0, monthPeople: 0 })
  })
  it('accepts earlier actual dates and leap days but rejects future or impossible refund days', () => {
    for (const refundDate of ['2026-09-29', '2024-02-29', '2026-10-16']) expect(() => validateRefundInput(ticket, { ...input, refundDate }, '2026-10-16')).not.toThrow()
    for (const refundDate of ['2026-10-17', '2026-02-29', '2026-04-31', '', '2026/10/16']) expect(() => validateRefundInput(ticket, { ...input, refundDate }, '2026-10-16')).toThrow('退款日期')
  })
  it('uses Bangkok midnight for the maximum actual refund date independently of the browser zone', () => {
    vi.useFakeTimers()
    try {
      const nextDay = { ...input, refundDate: '2026-10-17' }
      vi.setSystemTime(new Date('2026-10-16T16:59:59Z'))
      expect(() => validateRefundInput(ticket, nextDay)).toThrow('退款日期')
      vi.setSystemTime(new Date('2026-10-16T17:00:00Z'))
      expect(() => validateRefundInput(ticket, nextDay)).not.toThrow()
    } finally { vi.useRealTimers() }
  })
  it('validates against remaining quantity and money after previous refunds', () => {
    expect(() => validateRefundInput(projected(), { ...input, personCount: 3 })).toThrow('剩余人数')
    expect(() => validateRefundInput(projected(), { ...input, refundRevenueThb: 1301 })).toThrow('剩余金额')
    expect(validateRefundInput(projected(), { ...input, personCount: 2, refundRevenueThb: 1300, returnedCostThb: 1250 })).toEqual({ personCount: 2, isFull: true })
    expect(() => validateRefundInput({ ...ticket, deletedAt: ticket.updatedAt }, input)).toThrow('有效')
    expect(() => validateRefundInput({ ...ticket, entryMode: 'profit_only' }, input)).toThrow('仅录利润')
  })
  it('exports net money alongside original prices, quantities and independent refund history', () => {
    const row = projected()
    expect(buildTicketExportRows([row])[0]).toMatchObject({ '人数': 3, '有效人数': 2, '退票状态': '部分退票', '代理售价 (THB)': 1300, '供货商成本 (THB)': 1250, '利润 (THB)': 50, '原始利润 (THB)': 150, '累计退代理 (THB)': 650, '累计成本返还 (THB)': 550 })
    const backup = createLedgerBackup({ suppliers: [], projects: [], tickets: [row], refunds: [{ ...refund, access_token: 'never-export' } as RefundRecord] })
    expect(backup.refunds).toEqual([refund])
    expect(backup.tickets[0].agentPriceThb).toBe(650)
    expect(backup.tickets[0]).not.toHaveProperty('refunds')
    expect(JSON.stringify(backup)).not.toContain('never-export')
    expect(() => createLedgerBackup({ suppliers: [], projects: [], tickets: [row], refunds: [{ ...refund, userId: 'other' }] })).toThrow('账号正在切换')
  })
  it('validates leap days as real dates', () => {
    expect(isValidCalendarDate('2024-02-29')).toBe(true)
    expect(isValidCalendarDate('2026-02-29')).toBe(false)
    expect(isValidCalendarDate('2026-04-31')).toBe(false)
  })
})
