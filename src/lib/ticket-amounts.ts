import type { TicketRecord } from '../types'
import { isValidPersonCount } from './format'
import { getRefundState } from './refunds'

type AmountInput = Pick<TicketRecord, 'amountBasis' | 'personCount' | 'entryMode' | 'agentPriceThb' | 'costThb' | 'manualProfitThb' | 'refunds'> & Partial<Pick<TicketRecord, 'id' | 'userId'>>

// Store the entered amounts unchanged; compute totals once at the point of use.
// Missing basis means a legacy whole-order total, never an implicit unit price.
export const getOriginalTicketAmounts = (ticket: AmountInput) => {
  const quantity = ticket.amountBasis === 'per_person'
    ? typeof ticket.personCount === 'number' && isValidPersonCount(ticket.personCount) ? ticket.personCount : 0
    : 1
  const cents = (value: number | null | undefined) => Number.isFinite(value) ? Math.round(((value ?? 0) + Number.EPSILON) * 100) : 0
  if (ticket.entryMode === 'profit_only') {
    return { agentPriceThb: 0, costThb: 0, profitThb: cents(ticket.manualProfitThb) * quantity / 100 }
  }
  const revenueCents = cents(ticket.agentPriceThb) * quantity
  const costCents = cents(ticket.costThb) * quantity
  return { agentPriceThb: revenueCents / 100, costThb: costCents / 100, profitThb: (revenueCents - costCents) / 100 }
}

export const getTicketAmounts = (ticket: AmountInput) => {
  const original = getOriginalTicketAmounts(ticket)
  const refunds = getRefundState(ticket)
  const revenueCents = Math.round(original.agentPriceThb * 100) - Math.round(refunds.refundRevenueThb * 100)
  const costCents = Math.round(original.costThb * 100) - Math.round(refunds.returnedCostThb * 100)
  return { agentPriceThb: revenueCents / 100, costThb: costCents / 100, profitThb: ticket.entryMode === 'profit_only' ? original.profitThb : (revenueCents - costCents) / 100 }
}

export const validateAmountPrecision = (amounts: number[]) => {
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)) || amount > 999999999999.99)) {
    throw new Error('金额或人数过大，请检查输入。')
  }
  if (amounts.some((amount) => amount !== Number(amount.toFixed(2)))) {
    throw new Error('金额最多保留两位小数。')
  }
}
