import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { buildReport, type ReportQuery } from './reports'

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
  ticket('monthly-ticket', { projectName: '泰拳', personCount: 2, supplierId: 'supplier-b', supplierName: '测试供货商乙' }),
  ticket('manual-commission', { entryMode: 'profit_only', manualProfitThb: 25, personCount: 4, supplierId: 'supplier-b', supplierName: '测试供货商乙' }),
  ticket('deleted', { deletedAt: '2026-10-13T04:00:00Z' }),
  ticket('previous-month', { issueDate: '2026-09-30' }),
  ticket('next-month', { issueDate: '2026-11-01' })
]

describe('formatted ledger reports', () => {
  it('queries monthly-settlement project ticket quantities daily, monthly and cumulatively', () => {
    const daily = buildReport(records, query({ mode: 'day', projectName: '泰拳' }))
    expect(daily.quantity).toMatchObject({ recordCount: 1, peopleCount: 2, unknownCount: 0 })
    expect(daily.quantity.days).toEqual([{ date: '2026-10-13', recordCount: 1, peopleCount: 2, unknownCount: 0 }])
    expect(daily.summary.profitThb).toBe(0)
    expect(daily.monthlySummary.profitThb).toBe(100)
    expect(buildReport(records, query({ projectName: '泰拳' })).summary.profitThb).toBe(100)
    const all = buildReport(records, query({ mode: 'all' }))
    expect(all.start).toBe('2026-09-30')
    expect(all.end).toBe('2026-11-01')
    expect(all.quantity).toMatchObject({ recordCount: 6, peopleCount: 16, unknownCount: 1 })
    expect(all.quantity.days.map((day) => day.date)).toEqual(['2026-09-30', '2026-10-13', '2026-11-01'])
  })

  it('combines supplier and exact parent-project filters across packages, not notes or similar names', () => {
    const rows = [
      ticket('adult', { projectName: '泰拳', subItemName: '成人', personCount: 3 }),
      ticket('child', { projectName: '泰拳', subItemName: '儿童', personCount: 2 }),
      ticket('other-supplier', { projectName: '泰拳', supplierId: 'supplier-b', personCount: 5 }),
      ticket('similar', { projectName: '泰拳课程', personCount: 9 }),
      ticket('note', { note: '泰拳', subItemName: '泰拳', personCount: 8 }),
      ticket('deleted-project', { projectName: '泰拳', deletedAt: '2026-10-13T04:00:00Z' }),
      ticket('commission', { projectName: '泰拳', entryMode: 'profit_only', manualProfitThb: 25, personCount: 20 })
    ]
    const report = buildReport(rows, query({ projectName: '泰拳', supplierId: 'supplier-a' }))
    expect(report.quantity).toMatchObject({ recordCount: 2, peopleCount: 5, unknownCount: 0 })
    expect(report.records.map((row) => row.id)).toEqual(['adult', 'child', 'commission'])
    expect(report.projectName).toBe('泰拳')
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
})
