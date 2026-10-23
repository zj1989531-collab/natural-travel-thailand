import { describe, expect, it } from 'vitest'
import { bySupplier, getProfit, isMonthlySettlementProject, monthDateRange, summarise, ticketsForDailyStats, ticketsInMonth, ticketsOnDate } from './stats'
import { getBangkokDate, getBangkokMonth } from './format'
import type { TicketRecord } from '../types'

const makeTicket = (overrides: Partial<TicketRecord>): TicketRecord => ({
  id: 'ticket-1',
  userId: 'user-1',
  issueDate: '2026-10-13',
  supplierId: 'supplier-1',
  supplierName: '自然航空',
  projectId: 'project-1',
  projectName: '往返机票',
  subItemName: '经济舱',
  agentPriceThb: 1000,
  costThb: 740,
  note: '',
  createdAt: '2026-10-13T01:00:00.000Z',
  updatedAt: '2026-10-13T01:00:00.000Z',
  deletedAt: null,
  syncStatus: 'synced',
  ...overrides
})

describe('monthly commission settlement statistics', () => {
  it('includes manually entered profit only in monthly profit, without fake sales, costs or ticket counts', () => {
    const commission = makeTicket({ entryMode: 'profit_only', projectName: '示例返佣', manualProfitThb: 123.45, agentPriceThb: 999, costThb: 999 })
    expect(getProfit(commission)).toBe(123.45)
    expect(ticketsForDailyStats([commission], commission.issueDate)).toEqual([])
    expect(summarise(ticketsInMonth([commission], '2026-10'))).toEqual({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 123.45 })
    expect(bySupplier([commission])[0]).toMatchObject({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 123.45 })
    expect(summarise([{ ...commission, manualProfitThb: 200 }]).profitThb).toBe(200)
    expect(summarise([{ ...commission, deletedAt: '2026-10-13T02:00:00Z' }]).profitThb).toBe(0)
  })
  it.each(['69秀', '69 秀', '７９秀', '79秀', '泰拳', 'MAX 泰拳', '嘉年华', '东方嘉年华', '格兰岛一日游', '格兰岛跟团一日游', '潜水', '芭提雅潜水（SH）'])('classifies %s as monthly settlement', (name) => {
    expect(isMonthlySettlementProject(name)).toBe(true)
  })

  it.each(['89成人秀', '99成人秀', '169秀', '格兰岛长尾船包船', '黑珍珠海盗船格兰岛半日游', '芭提亚游艇会', '曼谷续签'])('keeps %s in daily statistics', (name) => {
    expect(isMonthlySettlementProject(name)).toBe(false)
  })

  it('excludes monthly projects from daily metrics and both independent shows from main monthly totals', () => {
    const tickets = ['69秀', '79秀', '泰拳', '东方嘉年华', '格兰岛跟团一日游', '芭提雅潜水（SH）', '普通项目'].map((projectName, index) => makeTicket({ id: `record-${index}`, projectName, agentPriceThb: 100, costThb: 80 }))
    expect(summarise(ticketsForDailyStats(tickets, '2026-10-13'))).toEqual({ count: 1, agentPriceThb: 100, costThb: 80, profitThb: 20 })
    const monthly = ticketsInMonth(tickets, '2026-10')
    expect(summarise(monthly)).toEqual({ count: 5, agentPriceThb: 500, costThb: 400, profitThb: 100 })
    expect(bySupplier(monthly)[0]).toMatchObject({ count: 5, agentPriceThb: 500, costThb: 400, profitThb: 100 })
    expect(monthly.map(ticket => ticket.projectName)).not.toContain('69秀')
    expect(monthly.map(ticket => ticket.projectName)).not.toContain('79秀')
    expect(ticketsOnDate(tickets, '2026-10-13')).toHaveLength(7)
  })

  it('uses the parent project only, not notes or subitem text', () => {
    const ticket = makeTicket({ projectName: '普通项目', subItemName: '泰拳', note: '69秀' })
    expect(ticketsForDailyStats([ticket], ticket.issueDate)).toEqual([ticket])
  })

  it('recalculates on project and price edits and excludes deletions from both reports', () => {
    const daily = makeTicket({ projectName: '普通项目', agentPriceThb: 100, costThb: 80 })
    const edited = { ...daily, projectName: '泰拳', agentPriceThb: 120 }
    expect(summarise(ticketsForDailyStats([daily], daily.issueDate)).profitThb).toBe(20)
    expect(summarise(ticketsForDailyStats([edited], edited.issueDate)).count).toBe(0)
    expect(summarise(ticketsInMonth([edited], '2026-10')).profitThb).toBe(40)
    const deleted = { ...edited, deletedAt: '2026-10-13T02:00:00.000Z' }
    expect(summarise(ticketsForDailyStats([deleted], deleted.issueDate)).count).toBe(0)
    expect(summarise(ticketsInMonth([deleted], '2026-10')).count).toBe(0)
  })

  it('includes the 1st and last day, excluding adjacent months', () => {
    const tickets = ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01'].map((issueDate) => makeTicket({ id: issueDate, issueDate, projectName: '泰拳' }))
    expect(ticketsInMonth(tickets, '2026-10').map((ticket) => ticket.issueDate)).toEqual(['2026-10-01', '2026-10-31'])
    expect(monthDateRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthDateRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(() => monthDateRange('2026-13')).toThrow()
  })

  it('changes reporting month at Bangkok midnight rather than UTC midnight', () => {
    const before = new Date('2026-09-30T16:59:59Z')
    const after = new Date('2026-09-30T17:00:00Z')
    expect(getBangkokDate(before)).toBe('2026-09-30')
    expect(getBangkokMonth(before)).toBe('2026-09')
    expect(getBangkokDate(after)).toBe('2026-10-01')
    expect(getBangkokMonth(after)).toBe('2026-10')
  })
})

describe('profit statistics', () => {
  it('uses multiplied totals in daily, monthly and supplier metrics, recalculating on edits and deletions', () => {
    const ticket = makeTicket({ amountBasis: 'per_person', personCount: 3, agentPriceThb: 650, costThb: 600 })
    const total = { count: 1, agentPriceThb: 1950, costThb: 1800, profitThb: 150 }
    expect(summarise(ticketsForDailyStats([ticket], ticket.issueDate))).toEqual(total)
    expect(summarise(ticketsInMonth([ticket], '2026-10'))).toEqual(total)
    expect(bySupplier([ticket])[0]).toMatchObject(total)
    expect(summarise([{ ...ticket, personCount: 5 }]).profitThb).toBe(250)
    expect(summarise([{ ...ticket, deletedAt: '2026-10-13T02:00:00Z' }]).profitThb).toBe(0)
    const monthly = { ...ticket, projectName: '泰拳' }
    expect(ticketsForDailyStats([monthly], monthly.issueDate)).toEqual([])
    expect(summarise(ticketsInMonth([monthly], '2026-10'))).toEqual(total)
    const commission = { ...ticket, entryMode: 'profit_only' as const, manualProfitThb: 50.25 }
    expect(ticketsForDailyStats([commission], commission.issueDate)).toEqual([])
    expect(summarise([commission])).toEqual({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 150.75 })
    expect(bySupplier([commission])[0].profitThb).toBe(150.75)
  })
  it('keeps all financial totals and ticket counts unchanged when headcount changes', () => {
    const ticket = makeTicket({ personCount: 5 })
    expect(getProfit(ticket)).toBe(260)
    expect(summarise([ticket])).toEqual(summarise([{ ...ticket, personCount: 1 }]))
    expect(bySupplier([ticket])[0]).toMatchObject({ count: 1, agentPriceThb: 1000, costThb: 740, profitThb: 260 })
    expect(summarise([makeTicket({ entryMode: 'profit_only', manualProfitThb: 100, personCount: 10 })])).toEqual({ count: 0, agentPriceThb: 0, costThb: 0, profitThb: 100 })
  })
  it('calculates profit from agent price minus supplier cost', () => {
    expect(getProfit(makeTicket({ agentPriceThb: 1250.5, costThb: 800.25 }))).toBe(450.25)
  })

  it('does not include deleted records in totals', () => {
    const tickets = [
      makeTicket({ id: 'active', agentPriceThb: 1000, costThb: 700 }),
      makeTicket({ id: 'deleted', agentPriceThb: 9999, costThb: 0, deletedAt: '2026-10-13T02:00:00.000Z' })
    ]
    expect(summarise(tickets)).toEqual({ count: 1, agentPriceThb: 1000, costThb: 700, profitThb: 300 })
  })

  it('groups date-only ticket records into their Bangkok calendar day and month', () => {
    const tickets = [
      makeTicket({ id: 'october', issueDate: '2026-10-01' }),
      makeTicket({ id: 'september', issueDate: '2026-09-30' })
    ]
    expect(ticketsOnDate(tickets, '2026-10-01').map((ticket) => ticket.id)).toEqual(['october'])
    expect(ticketsInMonth(tickets, '2026-10').map((ticket) => ticket.id)).toEqual(['october'])
  })

  it('ranks suppliers by profit, then agent price', () => {
    const tickets = [
      makeTicket({ id: 'a', supplierId: 'a', supplierName: '供应商 A', agentPriceThb: 1300, costThb: 850 }),
      makeTicket({ id: 'b', supplierId: 'b', supplierName: '供应商 B', agentPriceThb: 2200, costThb: 1800 }),
      makeTicket({ id: 'a2', supplierId: 'a', supplierName: '供应商 A', agentPriceThb: 900, costThb: 650 })
    ]
    expect(bySupplier(tickets).map((supplier) => [supplier.supplierName, supplier.profitThb, supplier.count])).toEqual([
      ['供应商 A', 700, 2],
      ['供应商 B', 400, 1]
    ])
  })
})
