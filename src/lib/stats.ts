import type { SupplierSummary, Summary, TicketRecord } from '../types'
import { getTicketAmounts } from './ticket-amounts'
import { getRefundState } from './refunds'
import { isValidCalendarDate } from './format'
import { ticketSettlementMode } from './project-rules'
export { isMonthlySettlementProject } from './project-rules'

export const getProfit = (ticket: Parameters<typeof getTicketAmounts>[0]): number => getTicketAmounts(ticket).profitThb

export const activeTickets = (tickets: TicketRecord[]): TicketRecord[] =>
  tickets.filter((ticket) => !ticket.deletedAt)

export const summarise = (tickets: TicketRecord[]): Summary =>
  activeTickets(tickets).reduce<Summary>(
    (total, ticket) => ({
      count: total.count + (ticket.entryMode === 'profit_only' || getRefundState(ticket).full ? 0 : 1),
      agentPriceThb: total.agentPriceThb + getTicketAmounts(ticket).agentPriceThb,
      costThb: total.costThb + getTicketAmounts(ticket).costThb,
      profitThb: total.profitThb + getProfit(ticket)
    }),
    { count: 0, agentPriceThb: 0, costThb: 0, profitThb: 0 }
  )

export const ticketsOnDate = (tickets: TicketRecord[], date: string): TicketRecord[] =>
  tickets.filter((ticket) => ticket.issueDate === date)

// Settlement classification affects the daily dashboard only. Keep the source
// records unchanged so the full ledger, monthly report and export retain them.
export const ticketsForDailyStats = (tickets: TicketRecord[], date: string): TicketRecord[] =>
  activeTickets(ticketsOnDate(tickets, date)).filter((ticket) => ticketSettlementMode(ticket) !== 'monthly')

export const monthDateRange = (month: string): { start: string; end: string } => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式必须为 YYYY-MM。')
  const [year, number] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export const ticketsInMonth = (tickets: TicketRecord[], month: string): TicketRecord[] => {
  const { start, end } = monthDateRange(month)
  return tickets.filter((ticket) => /^\d{4}-\d{2}-\d{2}$/.test(ticket.issueDate) && ticket.issueDate >= start && ticket.issueDate <= end)
}

export const yearDateRange = (year: string): { start: string; end: string } => {
  if (!/^[1-9]\d{3}$/.test(year)) throw new Error('年份格式必须为 YYYY。')
  return { start: `${year}-01-01`, end: `${year}-12-31` }
}

export const ticketsInYear = (tickets: TicketRecord[], year: string): TicketRecord[] => {
  const { start, end } = yearDateRange(year)
  return tickets.filter((ticket) => isValidCalendarDate(ticket.issueDate) && ticket.issueDate >= start && ticket.issueDate <= end)
}

export const bySupplier = (tickets: TicketRecord[]): SupplierSummary[] => {
  const groups = new Map<string, SupplierSummary>()

  activeTickets(tickets).forEach((ticket) => {
    const existing = groups.get(ticket.supplierId) ?? {
      supplierId: ticket.supplierId,
      supplierName: ticket.supplierName,
      count: 0,
      agentPriceThb: 0,
      costThb: 0,
      profitThb: 0
    }
    existing.count += ticket.entryMode === 'profit_only' || getRefundState(ticket).full ? 0 : 1
    existing.agentPriceThb += getTicketAmounts(ticket).agentPriceThb
    existing.costThb += getTicketAmounts(ticket).costThb
    existing.profitThb += getProfit(ticket)
    groups.set(ticket.supplierId, existing)
  })

  return [...groups.values()].sort((a, b) => b.profitThb - a.profitThb || b.agentPriceThb - a.agentPriceThb)
}
