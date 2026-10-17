import type { TicketRecord } from '../types'
import { getRefundState } from './refunds'

export interface ReportCounts {
  accountingRecordCount: number
  effectiveOrderCount: number
  refundedOrderCount: number
}

// A partial refund leaves an effective order. A full refund leaves an accounting
// record only. Cancelled refunds never count as currently refunded orders.
export const buildReportCounts = (records: TicketRecord[]): ReportCounts => records.reduce((counts, ticket) => {
  if (ticket.deletedAt) return counts
  const refund = getRefundState(ticket)
  counts.accountingRecordCount++
  if (ticket.entryMode !== 'profit_only' && !refund.full) counts.effectiveOrderCount++
  if (refund.active.length) counts.refundedOrderCount++
  return counts
}, { accountingRecordCount: 0, effectiveOrderCount: 0, refundedOrderCount: 0 })
