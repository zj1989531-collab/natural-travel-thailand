import type { RefundInput, TicketRecord } from '../types'
import { isValidCalendarDate, isValidIssueTime, isValidPersonCount } from './format'
import { getRefundState } from './refunds'
import { getOriginalTicketAmounts, getTicketAmounts, validateAmountPrecision } from './ticket-amounts'
import { quantityLabels } from './quantity'

export const validateRefundInput = (ticket: TicketRecord, input: RefundInput) => {
  if (ticket.deletedAt || ticket.entryMode === 'profit_only' || ticket.id !== input.ticketId) throw new Error('请选择有效的原出票记录；仅录利润项目不能退票。')
  if (!isValidCalendarDate(input.refundDate) || input.refundDate < ticket.issueDate || !isValidIssueTime(input.refundTime)) throw new Error('请填写有效的曼谷退票日期和时间，日期不能早于出票日期。')
  const state = getRefundState(ticket)
  if (state.full) throw new Error('此记录已经全部退票，请勿重复办理。')
  const quantity = input.isFull ? state.remainingPeople : input.personCount
  if (!input.isFull && (quantity == null || !isValidPersonCount(quantity) || state.remainingPeople == null || quantity > state.remainingPeople)) throw new Error(`部分退票数量必须是正整数，且不能超过剩余${quantityLabels(ticket).label}；${quantityLabels(ticket).label}未知的旧票只能整单退票。`)
  validateAmountPrecision([input.refundRevenueThb, input.returnedCostThb])
  const amounts = getTicketAmounts(ticket)
  if (Math.round(input.refundRevenueThb * 100) > Math.round(amounts.agentPriceThb * 100) || Math.round(input.returnedCostThb * 100) > Math.round(amounts.costThb * 100)) throw new Error('退款或成本返还不能超过当前剩余金额。')
  return { personCount: quantity, isFull: input.isFull || quantity === state.remainingPeople }
}

export const defaultRefundAmounts = (ticket: TicketRecord, isFull: boolean, quantity: number) => {
  const remaining = getTicketAmounts(ticket)
  const original = getOriginalTicketAmounts(ticket)
  const refundQuantity = isFull ? getRefundState(ticket).remainingPeople : quantity
  // Refund only the remaining tickets at original prices. An earlier retained
  // fee must not be silently returned when the rest of an order is refunded.
  const ratio = ticket.personCount ? (refundQuantity ?? 0) / ticket.personCount : 0
  const unknownFull = isFull && ticket.personCount == null
  return {
    refundRevenueThb: unknownFull ? remaining.agentPriceThb : Math.min(remaining.agentPriceThb, Math.round(original.agentPriceThb * ratio * 100) / 100),
    returnedCostThb: unknownFull ? remaining.costThb : Math.min(remaining.costThb, Math.round(original.costThb * ratio * 100) / 100)
  }
}
