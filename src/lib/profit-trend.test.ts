import { describe, expect, it } from 'vitest'
import type { RefundRecord, TicketRecord } from '../types'
import { buildProfitTrend } from './profit-trend'
import { getBangkokDate } from './format'
import { summarise, ticketsInMonth } from './stats'

const ticket = (patch: Partial<TicketRecord> = {}): TicketRecord => ({ id: 't', userId: 'u', supplierId: 's', supplierName: '测试供货商', projectId: 'p', projectName: '门票', subItemName: '', issueDate: '2026-10-15', amountBasis: 'per_person', personCount: 3, agentPriceThb: 150, costThb: 100, settlementMode: 'daily', note: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deletedAt: null, syncStatus: 'synced', ...patch })
const refund: RefundRecord = { id: 'r', userId: 'u', ticketId: 't', personCount: 1, isFull: false, refundRevenueThb: 150, returnedCostThb: 80, refundDate: '2026-11-01', refundTime: '09:00', note: '', cancelledAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', syncStatus: 'synced' }

describe('profit trend ranges', () => {
  it.each([
    ['2026-10', '2026-10-15', '2026-10-15', '2026-09-01', '2026-09-15', 15, 'to_date'],
    ['2026-03', '2026-03-31', '2026-03-31', '2026-02-01', '2026-02-28', 31, 'to_date'],
    ['2024-03', '2024-03-31', '2024-03-31', '2024-02-01', '2024-02-29', 31, 'to_date'],
    ['2026-05', '2026-05-31', '2026-05-31', '2026-04-01', '2026-04-30', 31, 'to_date'],
    ['2026-01', '2026-01-01', '2026-01-01', '2025-12-01', '2025-12-01', 1, 'to_date'],
    ['2026-02', '2026-10-15', '2026-02-28', '2026-01-01', '2026-01-31', 28, 'full_month'],
    ['2024-02', '2026-10-15', '2024-02-29', '2024-01-01', '2024-01-31', 29, 'full_month'],
    ['2026-01', '2026-10-15', '2026-01-31', '2025-12-01', '2025-12-31', 31, 'full_month']
  ])('resolves %s as of %s', (month, today, currentEnd, previousStart, previousEnd, length, mode) => {
    const result = buildProfitTrend([], String(month), String(today))
    expect(result.currentRange).toEqual({ start: `${month}-01`, end: currentEnd })
    expect(result.previousRange).toEqual({ start: previousStart, end: previousEnd })
    expect(result.days).toHaveLength(Number(length)); expect(result.mode).toBe(mode)
  })
  it('ignores future, out-of-range, invalid and deleted records; includes only the comparable previous period', () => {
    const dates = ['2026-10-01', '2026-10-15', '2026-10-16', '2026-09-15', '2026-09-16', '2026-08-31', '2026-02-30']
    const rows = dates.map(issueDate => ticket({ issueDate }))
    rows.push(ticket({ deletedAt: '2026-10-15T01:00:00Z' }))
    const result = buildProfitTrend(rows, '2026-10', '2026-10-15')
    expect(result.current.totalProfitThb).toBe(300); expect(result.previous.totalProfitThb).toBe(150)
    expect(result.days[0].totalProfitThb).toBe(150); expect(result.days[1].totalProfitThb).toBe(0)
  })
  it.each([['2026-13', '2026-10-15'], ['2026-1', '2026-10-15'], ['2026-11', '2026-10-15'], ['bad', '2026-10-15'], ['2026-10', '2026-02-30']])('rejects invalid month %s or today %s', (month, today) => {
    expect(() => buildProfitTrend([], month, today)).toThrow()
  })
  it('changes periods at Bangkok midnight, including year rollover', () => {
    const before = getBangkokDate(new Date('2026-12-31T16:59:59Z'))
    const after = getBangkokDate(new Date('2026-12-31T17:00:00Z'))
    expect(buildProfitTrend([], before.slice(0, 7), before).currentRange.end).toBe('2026-12-31')
    expect(buildProfitTrend([], after.slice(0, 7), after)).toMatchObject({ month: '2027-01', previousRange: { start: '2026-12-01', end: '2026-12-01' } })
  })
})

describe('profit trend money and settlement', () => {
  it('sums person, item, whole-order and manual commission profits without multiplying totals again', () => {
    const rows = [ticket(), ticket({ id: 'item', quantityUnit: 'item', personCount: 2, agentPriceThb: 105, costThb: 95 }), ticket({ id: 'boat', projectName: '包船', amountBasis: 'total', personCount: 8, agentPriceThb: 9000, costThb: 8000 }), ticket({ id: 'commission', entryMode: 'profit_only', manualProfitThb: 25.15, personCount: 2, agentPriceThb: 0, costThb: 0 }), ticket({ id: 'month', settlementMode: 'monthly' })]
    const result = buildProfitTrend(rows, '2026-10', '2026-10-15')
    expect(result.current).toEqual({ dailyProfitThb: 1170, monthlyProfitThb: 200.3, totalProfitThb: 1370.3, recordCount: 5 })
    expect(result.days.at(-1)).toMatchObject(result.current)
    expect(buildProfitTrend(rows, '2026-10', '2026-11-01').current.totalProfitThb).toBe(summarise(ticketsInMonth(rows, '2026-10')).profitThb)
  })
  it('uses ticket snapshots, legacy fallback and fixed monthly commission, never catalogue or note text', () => {
    const rows = [ticket({ projectName: '泰拳', settlementMode: 'daily' }), ticket({ id: 'legacy', projectName: '泰拳', settlementMode: undefined }), ticket({ id: 'explicit', settlementMode: 'monthly' }), ticket({ id: 'note', note: '泰拳' })]
    expect(buildProfitTrend(rows, '2026-10', '2026-10-15').current).toMatchObject({ dailyProfitThb: 300, monthlyProfitThb: 300, totalProfitThb: 600 })
  })
  it('keeps partial refunds and full-refund losses on the original date and settlement', () => {
    const partial = ticket({ refunds: [refund] })
    expect(buildProfitTrend([partial], '2026-10', '2026-10-15').current.totalProfitThb).toBe(80)
    const full = ticket({ settlementMode: 'monthly', refunds: [{ ...refund, isFull: true, personCount: 3, refundRevenueThb: 450, returnedCostThb: 250 }] })
    expect(buildProfitTrend([full], '2026-10', '2026-10-15').current).toMatchObject({ dailyProfitThb: 0, monthlyProfitThb: -50, totalProfitThb: -50, recordCount: 1 })
    expect(buildProfitTrend([full], '2026-11', '2026-11-02').current.totalProfitThb).toBe(0)
    const voided = { ...full, refunds: full.refunds?.map(row => ({ ...row, cancelledAt: '2026-11-02T00:00:00Z' })) }
    expect(buildProfitTrend([voided], '2026-10', '2026-11-02').current.totalProfitThb).toBe(150)
  })
  it('sums integer cents exactly and never changes source records', () => {
    const rows = [0.1, 0.2, 0.03].map((price, index) => ticket({ id: String(index), agentPriceThb: price, costThb: 0, personCount: 1 }))
    const original = JSON.stringify(rows)
    expect(buildProfitTrend(rows, '2026-10', '2026-10-15').current.totalProfitThb).toBe(0.33)
    expect(JSON.stringify(rows)).toBe(original)
  })
  it('reacts to edits, deletes and pending offline records like ordinary synced input', () => {
    const original = ticket({ syncStatus: 'pending' })
    expect(buildProfitTrend([original], '2026-10', '2026-10-15').current.totalProfitThb).toBe(150)
    expect(buildProfitTrend([{ ...original, personCount: 4 }], '2026-10', '2026-10-15').current.totalProfitThb).toBe(200)
    expect(buildProfitTrend([{ ...original, deletedAt: original.updatedAt }], '2026-10', '2026-10-15').current.totalProfitThb).toBe(0)
  })
  it.each([
    [100, 150, 50, 50, null], [100, 50, -50, -50, null], [100, -50, -150, -150, null], [100, 100, 0, 0, null],
    [0, 50, 50, null, 'zero'], [-100, -50, 50, null, 'loss'], [-100, 50, 150, null, 'loss']
  ] as const)('compares previous=%s with current=%s honestly', (previous, current, difference, percent, reason) => {
    const profit = (amount: number, issueDate: string) => ticket({ issueDate, amountBasis: 'total', agentPriceThb: Math.max(0, amount), costThb: Math.max(0, -amount) })
    const result = buildProfitTrend([profit(previous, '2026-09-15'), profit(current, '2026-10-15')], '2026-10', '2026-10-15')
    expect(result.differenceThb).toBe(difference); expect(result.percentage).toBe(percent); expect(result.percentageUnavailable).toBe(reason)
  })
  it('distinguishes no prior records from recorded zero profit', () => {
    const result = buildProfitTrend([], '2026-10', '2026-10-15')
    expect(result.percentageUnavailable).toBe('no_records'); expect(result.percentage).toBeNull()
    expect(result.days.every(day => day.totalProfitThb === 0)).toBe(true)
  })
})
