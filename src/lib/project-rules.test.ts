import { describe, expect, it } from 'vitest'
import type { Project, TicketInput, TicketRecord } from '../types'
import { isCarnivalProject, isKohLarnDayTripProject, resolveProjectRules, ticketSettlementMode, validateProjectRules } from './project-rules'
import { chooseProject, chooseProjectOption } from './project-selection'
import { ticketsForDailyStats, ticketsInMonth, ticketsInYear, summarise } from './stats'
import { getOriginalTicketAmounts } from './ticket-amounts'
import { buildReport } from './reports'
import { createLedgerBackup, buildTicketExportRows } from './export'

const project: Project = { id: 'p', userId: 'u', supplierId: 's', supplierName: '供货商', name: '普通门票', normalizedName: '普通门票', subItemName: '', normalizedSubItemName: '', defaultCostThb: 95, defaultAgentPriceThb: 105, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', syncStatus: 'pending' }
const input: TicketInput = { projectId: 'p', supplierName: '供货商', projectName: project.name, subItemName: '', issueDate: '2026-10-31', issueTime: '23:59', personCount: 4, agentPriceThb: 105, costThb: 95, note: '' }
const ticket: TicketRecord = { ...input, id: 't', userId: 'u', supplierId: 's', createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: null, syncStatus: 'pending' }

describe('package rules and historical settlement snapshots', () => {
  it.each(['包车', '包船', '芭提亚游艇会', '整船', '整车', '整床', '整间', '包台', '包厢', '私人床位'])('infers a total for %s, without rewriting the catalogue', name => {
    const row = { ...project, name }
    expect(resolveProjectRules(row)).toEqual({ defaultAmountBasis: 'total', settlementMode: 'daily' })
    expect(row).not.toHaveProperty('defaultAmountBasis')
  })
  it('resolves ordinary tickets, items and commission, while respecting explicit choices', () => {
    expect(resolveProjectRules(project)).toEqual({ defaultAmountBasis: 'per_person', settlementMode: 'daily' })
    expect(resolveProjectRules({ ...project, quantityUnit: 'item' }).defaultAmountBasis).toBe('per_person')
    expect(resolveProjectRules({ ...project, name: '嘉年华', settlementMode: 'daily', defaultAmountBasis: 'total' })).toEqual({ defaultAmountBasis: 'total', settlementMode: 'daily' })
    expect(resolveProjectRules({ ...project, entryMode: 'profit_only', settlementMode: 'daily' })).toEqual({ defaultAmountBasis: 'per_person', settlementMode: 'monthly' })
  })
  it('identifies the two monthly main-ledger channels without including other Koh Larn products', () => {
    expect(isKohLarnDayTripProject('格兰岛跟团一日游')).toBe(true)
    expect(isKohLarnDayTripProject('黑珍珠海盗船格兰岛半日游')).toBe(false)
    expect(isCarnivalProject('东方嘉年华')).toBe(true)
    expect(isCarnivalProject('格兰岛跟团一日游')).toBe(false)
  })
  it('applies package defaults consistently to name selection, search and recent option selection', () => {
    const regular = { ...project, subItemName: '普通门票' }
    const table = { ...project, id: 'table', subItemName: 'VIP包台', settlementMode: 'monthly' as const }
    const choices = [regular, table]
    const picked = chooseProjectOption(input, choices, table.id)
    expect(picked).toMatchObject({ amountBasis: 'total', settlementMode: 'monthly', personCount: 4 })
    expect(getOriginalTicketAmounts(picked).profitThb).toBe(10)
    expect(chooseProjectOption(picked, choices, regular.id)).toMatchObject({ amountBasis: 'per_person', settlementMode: 'daily', personCount: 4 })
    expect(chooseProject({ ...input, amountBasis: 'total' }, [project], project.name).amountBasis).toBe('per_person')
    expect(project).not.toHaveProperty('defaultAmountBasis')
  })
  it('uses saved settlement instead of current name classification, in daily, month and year statistics', () => {
    const daily = { ...ticket, projectName: '嘉年华', settlementMode: 'daily' as const }
    const monthly = { ...ticket, id: 'm', settlementMode: 'monthly' as const }
    expect(ticketsForDailyStats([daily, monthly], ticket.issueDate)).toEqual([daily])
    expect(summarise(ticketsInMonth([daily, monthly], '2026-10')).profitThb).toBe(20)
    expect(summarise(ticketsInYear([daily, monthly], '2026')).profitThb).toBe(20)
    const report = buildReport([daily, monthly], { mode: 'day', date: ticket.issueDate, month: '2026-10', startDate: ticket.issueDate, endDate: ticket.issueDate, supplierId: '' })
    expect(report.records).toEqual([daily])
    expect(report.quantity.peopleCount).toBe(8)
    expect(ticketSettlementMode({ ...ticket, projectName: '嘉年华' })).toBe('monthly')
    expect(ticketSettlementMode(ticket)).toBe('daily')
  })
  it('exports explicit defaults and snapshots, leaving missing legacy fields missing', () => {
    const backup = createLedgerBackup({ suppliers: [], projects: [{ ...project, defaultAmountBasis: 'total', settlementMode: 'monthly' }], tickets: [{ ...ticket, settlementMode: 'daily' }, { ...ticket, id: 'old' }] })
    expect(backup.projects[0]).toMatchObject({ defaultAmountBasis: 'total', settlementMode: 'monthly' })
    expect(backup.tickets[0].settlementMode).toBe('daily')
    expect(JSON.parse(JSON.stringify(backup)).tickets[1]).not.toHaveProperty('settlementMode')
    expect(buildTicketExportRows([{ ...ticket, settlementMode: 'monthly' }])[0]['结算方式']).toBe('月结')
  })
  it('rejects non-enum rules', () => {
    expect(() => validateProjectRules({ defaultAmountBasis: 'bad' as any })).toThrow('默认计价')
    expect(() => validateProjectRules({ settlementMode: 'bad' as any })).toThrow('结算')
  })
})
