import { describe, expect, it } from 'vitest'
import { bySupplier, getProfit, summarise, ticketsInMonth, ticketsOnDate } from './stats'
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

describe('profit statistics', () => {
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
