import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { buildShow79Report, isShow79Project, mainLedgerTickets, parseShow79Command, splitShow79Profit, voucherDate } from './show79'
import { summarise, ticketsForDailyStats, ticketsInMonth, ticketsInYear } from './stats'
import { buildReport, type ReportQuery } from './reports'
import { createLedgerBackup } from './export'

const ticket = (id: string, overrides: Partial<TicketRecord> = {}): TicketRecord => ({ id, userId: 'user', projectName: '79秀', projectId: '79', subItemName: '门票', issueDate: '2026-10-15', issueTime: '18:30', guestName: 'jimmy', supplierId: 'supplier', supplierName: '供货商', amountBasis: 'per_person', personCount: 2, agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', deletedAt: null, syncStatus: 'synced', ...overrides })

describe('79 show independent ledger', () => {
  it('recognizes historical names and fullwidth text without matching unrelated shows', () => {
    for (const name of ['79秀', '７９ 秀', '79成人秀', 'Imagine 79 Show', '79 Show']) expect(isShow79Project(name)).toBe(true)
    for (const name of ['69秀', '179秀', '普通门票', '79商品']) expect(isShow79Project(name)).toBe(false)
  })
  it('excludes money, quantity, monthly sections and rankings from every main report', () => {
    const rows = [ticket('79', { settlementMode: 'daily' }), ticket('normal', { projectName: '普通门票', personCount: 3 })]
    expect(mainLedgerTickets(rows).map(row => row.id)).toEqual(['normal'])
    expect(summarise(ticketsForDailyStats(rows, '2026-10-15')).profitThb).toBe(150)
    expect(summarise(ticketsInMonth(rows, '2026-10')).profitThb).toBe(150)
    expect(summarise(ticketsInYear(rows, '2026')).profitThb).toBe(150)
    const query: ReportQuery = { mode: 'month', date: '2026-10-15', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '' }
    for (const mode of ['day', 'month', 'range', 'all'] as const) {
      const report = buildReport(rows, { ...query, mode })
      expect(report.records.map(row => row.id)).toEqual(['normal'])
      expect(report.summary.profitThb).toBe(150)
      expect(report.quantity.peopleCount).toBe(3)
      expect(report.supplierStats[0].profitThb).toBe(150)
      expect(report.monthlyRecords).toEqual([])
    }
    expect(buildReport(rows, { ...query, projectName: '79秀' }).records).toEqual([])
  })
  it('reports daily and monthly people separately with actual profit and a 40/60 split', () => {
    const rows = [ticket('today'), ticket('other-day', { issueDate: '2026-10-01', personCount: 3 }), ticket('previous', { issueDate: '2026-09-30' }), ticket('next', { issueDate: '2026-11-01' }), ticket('normal', { projectName: '69秀' }), ticket('deleted', { deletedAt: '2026-10-15T01:00:00Z' })]
    const report = buildShow79Report(rows, '2026-10-15', '2026-10')
    expect(report).toMatchObject({ dayPeople: 2, monthPeople: 5, profitThb: 250, jimmyThb: 100, partnersThb: 150 })
    expect(report.records).toHaveLength(2)
    expect(buildShow79Report([], '2026-10-15', '2026-10')).toMatchObject({ dayPeople: 0, monthPeople: 0, profitThb: 0 })
  })
  it('keeps legacy totals, flags unknown headcounts, and does not count manual commission as admissions', () => {
    const report = buildShow79Report([ticket('legacy', { amountBasis: undefined, personCount: null, agentPriceThb: 100, costThb: 50 }), ticket('commission', { entryMode: 'profit_only', manualProfitThb: 20, personCount: 9, amountBasis: 'total' })], '2026-10-15', '2026-10')
    expect(report).toMatchObject({ monthPeople: 0, monthUnknown: 1, profitThb: 70, jimmyThb: 28, partnersThb: 42 })
  })
  it('recalculates refunds in the original month, including losses and cancelled refunds', () => {
    const row = ticket('refunded', { refunds: [{ id: 'r', userId: 'user', ticketId: 'refunded', personCount: 1, isFull: false, refundRevenueThb: 650, returnedCostThb: 500, refundDate: '2026-11-01', refundTime: '10:00', note: '', cancelledAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', syncStatus: 'synced' }] })
    expect(buildShow79Report([row], '2026-10-15', '2026-10')).toMatchObject({ dayPeople: 1, monthPeople: 1, profitThb: -50, jimmyThb: -20, partnersThb: -30 })
    expect(buildShow79Report([row], '2026-11-01', '2026-11').profitThb).toBe(0)
    const restored = { ...row, refunds: row.refunds!.map(refund => ({ ...refund, cancelledAt: '2026-11-02T00:00:00Z' })) }
    expect(buildShow79Report([restored], '2026-10-15', '2026-10')).toMatchObject({ monthPeople: 2, profitThb: 100 })
  })
  it('splits the monthly total once and allocates satang remainder without losing money', () => {
    for (const profit of [0, 50, 0.01, 0.03, 10.01, -0.03, -100.01]) {
      const split = splitShow79Profit(profit)
      expect(Math.round(split.jimmyThb * 100) + Math.round(split.partnersThb * 100)).toBe(Math.round(profit * 100))
    }
    const small = [ticket('a', { amountBasis: 'total', agentPriceThb: 0.01, costThb: 0 }), ticket('b', { amountBasis: 'total', agentPriceThb: 0.01, costThb: 0 })]
    expect(buildShow79Report(small, '2026-10-15', '2026-10')).toMatchObject({ profitThb: 0.02, jimmyThb: 0.01, partnersThb: 0.01 })
    expect(() => buildShow79Report([], '2026-02-30', '2026-10')).toThrow()
  })
  it('preserves customer names and independent orders in the full backup', () => {
    const backup = createLedgerBackup({ suppliers: [], projects: [], tickets: [ticket('79')] })
    expect(backup.tickets[0]).toMatchObject({ guestName: 'jimmy', projectName: '79秀' })
  })
})

describe('79 voucher input', () => {
  it.each([
    '李湘光 龙粉萍 今天 2个79',
    '李湘光 龙粉萍 今天2个79',
    '李湘光 龙粉萍\n今天\n2个79',
    '79秀 李湘光 龙粉萍 今天 2位',
    '李湘光 龙粉萍 2人 今天 79',
    '79 李湘光 龙粉萍 2名 今日',
    '李湘光 龙粉萍 2张79秀 今天',
    '李湘光 龙粉萍 今天 ２个７９',
    '李湘光 龙粉萍 今天 2个79成人秀',
    'Imagine 79 Show 李湘光 龙粉萍 今天 2人'
  ])('fills both names, date and quantity from the natural phrase %s', text => {
    expect(parseShow79Command(text, '2026-10-15')).toEqual({ guestName: '李湘光 龙粉萍', people: 2, date: '2026-10-15' })
  })
  it('keeps digits within a guest name and treats only a standalone 79 as the product', () => {
    expect(parseShow79Command('79 John79 Smith 今天 2位', '2026-10-15')).toEqual({ guestName: 'John79 Smith', people: 2, date: '2026-10-15' })
  })
  it('accepts Chinese dates and rolls relative dates across year boundaries', () => {
    expect(parseShow79Command('李湘光 龙粉萍 2026年10月20日 2个79', '2026-10-15')).toEqual({ guestName: '李湘光 龙粉萍', people: 2, date: '2026-10-20' })
    expect(parseShow79Command('79 张三 后天 1位', '2026-12-31').date).toBe('2027-01-02')
  })
  it.each(['79 张三 今天 明天 2人', '79 张三 今天 2人 3人', '79 张三 今天 2.5个', '79 张三 今天 -2个', '79 张三 今天 0个'])('rejects ambiguous or invalid fields rather than guessing: %s', text => {
    expect(() => parseShow79Command(text, '2026-10-15')).toThrow()
  })
  it.each(['79 jimmy 2人 今天', '79\n2人\njimmy\n今天', '79，jimmy，2人，今天'])('parses %s with the supplied Bangkok date', text => {
    expect(parseShow79Command(text, '2026-10-15')).toEqual({ guestName: 'jimmy', people: 2, date: '2026-10-15' })
  })
  it('handles explicit dates and next day across month and year boundaries', () => {
    expect(parseShow79Command('79秀 张三 2人 2026/1/2').date).toBe('2026-01-02')
    expect(parseShow79Command('79 Jimmy Smith 2人 明天', '2026-12-31')).toEqual({ guestName: 'Jimmy Smith', people: 2, date: '2027-01-01' })
    expect(voucherDate('2026-10-15')).toBe('2026/10/15')
  })
  it.each(['79 2人 今天', '79 jimmy 0人 今天', '79 jimmy 2人 2026/2/30', '79 jimmy 今天', '79 jimmy 2人'])('rejects incomplete input %s', text => {
    expect(() => parseShow79Command(text, '2026-10-15')).toThrow()
  })
})
