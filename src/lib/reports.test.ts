import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { buildReport, reportShortcutQuery, type ReportQuery } from './reports'

const ticket = (id: string, overrides: Partial<TicketRecord> = {}): TicketRecord => ({
  id, userId: 'test-user', issueDate: '2026-10-13', issueTime: '10:00', supplierId: 'supplier-a', supplierName: '测试供货商甲',
  projectId: 'project-a', projectName: '普通门票', subItemName: '', personCount: 3, amountBasis: 'per_person',
  agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-13T03:00:00Z', updatedAt: '2026-10-13T03:00:00Z', deletedAt: null, syncStatus: 'synced', ...overrides
})
const query = (overrides: Partial<ReportQuery> = {}): ReportQuery => ({ mode: 'month', month: '2026-10', date: '2026-10-13', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '', ...overrides })
const records = [
  ticket('ordinary'),
  ticket('legacy', { amountBasis: undefined, personCount: 5, agentPriceThb: 100, costThb: 80 }),
  ticket('unknown', { amountBasis: 'total', personCount: null, agentPriceThb: 50, costThb: 40 }),
  ticket('monthly-ticket', { projectName: '普通月结项目', settlementMode: 'monthly', personCount: 2, supplierId: 'supplier-b', supplierName: '测试供货商乙' }),
  ticket('manual-commission', { entryMode: 'profit_only', manualProfitThb: 25, personCount: 4, supplierId: 'supplier-b', supplierName: '测试供货商乙' }),
  ticket('deleted', { deletedAt: '2026-10-13T04:00:00Z' }),
  ticket('previous-month', { issueDate: '2026-09-30' }),
  ticket('next-month', { issueDate: '2026-11-01' })
]

describe('formatted ledger reports', () => {
  it.each(['day', 'month', 'range', 'all'] as const)('filters %s report totals and monthly detail by customer name without matching notes or 79 show', (mode) => {
    const rows = [
      ticket('regular', { guestName: 'Jimmy', settlementMode: 'daily' }),
      ticket('monthly', { guestName: 'JIMMY Tan', settlementMode: 'monthly', personCount: 1 }),
      ticket('other', { guestName: 'Aditya' }),
      ticket('note-only', { note: 'Jimmy' }),
      ticket('deleted', { guestName: 'Jimmy', deletedAt: '2026-10-13T04:00:00Z' }),
      ticket('independent', { guestName: 'Jimmy', projectName: '79秀' })
    ]
    const report = buildReport(rows, query({ mode, guestName: '  ｊｉＭｍｙ  ' }))
    expect(report.guestName).toBe('ｊｉＭｍｙ')
    expect(report.records.map(row => row.id)).toEqual(mode === 'day' ? ['regular'] : ['monthly', 'regular'])
    expect(report.summary.profitThb).toBe(mode === 'day' ? 150 : 200)
    expect(report.monthlyRecords.map(row => row.id)).toEqual(['monthly'])
    expect(report.quantity.peopleCount).toBe(4)
    expect(report.supplierStats[0].profitThb).toBe(mode === 'day' ? 150 : 200)
  })

  it('combines partial Chinese customer names with project, supplier and date filters', () => {
    const rows = [
      ticket('matched', { guestName: '李湘光、龙粉萍' }),
      ticket('wrong-supplier', { guestName: '龙粉萍', supplierId: 'supplier-b' }),
      ticket('wrong-project', { guestName: '龙粉萍', projectName: '其他项目' }),
      ticket('wrong-date', { guestName: '龙粉萍', issueDate: '2026-09-30' })
    ]
    expect(buildReport(rows, query({ guestName: '龙粉', projectName: '普通门票', supplierId: 'supplier-a' })).records.map(row => row.id)).toEqual(['matched'])
    expect(buildReport(rows, query({ guestName: '不存在的客户' })).summary.profitThb).toBe(0)
    expect(buildReport(rows, query({ guestName: '   ' })).guestName).toBe('')
  })

  it('queries monthly-settlement project ticket quantities daily, monthly and cumulatively', () => {
    const daily = buildReport(records, query({ mode: 'day', projectName: '普通月结项目' }))
    expect(daily.quantity).toMatchObject({ recordCount: 1, peopleCount: 2, unknownCount: 0 })
    expect(daily.quantity.days).toEqual([{ date: '2026-10-13', recordCount: 1, peopleCount: 2, unknownCount: 0 }])
    expect(daily.summary.profitThb).toBe(0)
    expect(daily.monthlySummary.profitThb).toBe(100)
    expect(buildReport(records, query({ projectName: '普通月结项目' })).summary.profitThb).toBe(100)
    const all = buildReport(records, query({ mode: 'all' }))
    expect(all.start).toBe('2026-09-30')
    expect(all.end).toBe('2026-11-01')
    expect(all.quantity).toMatchObject({ recordCount: 6, peopleCount: 16, unknownCount: 1 })
    expect(all.quantity.days.map((day) => day.date)).toEqual(['2026-09-30', '2026-10-13', '2026-11-01'])
  })

  it('combines supplier and exact parent-project filters across packages, not notes or similar names', () => {
    const rows = [
      ticket('adult', { projectName: '普通月结项目', subItemName: '成人', personCount: 3 }),
      ticket('child', { projectName: '普通月结项目', subItemName: '儿童', personCount: 2 }),
      ticket('other-supplier', { projectName: '普通月结项目', supplierId: 'supplier-b', personCount: 5 }),
      ticket('similar', { projectName: '普通月结项目课程', personCount: 9 }),
      ticket('note', { note: '普通月结项目', subItemName: '普通月结项目', personCount: 8 }),
      ticket('deleted-project', { projectName: '普通月结项目', deletedAt: '2026-10-13T04:00:00Z' }),
      ticket('commission', { projectName: '普通月结项目', entryMode: 'profit_only', manualProfitThb: 25, personCount: 20 })
    ]
    const report = buildReport(rows, query({ projectName: '普通月结项目', supplierId: 'supplier-a' }))
    expect(report.quantity).toMatchObject({ recordCount: 2, peopleCount: 5, unknownCount: 0 })
    expect(report.records.map((row) => row.id)).toEqual(['adult', 'child', 'commission'])
    expect(report.projectName).toBe('普通月结项目')
    expect(buildReport(rows, query({ projectName: '未出票项目' })).quantity.recordCount).toBe(0)
  })

  it('reports unknown quantities explicitly and updates them after edits or deletion', () => {
    const missing = ticket('legacy', { personCount: null })
    const known = ticket('known')
    expect(buildReport([missing, known], query()).quantity).toMatchObject({ peopleCount: 3, recordCount: 2, unknownCount: 1 })
    expect(buildReport([missing, { ...known, personCount: 5 }], query()).quantity.peopleCount).toBe(5)
    expect(buildReport([missing, { ...known, deletedAt: '2026-10-13T04:00:00Z' }], query()).quantity).toMatchObject({ peopleCount: 0, recordCount: 1, unknownCount: 1 })
    expect(buildReport([records[4]], query()).quantity).toMatchObject({ peopleCount: 0, recordCount: 0, unknownCount: 0, days: [] })
    expect(buildReport([], query({ mode: 'all' })).quantity.recordCount).toBe(0)
  })
  it('keeps Koh Larn and carnival out of all main report modes regardless of legacy settlement snapshots', () => {
    const rows = [
      ticket('normal'),
      ticket('koh-larn-daily', { projectName: '格兰岛跟团一日游', settlementMode: 'daily' }),
      ticket('carnival-legacy', { projectName: '东方嘉年华', settlementMode: undefined })
    ]
    for (const mode of ['day', 'month', 'range', 'all'] as const) {
      const report = buildReport(rows, query({ mode }))
      expect(report.records.map(row => row.id)).toEqual(['normal'])
      expect(report.quantity).toMatchObject({ recordCount: 1, peopleCount: 3 })
      expect(report.summary.profitThb).toBe(150)
      expect(report.monthlyRecords).toEqual([])
    }
  })
  it('includes all active monthly records, using multiplied amounts and preserving legacy totals', () => {
    const report = buildReport(records, query())
    expect(report.start).toBe('2026-10-01')
    expect(report.end).toBe('2026-10-31')
    expect(report.records).toHaveLength(5)
    expect(report.summary).toEqual({ count: 4, agentPriceThb: 3400, costThb: 3120, profitThb: 380 })
    expect(report.recordedPeople).toBe(10)
    expect(report.unknownHeadcounts).toBe(1)
    expect(report.supplierStats.map((row) => row.profitThb)).toEqual([200, 180])
  })

  it('excludes monthly settlement from daily totals, showing it in a separate section', () => {
    const report = buildReport(records, query({ mode: 'day' }))
    expect(report.summary).toEqual({ count: 3, agentPriceThb: 2100, costThb: 1920, profitThb: 180 })
    expect(report.records.map((row) => row.id)).not.toContain('monthly-ticket')
    expect(report.monthlyRecords).toHaveLength(2)
    expect(report.monthlySummary).toEqual({ count: 1, agentPriceThb: 1300, costThb: 1200, profitThb: 200 })
    expect(report.recordedPeople).toBe(8)
    expect(report.supplierStats).toHaveLength(1)
  })

  it('filters both normal and separately listed monthly rows by supplier', () => {
    const monthly = buildReport(records, query({ supplierId: 'supplier-b' }))
    expect(monthly.records).toHaveLength(2)
    expect(monthly.summary.profitThb).toBe(200)
    const daily = buildReport(records, query({ mode: 'day', supplierId: 'supplier-b' }))
    expect(daily.records).toEqual([])
    expect(daily.supplierStats).toEqual([])
    expect(daily.monthlyRecords).toHaveLength(2)
  })

  it('includes both endpoints of a custom range and validates natural month boundaries', () => {
    const report = buildReport(records, query({ mode: 'range', startDate: '2026-09-30', endDate: '2026-10-13' }))
    expect(report.records).toHaveLength(6)
    expect(report.records[0].issueDate).toBe('2026-09-30')
    expect(buildReport([], query({ month: '2024-02' })).end).toBe('2024-02-29')
    expect(buildReport([], query({ month: '2026-02' })).end).toBe('2026-02-28')
  })

  it.each([
    query({ month: '' }), query({ month: '2026-13' }), query({ mode: 'day', date: '2026-02-29' }),
    query({ mode: 'range', startDate: '', endDate: '2026-10-31' }),
    query({ mode: 'range', startDate: '2026-10-31', endDate: '2026-10-01' })
  ])('rejects invalid periods instead of showing a misleading report', (filter) => {
    expect(() => buildReport(records, filter)).toThrow()
  })

  it('rebuilds totals after editing or deleting a record without changing source data', () => {
    const before = structuredClone(records)
    expect(buildReport(records, query()).summary.profitThb).toBe(380)
    const edited = records.map((row) => row.id === 'ordinary' ? { ...row, personCount: 5 } : row)
    expect(buildReport(edited, query()).summary.profitThb).toBe(480)
    expect(buildReport(edited.map((row) => row.id === 'ordinary' ? { ...row, deletedAt: '2026-10-13T04:00:00Z' } : row), query()).summary.profitThb).toBe(230)
    expect(records).toEqual(before)
  })

  it('handles empty, loss and manual-only reports without fake ticket or people counts', () => {
    const empty = buildReport([], query())
    expect(empty.summary).toEqual({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 0 })
    expect(buildReport([ticket('loss', { agentPriceThb: 500 })], query()).summary.profitThb).toBe(-300)
    const manual = buildReport([records[4]], query())
    expect(manual.summary).toEqual({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 100 })
    expect(manual.recordedPeople).toBe(0)
  })

  it('uses consistent accounting, effective-order and refunded-order counts without changing financial totals', () => {
    const refundFor = (ticketId: string, full = false, cancelled = false) => ({
      id: `refund-${ticketId}`, ticketId, userId: 'test-user', personCount: full ? 3 : 1, isFull: full,
      refundRevenueThb: full ? 1950 : 650, returnedCostThb: full ? 1800 : 600,
      refundDate: '2026-10-14', refundTime: '10:00', note: '', cancelledAt: cancelled ? '2026-10-15T00:00:00Z' : null,
      createdAt: '2026-10-14T03:00:00Z', updatedAt: '2026-10-14T03:00:00Z', syncStatus: 'synced' as const
    })
    const source = [
      ticket('normal'),
      ticket('partial', { refunds: [refundFor('partial')] }),
      ticket('full', { refunds: [refundFor('full', true)] }),
      ticket('cancelled-refund', { refunds: [refundFor('cancelled-refund', true, true)] }),
      ticket('commission', { supplierId: 'supplier-b', supplierName: '测试供货商乙', entryMode: 'profit_only', amountBasis: 'total', manualProfitThb: 50 }),
      ticket('goods', { supplierId: 'supplier-b', supplierName: '测试供货商乙', quantityUnit: 'item', personCount: 2, agentPriceThb: 120, costThb: 100 }),
      ticket('deleted', { deletedAt: '2026-10-14T00:00:00Z' }),
      ticket('79', { projectName: '79秀' })
    ]
    const original = structuredClone(source)
    const report = buildReport(source, query())
    expect(report.counts).toEqual({ accountingRecordCount: 6, effectiveOrderCount: 4, refundedOrderCount: 2 })
    expect(report.summary.profitThb).toBe(490)
    expect(report.summary.count).toBe(4)
    expect(report.quantity).toMatchObject({ recordCount: 3, peopleCount: 8 })
    expect(report.itemQuantity).toMatchObject({ recordCount: 1, quantityCount: 2 })
    expect(report.supplierStats).toMatchObject([
      { supplierId: 'supplier-a', accountingRecordCount: 4, effectiveOrderCount: 3, refundedOrderCount: 2, count: 3, profitThb: 400 },
      { supplierId: 'supplier-b', accountingRecordCount: 2, effectiveOrderCount: 1, refundedOrderCount: 0, count: 1, profitThb: 90 }
    ])
    const daily = buildReport(source, query({ mode: 'day' }))
    expect(daily.counts).toEqual({ accountingRecordCount: 5, effectiveOrderCount: 4, refundedOrderCount: 2 })
    expect(daily.monthlyCounts).toEqual({ accountingRecordCount: 1, effectiveOrderCount: 0, refundedOrderCount: 0 })
    expect(daily.summary.profitThb).toBe(440)
    expect(daily.monthlySummary.profitThb).toBe(50)
    expect(buildReport(source, query({ supplierId: 'supplier-b' })).counts).toEqual({ accountingRecordCount: 2, effectiveOrderCount: 1, refundedOrderCount: 0 })
    expect(source).toEqual(original)
  })
})

describe('report period shortcuts', () => {
  const filters = query({ mode: 'range', supplierId: 'supplier-b', projectName: '普通月结项目', guestName: 'Jimmy' })

  it('opens today while retaining the project, supplier and customer filters', () => {
    expect(reportShortcutQuery(filters, 'today', '2026-10-16')).toEqual({ ...filters, mode: 'day', date: '2026-10-16', month: '2026-10', startDate: '2026-10-16', endDate: '2026-10-16' })
    expect(filters.mode).toBe('range')
  })

  it('opens the complete current natural month including leap days', () => {
    expect(reportShortcutQuery(filters, 'this-month', '2024-02-20')).toEqual({ ...filters, mode: 'month', date: '2024-02-20', month: '2024-02', startDate: '2024-02-01', endDate: '2024-02-29' })
  })

  it.each([
    ['2026-01-01', '2025-12', '2025-12-31'],
    ['2024-03-31', '2024-02', '2024-02-29'],
    ['2026-03-31', '2026-02', '2026-02-28'],
    ['2026-10-16', '2026-09', '2026-09-30']
  ])('opens the correct previous month from %s without carrying over the day number', (today, month, end) => {
    expect(reportShortcutQuery(filters, 'last-month', today)).toEqual({ ...filters, mode: 'month', month, date: `${month}-01`, startDate: `${month}-01`, endDate: end })
  })

  it('rejects an invalid anchor date', () => {
    expect(() => reportShortcutQuery(filters, 'last-month', '2026-02-30')).toThrow('日期无效')
  })
})
