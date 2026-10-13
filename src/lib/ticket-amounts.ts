import type { TicketRecord } from '../types'
import { isValidPersonCount } from './format'

type AmountInput = Pick<TicketRecord, 'amountBasis' | 'personCount' | 'entryMode' | 'agentPriceThb' | 'costThb' | 'manualProfitThb'>

// Store the entered amounts unchanged; compute totals once at the point of use.
// Missing basis means a legacy whole-order total, never an implicit unit price.
export const getTicketAmounts = (ticket: AmountInput) => {
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

export const validateAmountPrecision = (amounts: number[]) => {
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)) || amount > 999999999999.99)) {
    throw new Error('金额或人数过大，请检查输入。')
  }
  if (amounts.some((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) > 0.01)) {
    throw new Error('金额最多保留两位小数。')
  }
}
