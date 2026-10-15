import { describe, expect, it } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { buildReportExportRows, buildTicketExportRows, createLedgerBackup } from './export'
import { buildReport, type ReportQuery } from './reports'

const supplier: Supplier = {
  id: 'supplier-1', userId: 'local-user', name: '示例供货商', normalizedName: '示例供货商',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', syncStatus: 'pending'
}
const project: Project = {
  id: 'project-1', userId: supplier.userId, supplierId: supplier.id, supplierName: supplier.name,
  name: '示例项目', normalizedName: '示例项目', subItemName: '', normalizedSubItemName: '',
  defaultCostThb: 100, defaultAgentPriceThb: 150, createdAt: supplier.createdAt,
  updatedAt: supplier.updatedAt, syncStatus: 'pending'
}

const reportTicket = (id: string, overrides: Partial<TicketRecord> = {}): TicketRecord => ({
  id, userId: supplier.userId, guestName: ' Jimmy ', issueDate: '2026-10-15', issueTime: '09:35',
  supplierId: supplier.id, supplierName: supplier.name, projectId: project.id, projectName: project.name,
  subItemName: '普通套餐', personCount: 3, amountBasis: 'per_person', settlementMode: 'daily',
  agentPriceThb: 500, costThb: 450, note: '备注内容', createdAt: supplier.createdAt,
  updatedAt: supplier.updatedAt, deletedAt: null, syncStatus: 'synced', ...overrides
})
const reportQuery = (overrides: Partial<ReportQuery> = {}): ReportQuery => ({
  mode: 'month', date: '2026-10-15', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31',
  supplierId: '', ...overrides
})
const refund = (ticketId: string, overrides: Partial<RefundRecord> = {}): RefundRecord => ({
  id: `refund-${ticketId}`, userId: supplier.userId, ticketId, personCount: 1, isFull: false,
  refundRevenueThb: 500, returnedCostThb: 450, refundDate: '2026-10-16', refundTime: '10:30',
  note: '', cancelledAt: null, createdAt: supplier.createdAt, updatedAt: supplier.updatedAt, syncStatus: 'synced', ...overrides
})

describe('complete ledger backup', () => {
  it('preserves all catalogue rows, IDs, optional subitems, amounts and timestamps', () => {
    const projects = Array.from({ length: 95 }, (_, i) => ({ ...project, id: `project-${i}` }))
    const backup = createLedgerBackup({ suppliers: [supplier], projects, tickets: [] }, '2026-01-03T00:00:00.000Z')
    expect(backup).toMatchObject({ format: 'ticket-profit-ledger', version: 2, currency: 'THB', timeZone: 'Asia/Bangkok', refunds: [] })
    expect(backup.suppliers).toEqual([supplier])
    expect(backup.projects).toEqual(projects)
    expect(backup.projects).toHaveLength(95)
    expect(backup.tickets).toEqual([])
    expect(backup.projects[0]).not.toBe(projects[0])
  })

  it('excludes unknown fields, including credentials', () => {
    const record = { ...supplier, access_token: 'fictional-test-only', refresh_token: 'fictional-test-only' }
    const backup = createLedgerBackup({ suppliers: [record], projects: [project], tickets: [] })
    expect(JSON.stringify(backup)).not.toContain('token')
  })

  it('refuses a mixed-account snapshot', () => {
    expect(() => createLedgerBackup({ suppliers: [supplier], projects: [{ ...project, userId: 'another-user' }], tickets: [] })).toThrow('账号正在切换')
  })

  it('keeps deleted ticket markers and historical price snapshots', () => {
    const ticket: TicketRecord = {
      id: 'ticket-1', userId: supplier.userId, issueDate: '2026-01-01', supplierId: supplier.id,
      supplierName: supplier.name, projectId: project.id, projectName: project.name, subItemName: '',
      personCount: 3, agentPriceThb: 140, costThb: 90, note: '示例备注', createdAt: supplier.createdAt,
      updatedAt: supplier.updatedAt, deletedAt: supplier.updatedAt, syncStatus: 'pending'
    }
    expect(createLedgerBackup({ suppliers: [supplier], projects: [project], tickets: [ticket] }).tickets).toEqual([ticket])
    const active = { ...ticket, deletedAt: null, issueTime: '09:35' }
    expect(buildTicketExportRows([active, ticket])).toHaveLength(1)
    expect(buildTicketExportRows([active])[0]).toMatchObject({ '人数': 3, '曼谷时间': '09:35', '代理售价 (THB)': 140, '供货商成本 (THB)': 90, '利润 (THB)': 50 })
    expect(buildTicketExportRows([{ ...active, personCount: null }])[0]['人数']).toBe('')
    expect(buildTicketExportRows([{ ...active, entryMode: 'profit_only', manualProfitThb: 123.45 }])[0]).toMatchObject({ '人数': 3, '代理售价 (THB)': '', '供货商成本 (THB)': '', '利润 (THB)': 123.45 })
    const perPerson = { ...active, amountBasis: 'per_person' as const }
    expect(buildTicketExportRows([perPerson])[0]).toMatchObject({ '人数': 3, '计价方式': '按人数计算', '单人代理售价 (THB)': 140, '单人供货商成本 (THB)': 90, '代理售价 (THB)': 420, '供货商成本 (THB)': 270, '利润 (THB)': 150 })
    expect(buildTicketExportRows([{ ...perPerson, entryMode: 'profit_only', manualProfitThb: 50.25 }])[0]).toMatchObject({ '单人返佣利润 (THB)': 50.25, '代理售价 (THB)': '', '供货商成本 (THB)': '', '利润 (THB)': 150.75 })
    expect(createLedgerBackup({ suppliers: [supplier], projects: [project], tickets: [perPerson] }).tickets[0].amountBasis).toBe('per_person')
  })
})

describe('filtered profit report exports', () => {
  it('exports only the displayed date, supplier, project and customer selection without 79 show orders', () => {
    const source = [
      reportTicket('matched'),
      reportTicket('another-customer', { guestName: 'Aditya' }),
      reportTicket('another-supplier', { supplierId: 'another-supplier' }),
      reportTicket('another-project', { projectName: '其他项目' }),
      reportTicket('outside-range', { issueDate: '2026-09-30' }),
      reportTicket('deleted', { deletedAt: supplier.updatedAt }),
      reportTicket('show79', { projectName: '79秀' })
    ]
    const report = buildReport(source, reportQuery({ supplierId: supplier.id, projectName: project.name, guestName: 'jimmy' }))
    const rows = buildReportExportRows(report, supplier.name)
    expect(rows.records).toHaveLength(1)
    expect(rows.records[0]).toMatchObject({
      '客户姓名': 'Jimmy', '出票日期': '2026-10-15', '曼谷时间': '09:35',
      '项目': project.name, '子项 / 套餐': '普通套餐', '供货商': supplier.name, '有效人数': 3, '利润 (THB)': 150
    })
    expect(rows.summary[0]).toMatchObject({
      '开始日期': '2026-10-01', '截止日期': '2026-10-31', '客户筛选': 'jimmy',
      '供货商': supplier.name, '项目': project.name, '记录数': 1, '有效人数': 3, '利润合计 (THB)': 150
    })
    expect(rows.monthlyRecords).toEqual([])
    expect(source[0].guestName).toBe(' Jimmy ')
  })

  it('shows missing customer names explicitly and never guesses an unknown quantity', () => {
    const report = buildReport([
      reportTicket('blank', { guestName: '   ', personCount: null, amountBasis: 'total' }),
      reportTicket('legacy', { guestName: undefined, personCount: 2 })
    ], reportQuery())
    const rows = buildReportExportRows(report, '')
    expect(rows.records.map((row) => row['客户姓名'])).toEqual(['未填写', '未填写'])
    expect(rows.records.map((row) => row['有效人数'])).toEqual(['', 2])
    expect(rows.summary[0]).toMatchObject({ '客户筛选': '全部客户', '供货商': '全部供货商', '项目': '全部项目', '有效人数': 2, '数量未填写记录数': 1 })
    expect(buildTicketExportRows([reportTicket('legacy', { guestName: undefined })])[0]['客户姓名']).toBe('未填写')
    expect(buildTicketExportRows([reportTicket('trimmed')])[0]['客户姓名']).toBe('Jimmy')
  })

  it('exports effective refunded quantities, actual profit and manual commissions without counting them as people', () => {
    const report = buildReport([
      reportTicket('partial', { refunds: [refund('partial')] }),
      reportTicket('full', { personCount: 2, refunds: [refund('full', { isFull: true, personCount: 2, refundRevenueThb: 1000, returnedCostThb: 900 })] }),
      reportTicket('items', { quantityUnit: 'item', personCount: 4, refunds: [refund('items', { personCount: 2, refundRevenueThb: 1000, returnedCostThb: 900 })] }),
      reportTicket('commission', { entryMode: 'profit_only', manualProfitThb: 75, amountBasis: 'total', personCount: 42, settlementMode: 'monthly' })
    ], reportQuery())
    const rows = buildReportExportRows(report, '')
    const detail = Object.fromEntries(rows.records.map((row) => [row['退票状态'] === '已全部退票' ? 'full' : row['记录类型'].includes('仅录利润') ? 'commission' : row['有效数量'] !== '' ? 'items' : 'partial', row]))
    expect(detail.partial).toMatchObject({ '有效人数': 2, '有效数量': '', '退票状态': '部分退票', '利润 (THB)': 100 })
    expect(detail.full).toMatchObject({ '有效人数': 0, '退票状态': '已全部退票', '利润 (THB)': 0 })
    expect(detail.items).toMatchObject({ '有效人数': '', '有效数量': 2, '退票状态': '部分退票', '利润 (THB)': 100 })
    expect(detail.commission).toMatchObject({ '有效人数': '', '有效数量': '', '结算方式': '月结', '利润 (THB)': 75 })
    expect(rows.summary[0]).toMatchObject({ '记录数': 4, '有效人数': 2, '有效商品数量': 2, '数量未填写记录数': 0, '利润合计 (THB)': 275 })
    expect(rows.monthlyRecords).toEqual([])
    for (const row of [...rows.summary, ...rows.records]) {
      expect(Object.keys(row).some((key) => /售价|成本/.test(key))).toBe(false)
    }
  })

  it('keeps daily monthly-settlement details and profit separate from the daily total', () => {
    const report = buildReport([
      reportTicket('daily', { personCount: 2 }),
      reportTicket('monthly', { guestName: 'Aditya', personCount: 1, settlementMode: 'monthly' }),
      reportTicket('commission', { entryMode: 'profit_only', manualProfitThb: 20, amountBasis: 'total', personCount: 100, settlementMode: 'monthly' }),
      reportTicket('yesterday', { issueDate: '2026-10-14', settlementMode: 'monthly' })
    ], reportQuery({ mode: 'day' }))
    const rows = buildReportExportRows(report, '')
    expect(rows.records).toHaveLength(1)
    expect(rows.records[0]['利润 (THB)']).toBe(100)
    expect(rows.monthlyRecords).toHaveLength(2)
    expect(rows.monthlyRecords.reduce((sum, row) => sum + row['利润 (THB)'], 0)).toBe(70)
    expect(rows.monthlyRecords.find((row) => row['客户姓名'] === 'Aditya')?.['有效人数']).toBe(1)
    expect(rows.summary[0]).toMatchObject({
      '记录数': 1, '有效人数': 2, '利润合计 (THB)': 100,
      '当日月结另列记录数': 2, '当日月结另列有效人数': 1, '当日月结另列利润 (THB)': 70
    })
    expect(rows.summary[0]['日报说明']).toContain('不计入日报')
  })

  it('exports an empty report with clear zero totals and its selected scope', () => {
    const rows = buildReportExportRows(buildReport([], reportQuery()), '')
    expect(rows.records).toEqual([])
    expect(rows.monthlyRecords).toEqual([])
    expect(rows.summary[0]).toMatchObject({ '记录数': 0, '有效人数': 0, '有效商品数量': 0, '利润合计 (THB)': 0 })
  })
})
