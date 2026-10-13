import type { TicketRecord } from '../types'

type RefundSource = Pick<TicketRecord, 'personCount' | 'refunds'> & Partial<Pick<TicketRecord, 'id' | 'userId'>>
export const getRefundState = (ticket: RefundSource) => {
  const history = (ticket.refunds ?? []).filter((refund) => (!ticket.id || refund.ticketId === ticket.id) && (!ticket.userId || refund.userId === ticket.userId))
  const active = history.filter((refund) => !refund.cancelledAt)
  const refundedPeople = active.reduce((sum, refund) => sum + (refund.personCount ?? 0), 0)
  const full = active.some((refund) => refund.isFull) || (ticket.personCount != null && ticket.personCount > 0 && refundedPeople >= ticket.personCount)
  const money = (key: 'refundRevenueThb' | 'returnedCostThb') => active.reduce((sum, refund) => sum + Math.round(refund[key] * 100), 0) / 100
  return {
    history, active, refundedPeople, full,
    remainingPeople: full ? 0 : ticket.personCount == null ? null : Math.max(0, ticket.personCount - refundedPeople),
    refundRevenueThb: money('refundRevenueThb'), returnedCostThb: money('returnedCostThb')
  }
}

export const getEffectivePersonCount = (ticket: RefundSource) => getRefundState(ticket).remainingPeople

export const attachRefunds = (tickets: TicketRecord[], refunds: NonNullable<TicketRecord['refunds']>) => {
  const grouped = new Map<string, NonNullable<TicketRecord['refunds']>>()
  for (const refund of refunds) {
    const key = `${refund.userId}:${refund.ticketId}`
    const group = grouped.get(key) ?? []
    group.push(refund)
    grouped.set(key, group)
  }
  return tickets.map((ticket) => ({ ...ticket, refunds: (grouped.get(`${ticket.userId}:${ticket.id}`) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) }))
}
