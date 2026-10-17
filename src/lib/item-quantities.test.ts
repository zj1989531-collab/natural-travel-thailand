import { describe, expect, it } from 'vitest'
import type { Project, TicketInput, TicketRecord } from '../types'
import { chooseProject, chooseProjectOption } from './project-selection'
import { getTicketAmounts } from './ticket-amounts'
import { buildReport, type ReportQuery } from './reports'
import { buildReportExportRows, buildTicketExportRows, createLedgerBackup } from './export'
import { validateRefundInput } from './refund-input'
import { quantityLabels } from './quantity'
import { buildShow79Report, mainLedgerTickets } from './show79'

const projects: Project[] = ['果冻（男）', '果冻（女）', '双效', '小蓝片'].map((subItemName, i) => ({ id: `project-${i}`, userId: 'test-user', supplierId: 'test-supplier', supplierName: '测试供货商', name: '药品', normalizedName: '药品', subItemName, normalizedSubItemName: subItemName, defaultCostThb: [95,105,160,95][i], defaultAgentPriceThb: 0, manualAgentPrice: true, quantityUnit: 'item', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', syncStatus: 'synced' }))
const input: TicketInput = { issueDate: '2026-10-14', issueTime: '09:30', projectName: '', projectId: '', supplierName: '', subItemName: '', personCount: 2, quantityUnit: 'person', amountBasis: 'per_person', agentPriceThb: NaN, costThb: NaN, note: '' }
const ticket: TicketRecord = { ...input, id: 'item-test', userId: 'test-user', supplierId: projects[0].supplierId, supplierName: projects[0].supplierName, projectName: '药品', projectId: projects[0].id, subItemName: projects[0].subItemName, quantityUnit: 'item', agentPriceThb: 150, costThb: 95, createdAt: projects[0].createdAt, updatedAt: projects[0].updatedAt, deletedAt: null, syncStatus: 'synced' }
const query: ReportQuery = { mode: 'month', month: '2026-10', date: '2026-10-14', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '' }

describe('item quantities and manual selling prices', () => {
  it('chooses quantity mode at parent level without guessing a package or selling price', () => {
    const selected = chooseProject(input, projects, '药品')
    expect(selected).toMatchObject({ quantityUnit: 'item', projectId: '', supplierName: '' })
    expect(Number.isNaN(selected.agentPriceThb)).toBe(true)
    expect(chooseProjectOption(selected, projects, '')).toMatchObject({ quantityUnit: 'item', projectId: '' })
  })
  it.each(projects)('prefills only the cost for $subItemName and always requires a fresh selling price', (project) => {
    const selected = chooseProjectOption({ ...input, projectName: '药品', agentPriceThb: 500 }, projects, project.id)
    expect(selected).toMatchObject({ quantityUnit: 'item', personCount: 2, costThb: project.defaultCostThb, supplierName: '测试供货商', subItemName: project.subItemName })
    expect(Number.isNaN(selected.agentPriceThb)).toBe(true)
    expect(getTicketAmounts({ ...selected, agentPriceThb: 200 }).profitThb).toBe((200-project.defaultCostThb)*2)
    expect(project.defaultAgentPriceThb).toBe(0)
  })
  it('preserves a fixed-price project and resets item labels when changing back to tickets', () => {
    const standard = { ...projects[0], id: 'ticket-project', name: '普通门票', manualAgentPrice: false, quantityUnit: 'person' as const, defaultAgentPriceThb: 200 }
    expect(chooseProject({ ...input, quantityUnit: 'item' }, [standard], standard.name)).toMatchObject({ quantityUnit: 'person', agentPriceThb: 200 })
    expect(quantityLabels(standard)).toEqual({ label: '人数', unit: '人', single: '单人' })
    expect(quantityLabels(projects[0])).toEqual({ label: '数量', unit: '件', single: '单件' })
  })
  it('reports item counts separately from ticket headcounts with the same daily and monthly profit', () => {
    const people = { ...ticket, id: 'ticket-people', projectName: '普通门票', quantityUnit: 'person' as const, personCount: 3 }
    const report = buildReport([ticket, people], query)
    expect(report.quantity).toMatchObject({ recordCount: 1, peopleCount: 3 })
    expect(report.itemQuantity).toMatchObject({ recordCount: 1, quantityCount: 2, unknownCount: 0, days: [{ date: '2026-10-14', recordCount: 1, quantityCount: 2, unknownCount: 0 }] })
    expect(report.recordedPeople).toBe(3)
    expect(report.summary.profitThb).toBe(275)
    const medicine = buildReport([ticket, people], { ...query, mode: 'day', projectName: '药品' })
    expect(medicine.quantity.peopleCount).toBe(0)
    expect(medicine.itemQuantity.quantityCount).toBe(2)
    expect(medicine.summary.profitThb).toBe(110)
  })
  it('deducts returned item quantities without creating ticket people, preserving original-period profit', () => {
    const row = { ...ticket, refunds: [{ id: 'item-refund', userId: ticket.userId, ticketId: ticket.id, personCount: 1, isFull: false, refundRevenueThb: 150, returnedCostThb: 95, refundDate: '2026-11-01', refundTime: '09:00', note: '', cancelledAt: null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'synced' as const }] }
    expect(buildReport([row], query).itemQuantity.quantityCount).toBe(1)
    expect(buildReport([row], query).quantity.peopleCount).toBe(0)
    expect(getTicketAmounts(row).profitThb).toBe(55)
    expect(() => validateRefundInput(row, { ...row.refunds[0], operationId: 'second', personCount: 2 }, '2026-11-01')).toThrow('剩余数量')
  })
  it('exports item quantities, unit prices and metadata without relabeling them as people', () => {
    expect(buildTicketExportRows([ticket])[0]).toMatchObject({ '人数': '', '数量': 2, '有效数量': 2, '有效人数': '', '计价方式': '按数量计算', '单件代理售价 (THB)': 150, '单件供货商成本 (THB)': 95, '单人代理售价 (THB)': '', '利润 (THB)': 110 })
    const backup = createLedgerBackup({ suppliers: [], projects, tickets: [ticket] })
    expect(backup.projects[0]).toMatchObject({ manualAgentPrice: true, quantityUnit: 'item' })
    expect(backup.tickets[0].quantityUnit).toBe('item')
  })
  it('keeps two medicine packages for one customer as independent priced rows and excludes 79 from their report and Excel', () => {
    const common = { ...input, guestName: 'Jimmy', issueDate: '2026-10-14', projectName: '药品', note: '同客多项药品' }
    const selectedMale = chooseProjectOption(common, projects, projects[0].id)
    const selectedFemale = chooseProjectOption(common, projects, projects[1].id)
    expect(selectedMale.agentPriceThb).toBeNaN()
    expect(selectedFemale.agentPriceThb).toBeNaN()
    const medicine: TicketRecord[] = [
      { ...ticket, ...selectedMale, id: 'medicine-male', supplierId: projects[0].supplierId, personCount: 1, agentPriceThb: 150 },
      { ...ticket, ...selectedFemale, id: 'medicine-female', supplierId: projects[1].supplierId, personCount: 2, agentPriceThb: 180 }
    ]
    const show79: TicketRecord = { ...ticket, id: 'independent-79', guestName: 'Aditya', projectName: '79秀', subItemName: '门票', quantityUnit: 'person', personCount: 4, agentPriceThb: 500, costThb: 450 }
    const source = [...medicine, show79]
    const original = structuredClone(source)
    const report = buildReport(source, query)
    expect(report.records.map(row => row.id).sort()).toEqual(['medicine-female', 'medicine-male'])
    expect(report.counts).toEqual({ accountingRecordCount: 2, effectiveOrderCount: 2, refundedOrderCount: 0 })
    expect(report.quantity).toMatchObject({ recordCount: 0, peopleCount: 0 })
    expect(report.recordedPeople).toBe(0)
    expect(report.itemQuantity).toMatchObject({ recordCount: 2, quantityCount: 3 })
    expect(report.effectiveQuantity).toMatchObject({ ticketCount: 0, itemCount: 3 })
    expect(report.summary).toEqual({ count: 2, agentPriceThb: 510, costThb: 305, profitThb: 205 })
    const daily = buildReport(source, { ...query, mode: 'day', projectName: '药品', guestName: 'Jimmy' })
    expect(daily.itemQuantity.quantityCount).toBe(3)
    expect(daily.summary.profitThb).toBe(205)

    const rows = buildTicketExportRows(mainLedgerTickets(source))
    expect(rows).toHaveLength(2)
    const byPackage = Object.fromEntries(rows.map(row => [row['子项 / 套餐'], row]))
    expect(byPackage['果冻（男）']).toMatchObject({ '客户姓名': 'Jimmy', '人数': '', '有效人数': '', '数量': 1, '单件代理售价 (THB)': 150, '单件供货商成本 (THB)': 95, '代理售价 (THB)': 150, '供货商成本 (THB)': 95, '利润 (THB)': 55 })
    expect(byPackage['果冻（女）']).toMatchObject({ '客户姓名': 'Jimmy', '人数': '', '有效人数': '', '数量': 2, '单件代理售价 (THB)': 180, '单件供货商成本 (THB)': 105, '代理售价 (THB)': 360, '供货商成本 (THB)': 210, '利润 (THB)': 150 })
    expect(buildReportExportRows(daily, '全部供货商').summary[0]).toMatchObject({ '账务记录数': 2, '有效订单数': 2, '有效人数': 0, '有效商品数量': 3, '利润合计 (THB)': 205 })
    const backup = createLedgerBackup({ suppliers: [], projects, tickets: medicine })
    expect(backup.tickets).toHaveLength(2)
    expect(backup.tickets.map(row => [row.projectId, row.guestName, row.personCount, row.agentPriceThb, row.costThb])).toEqual([
      ['project-0', 'Jimmy', 1, 150, 95], ['project-1', 'Jimmy', 2, 180, 105]
    ])
    expect(buildShow79Report(source, query.date, query.month)).toMatchObject({ dayPeople: 4, monthPeople: 4, profitThb: 200, jimmyThb: 80, partnersThb: 120 })
    expect(source).toEqual(original)
  })
})
