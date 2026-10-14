import { describe, expect, it } from 'vitest'
import type { Project, TicketInput, TicketRecord } from '../types'
import { cleanProjectLabel, projectDisplay, ticketDisplay } from './project-labels'
import { chooseProject, chooseProjectOption, projectNames, projectOptionLabel } from './project-selection'
import { buildReport } from './reports'
import { buildTicketExportRows, createLedgerBackup } from './export'
import { getTicketAmounts } from './ticket-amounts'

const project: Project = { id: 'project-test', userId: 'user-test', name: '99成人秀', normalizedName: '99成人秀', subItemName: '普通票（成人）', normalizedSubItemName: '普通票（成人）', supplierId: 'supplier-test', supplierName: '成人测试供货商', defaultCostThb: 490, defaultAgentPriceThb: 550, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', syncStatus: 'synced' }
const ticket: TicketRecord = { id: 'ticket-test', userId: project.userId, projectId: project.id, projectName: project.name, subItemName: project.subItemName, supplierId: project.supplierId, supplierName: project.supplierName, issueDate: '2026-10-14', personCount: 2, amountBasis: 'per_person', agentPriceThb: 550, costThb: 490, note: '成人备注保留', createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: null, syncStatus: 'synced' }
const form: TicketInput = { issueDate: '2026-10-14', projectName: '', projectId: '', subItemName: '', supplierName: '', personCount: 2, amountBasis: 'per_person', agentPriceThb: NaN, costThb: NaN, note: '' }

describe('project label cleanup without financial changes', () => {
  it.each([
    ['89成人秀', '89秀'], ['99成人秀', '99秀'], ['普通票（成人）', '普通票'],
    ['普通票 ( 成人 )', '普通票'], ['门票＋自助餐 · 成人', '门票＋自助餐'],
    ['成人票', '票'], ['1楼靠窗成人票', '1楼靠窗票'], ['成人', ''],
    ['儿童票', '儿童票'], ['成人课程成人套餐', '课程套餐']
  ])('renames %s to %s idempotently', (oldName, newName) => {
    expect(cleanProjectLabel(oldName)).toBe(newName)
    expect(cleanProjectLabel(cleanProjectLabel(oldName))).toBe(newName)
  })
  it('preserves IDs, suppliers, pricing, notes and historical storage snapshots', () => {
    const shownProject = projectDisplay(project)
    expect(shownProject).toMatchObject({ id: project.id, name: '99秀', subItemName: '普通票', normalizedName: '99秀', normalizedSubItemName: '普通票', defaultCostThb: 490, defaultAgentPriceThb: 550, supplierName: project.supplierName })
    const shownTicket = ticketDisplay(ticket)
    expect(shownTicket).toMatchObject({ id: ticket.id, projectName: '99秀', subItemName: '普通票', note: ticket.note, supplierName: ticket.supplierName })
    expect(getTicketAmounts(shownTicket)).toEqual(getTicketAmounts(ticket))
    expect(project.name).toBe('99成人秀')
    expect(ticket.projectName).toBe('99成人秀')
    expect(createLedgerBackup({ projects: [], suppliers: [], tickets: [ticket] }).tickets[0].projectName).toBe('99成人秀')
  })
  it('groups old and new display names and keeps child IDs and prices selectable', () => {
    expect(projectNames([project, { ...project, id: 'new', name: '99秀' }])).toEqual(['99秀'])
    expect(chooseProject(form, [project], '99秀')).toMatchObject({ projectId: project.id, projectName: '99秀', subItemName: '普通票', agentPriceThb: 550, costThb: 490 })
    expect(chooseProjectOption({ ...form, projectName: '99秀' }, [project], project.id)).toMatchObject({ projectId: project.id, projectName: '99秀', subItemName: '普通票' })
    expect(projectOptionLabel(project, [project])).toBe('普通票')
  })
  it('queries historical records by the new label without changing profit, quantity or storage', () => {
    const report = buildReport([ticket], { mode: 'month', month: '2026-10', date: '2026-10-14', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '', projectName: '99秀' })
    expect(report.records).toHaveLength(1)
    expect(report.records[0].projectName).toBe('99秀')
    expect(report.summary.profitThb).toBe(120)
    expect(report.quantity.peopleCount).toBe(2)
    expect(ticket.projectName).toBe('99成人秀')
    expect(buildTicketExportRows([ticket])[0]).toMatchObject({ '项目': '99秀', '子项 / 套餐': '普通票', '利润 (THB)': 120, '人数': 2 })
  })
})
