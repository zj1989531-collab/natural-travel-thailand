import type { SupplierSummary, Summary, TicketRecord } from '../types'

export const getProfit = (ticket: Pick<TicketRecord, 'agentPriceThb' | 'costThb'>): number =>
  ticket.agentPriceThb - ticket.costThb

export const activeTickets = (tickets: TicketRecord[]): TicketRecord[] =>
  tickets.filter((ticket) => !ticket.deletedAt)

export const summarise = (tickets: TicketRecord[]): Summary =>
  activeTickets(tickets).reduce<Summary>(
    (total, ticket) => ({
      count: total.count + 1,
      agentPriceThb: total.agentPriceThb + ticket.agentPriceThb,
      costThb: total.costThb + ticket.costThb,
      profitThb: total.profitThb + getProfit(ticket)
    }),
    { count: 0, agentPriceThb: 0, costThb: 0, profitThb: 0 }
  )

export const ticketsOnDate = (tickets: TicketRecord[], date: string): TicketRecord[] =>
  tickets.filter((ticket) => ticket.issueDate === date)

export const ticketsInMonth = (tickets: TicketRecord[], month: string): TicketRecord[] =>
  tickets.filter((ticket) => ticket.issueDate.startsWith(month))

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
    existing.count += 1
    existing.agentPriceThb += ticket.agentPriceThb
    existing.costThb += ticket.costThb
    existing.profitThb += getProfit(ticket)
    groups.set(ticket.supplierId, existing)
  })

  return [...groups.values()].sort((a, b) => b.profitThb - a.profitThb || b.agentPriceThb - a.agentPriceThb)
}
