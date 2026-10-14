import type { TicketRecord } from '../types'
import { getRefundState } from './refunds'
import { isItemQuantity } from './quantity'

// Existing catalogues have no separate booking unit. Recognize explicit whole
// vehicle/boat/table/room packages without changing their saved price basis.
export const isWholeBooking = (record: Pick<TicketRecord, 'projectName' | 'subItemName'>) =>
  /包车|包船|游艇会|整车|整船|整床|整间|包台|包厢|私人床位/.test(`${record.projectName} ${record.subItemName}`)

export const summariseQuantities = (tickets: TicketRecord[]) => tickets.reduce((result, ticket) => {
  if (ticket.deletedAt || ticket.entryMode === 'profit_only') return result
  const refund = getRefundState(ticket)
  if (refund.full) return result
  result.recordCount++
  if (!isItemQuantity(ticket) && isWholeBooking(ticket)) result.orderCount++
  else if (!Number.isInteger(refund.remainingPeople) || (refund.remainingPeople ?? 0) < 1) result.unknownCount++
  else if (isItemQuantity(ticket)) result.itemCount += refund.remainingPeople!
  else result.ticketCount += refund.remainingPeople!
  return result
}, { recordCount: 0, ticketCount: 0, orderCount: 0, itemCount: 0, unknownCount: 0 })

export const quantityParts = (summary: ReturnType<typeof summariseQuantities>) => {
  const parts: string[] = []
  if (summary.ticketCount) parts.push(`门票 ${summary.ticketCount.toLocaleString('en-US')} 张`)
  if (summary.orderCount) parts.push(`整单 ${summary.orderCount.toLocaleString('en-US')} 单`)
  if (summary.itemCount) parts.push(`商品 ${summary.itemCount.toLocaleString('en-US')} 件`)
  if (summary.unknownCount) parts.push(`数量未填 ${summary.unknownCount} 笔`)
  return parts.length ? parts : ['门票 0 张']
}
