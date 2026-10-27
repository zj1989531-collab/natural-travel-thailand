import type { TicketInput } from '../types'
import type { Show69RecordInput } from './show69'
import { resolveMonthlyPricing } from './monthly-pricing'

type MonthlyPricing = ReturnType<typeof resolveMonthlyPricing>

/**
 * Freeze every field that participates in a new main-ledger ticket fingerprint.
 * A confirmation retry must never re-read a changed price table or clock.
 */
export const createMainLedgerMonthlyTicketSnapshot = (
  input: Show69RecordInput,
  pricing: MonthlyPricing,
  issueTime: string
): TicketInput => {
  const project = pricing.project
  if (!project) throw new Error('请先选择有效的月结套餐。')
  return {
    guestName: input.guestName.trim(),
    issueDate: input.date,
    issueTime,
    projectId: project.id,
    projectName: project.name,
    subItemName: project.subItemName,
    supplierName: project.supplierName,
    personCount: input.people,
    quantityUnit: 'person',
    amountBasis: 'per_person',
    entryMode: 'standard',
    settlementMode: 'monthly',
    agentPriceThb: pricing.agentPriceThb,
    costThb: pricing.costThb,
    note: ''
  }
}
