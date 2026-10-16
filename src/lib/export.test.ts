import { describe, expect, it } from 'vitest'
import type { Project, RefundRecord, Supplier, TicketRecord } from '../types'
import { buildRefundExportRows, buildReportExportRows, buildShow79ExportRows, buildTicketExportRows, createLedgerBackup } from './export'
import { buildReport, type ReportQuery } from './reports'
import type { Show79SettlementRecord } from './show79-settlement'

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
const settlement = (overrides: Partial<Show79SettlementRecord> = {}): Show79SettlementRecord => ({
  id: 'settlement-october', userId: supplier.userId, month: '2026-10', snapshotProfitThb: 100,
  snapshotJimmyThb: 40, snapshotPartnersThb: 60, jimmyPaidThb: 40, partnersPaidThb: 60,
  paymentDate: '2026-10-31', note: '月底分账', createdAt: '2026-10-31T12:00:00.000Z',
  updatedAt: '2026-10-31T12:00:00.000Z', syncStatus: 'synced', ...overrides
})

describe('auditable ticket and refund exports', () => {
  it('keeps commission pricing quantities while excluding them from effective admission and item counts', () => {
    for (const quantityUnit of ['person', 'item'] as const) {
      const ticket = reportTicket('commission', { entryMode: 'profit_only', manualProfitThb: 50, personCount: 4, quantityUnit })
      expect(buildTicketExportRows([ticket])[0]).toMatchObject({ '原票编号': ticket.id, '有效人数': '', '有效数量': '', '利润 (THB)': 200 })
      expect(buildTicketExportRows([ticket])[0][quantityUnit === 'person' ? '人数' : '数量']).toBe(4)
    }
  })
  it('links refunds to the exact original item, guest and supplier and distinguishes people from items', () => {
    const male = reportTicket('male', { projectName: '药品', subItemName: '果冻（男）', quantityUnit: 'item', personCount: 3 })
    const female = reportTicket('female', { projectName: '药品', subItemName: '果冻（女）', quantityUnit: 'item', personCount: 2, refunds: [refund('female'), refund('female', { id: 'voided', cancelledAt: supplier.updatedAt })] })
    const admission = reportTicket('admission', { refunds: [refund('admission')] })
    const tickets = [male, female, admission], original = JSON.stringify(tickets)
    const details = buildRefundExportRows(tickets)
    const ids = new Set(buildTicketExportRows(tickets).map(row => row['原票编号']))
    expect(details.every(row => ids.has(row['原票编号']))).toBe(true)
    expect(details[0]).toMatchObject({ '原票编号': 'female', '客户姓名': 'Jimmy', '项目': '药品', '子项 / 套餐': '果冻（女）', '供货商': supplier.name, '数量单位': '件', '原数量': 2, '原人数': '', '退回数量': 1, '退票人数': '', '退票日期': '2026-10-16', '状态': '有效' })
    expect(details[1]).toMatchObject({ '状态': '已撤销', '退回数量': 1 })
    expect(details[2]).toMatchObject({ '数量单位': '人', '原人数': 3, '退票人数': 1, '退回数量': '' })
    expect(JSON.stringify(tickets)).toBe(original)
  })
  it('keeps unknown historical quantities and canonical original IDs without guessing', () => {
    const ticket = reportTicket('legacy', { personCount: null, quantityUnit: 'item', refunds: [refund('legacy', { personCount: null, isFull: true })] })
    expect(buildRefundExportRows([ticket])[0]).toMatchObject({ '原票编号': 'legacy', '原数量': '未记录', '退回数量': '原数量未知', '退票人数': '' })
  })
})

describe('complete ledger backup', () => {
  it('preserves all catalogue rows, IDs, optional subitems, amounts and timestamps', () => {
    const projects = Array.from({ length: 95 }, (_, i) => ({ ...project, id: `project-${i}` }))
    const backup = createLedgerBackup({ suppliers: [supplier], projects, tickets: [] }, '2026-01-03T00:00:00.000Z')
    expect(backup).toMatchObject({ format: 'ticket-profit-ledger', version: 2, currency: 'THB', timeZone: 'Asia/Bangkok', refunds: [], show79Settlements: [] })
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
    expect(() => createLedgerBackup({ suppliers: [supplier], projects: [], tickets: [], show79Settlements: [settlement({ userId: 'another-user' })] })).toThrow('账号正在切换')
  })

  it('backs up settlement snapshots and signed payments using explicit safe fields', () => {
    const record = settlement({ jimmyPaidThb: -20, partnersPaidThb: -30, note: '退款收回' })
    const source = { ...record, access_token: 'fictional-test-only' }
    const backup = createLedgerBackup({ suppliers: [supplier], projects: [], tickets: [], show79Settlements: [source] })
    expect(backup.show79Settlements).toEqual([record])
    expect(backup.show79Settlements[0]).not.toBe(source)
    expect(JSON.stringify(backup)).not.toContain('token')
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

describe('79 show independent settlement exports', () => {
  const tickets = [
    reportTicket('show79', { projectName: '79秀', personCount: 2, settlementMode: 'monthly' }),
    reportTicket('ordinary', { personCount: 100 }),
    reportTicket('other-month', { projectName: '79秀', issueDate: '2026-09-30', personCount: 100 })
  ]

  it('reports an unsettled month with actual 40/60 shares when no payments were registered', () => {
    const rows = buildShow79ExportRows(tickets, '2026-10-15', '2026-10', [], '2026-10-31T12:00:00.000Z')
    expect(rows.summary[0]).toMatchObject({
      '月份': '2026-10', '月订单数': 1, '月人数': 2, '月实际利润 (THB)': 100,
      'jimmy 40% (THB)': 40, '大狗二狗合计 60% (THB)': 60, '结算状态': '未结算',
      'jimmy 累计已付 (THB)': 0, 'jimmy 尚应付 (THB)': 40, 'jimmy 应收回 (THB)': 0,
      '大狗二狗累计已付 (THB)': 0, '大狗二狗尚应付 (THB)': 60, '大狗二狗应收回 (THB)': 0
    })
    expect(rows.summary[0]['导出时间（曼谷）']).toContain('19:00:00')
    expect(rows.records).toHaveLength(1)
    expect(rows.records[0]['客户姓名']).toBe('Jimmy')
    expect(rows.settlementRecords).toEqual([])
  })

  it('keeps current profit separate from payment snapshots and excludes settlement records for another month', () => {
    const records = [settlement(), settlement({ id: 'settlement-september', month: '2026-09', jimmyPaidThb: 400, partnersPaidThb: 600 })]
    const refundedTickets = [{ ...tickets[0], refunds: [refund('show79')] }, ...tickets.slice(1)]
    const snapshot = JSON.stringify({ records, refundedTickets })
    const rows = buildShow79ExportRows(refundedTickets, '2026-10-15', '2026-10', records)
    expect(rows.summary[0]).toMatchObject({
      '月实际利润 (THB)': 50, 'jimmy 40% (THB)': 20, '大狗二狗合计 60% (THB)': 30, '结算状态': '待调整',
      'jimmy 累计已付 (THB)': 40, 'jimmy 尚应付 (THB)': 0, 'jimmy 应收回 (THB)': 20,
      '大狗二狗累计已付 (THB)': 60, '大狗二狗尚应付 (THB)': 0, '大狗二狗应收回 (THB)': 30
    })
    expect(rows.settlementRecords).toHaveLength(1)
    expect(rows.settlementRecords[0]).toMatchObject({
      '结算月份': '2026-10', '实际付款日期': '2026-10-31',
      'jimmy 本次支付 / 收回 (THB)': 40, '大狗二狗本次支付 / 收回 (THB)': 60,
      '登记时月利润 (THB)': 100, '登记时 jimmy 40% (THB)': 40, '登记时大狗二狗 60% (THB)': 60, '备注': '月底分账'
    })
    expect(JSON.stringify({ records, refundedTickets })).toBe(snapshot)
  })

  it('exports signed recovery details and accumulated net payment after a refund adjustment is settled', () => {
    const rows = buildShow79ExportRows([{ ...tickets[0], refunds: [refund('show79')] }], '2026-10-15', '2026-10', [
      settlement(),
      settlement({ id: 'refund-adjustment', snapshotProfitThb: 50, snapshotJimmyThb: 20, snapshotPartnersThb: 30, jimmyPaidThb: -20, partnersPaidThb: -30, paymentDate: '2026-11-01', note: '收回退款差额' })
    ])
    expect(rows.summary[0]).toMatchObject({
      '结算状态': '已结清', 'jimmy 累计已付 (THB)': 20, 'jimmy 尚应付 (THB)': 0, 'jimmy 应收回 (THB)': 0,
      '大狗二狗累计已付 (THB)': 30, '大狗二狗尚应付 (THB)': 0, '大狗二狗应收回 (THB)': 0
    })
    expect(rows.settlementRecords[0]).toMatchObject({
      '实际付款日期': '2026-11-01', 'jimmy 本次支付 / 收回 (THB)': -20, '大狗二狗本次支付 / 收回 (THB)': -30,
      '登记时月利润 (THB)': 50, '备注': '收回退款差额'
    })
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
      '供货商': supplier.name, '项目': project.name, '账务记录数': 1, '有效订单数': 1, '退票单数': 0, '有效人数': 3, '利润合计 (THB)': 150
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
    expect(rows.summary[0]).toMatchObject({ '账务记录数': 4, '有效订单数': 2, '退票单数': 3, '有效人数': 2, '有效商品数量': 2, '数量未填写记录数': 0, '利润合计 (THB)': 275 })
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
      '账务记录数': 1, '有效订单数': 1, '退票单数': 0, '有效人数': 2, '利润合计 (THB)': 100,
      '当日月结另列账务记录数': 2, '当日月结另列有效订单数': 1, '当日月结另列退票单数': 0,
      '当日月结另列有效人数': 1, '当日月结另列利润 (THB)': 70
    })
    expect(rows.summary[0]['日报说明']).toContain('不计入日报')
  })

  it('exports an empty report with clear zero totals and its selected scope', () => {
    const rows = buildReportExportRows(buildReport([], reportQuery()), '')
    expect(rows.records).toEqual([])
    expect(rows.monthlyRecords).toEqual([])
    expect(rows.summary[0]).toMatchObject({ '账务记录数': 0, '有效订单数': 0, '退票单数': 0, '有效人数': 0, '有效商品数量': 0, '利润合计 (THB)': 0 })
  })

  it('distinguishes accounting records, effective orders and refunded orders without counting refund events as orders', () => {
    const report = buildReport([
      reportTicket('ordinary', { personCount: 1 }),
      reportTicket('full', { personCount: 2, refunds: [refund('full', { isFull: true, personCount: 2, refundRevenueThb: 1000, returnedCostThb: 900 })] }),
      reportTicket('partial', { personCount: 4, refunds: [refund('partial'), refund('partial', { id: 'second-partial' })] }),
      reportTicket('cancelled', { personCount: 2, refunds: [refund('cancelled', { isFull: true, personCount: 2, cancelledAt: supplier.updatedAt })] }),
      reportTicket('commission', { entryMode: 'profit_only', amountBasis: 'total', manualProfitThb: 75, personCount: 100, settlementMode: 'monthly' }),
      reportTicket('items', { quantityUnit: 'item', personCount: 4 })
    ], reportQuery())
    const rows = buildReportExportRows(report, '')
    expect(rows.summary[0]).toMatchObject({
      '账务记录数': 6, '有效订单数': 4, '退票单数': 2,
      '有效人数': 5, '有效商品数量': 4, '利润合计 (THB)': 525
    })
    expect(rows.records).toHaveLength(6)
    expect(rows.summary[0]['单数口径']).toContain('含商品')
    expect(rows.summary[0]['单数口径']).toContain('部分退票和全部退票均计入')
    expect(rows.summary[0]['单数口径']).toContain('已撤销的退票不计入')
    expect(rows.summary[0]).not.toHaveProperty('记录数')
  })

  it('applies the same count definitions to daily and separately listed monthly-settlement orders', () => {
    const fixtures = (settlementMode: 'daily' | 'monthly') => [
      reportTicket(`${settlementMode}-ordinary`, { settlementMode, personCount: 1 }),
      reportTicket(`${settlementMode}-full`, { settlementMode, personCount: 2, refunds: [refund(`${settlementMode}-full`, { isFull: true, personCount: 2, refundRevenueThb: 1000, returnedCostThb: 900 })] }),
      reportTicket(`${settlementMode}-partial`, { settlementMode, personCount: 3, refunds: [refund(`${settlementMode}-partial`)] }),
      reportTicket(`${settlementMode}-cancelled`, { settlementMode, personCount: 2, refunds: [refund(`${settlementMode}-cancelled`, { cancelledAt: supplier.updatedAt })] }),
      reportTicket(`${settlementMode}-items`, { settlementMode, quantityUnit: 'item', personCount: 4 })
    ]
    const report = buildReport([
      ...fixtures('daily'), ...fixtures('monthly'),
      reportTicket('commission', { entryMode: 'profit_only', amountBasis: 'total', manualProfitThb: 75, personCount: 100, settlementMode: 'monthly' })
    ], reportQuery({ mode: 'day' }))
    const rows = buildReportExportRows(report, '')
    expect(rows.summary[0]).toMatchObject({
      '账务记录数': 5, '有效订单数': 4, '退票单数': 2,
      '有效人数': 5, '有效商品数量': 4, '利润合计 (THB)': 450,
      '当日月结另列账务记录数': 6, '当日月结另列有效订单数': 4, '当日月结另列退票单数': 2,
      '当日月结另列有效人数': 5, '当日月结另列有效商品数量': 4, '当日月结另列利润 (THB)': 525
    })
    expect(rows.records).toHaveLength(5)
    expect(rows.monthlyRecords).toHaveLength(6)
    expect(rows.summary[0]['日报说明']).toContain('按相同单数口径统计')
  })
})
