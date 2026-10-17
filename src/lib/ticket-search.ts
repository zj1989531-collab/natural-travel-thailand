import type { TicketRecord } from '../types'

export type TicketDateRange = 'today' | 'month' | 'all'

export const matchesTicketSearch = (ticket: Pick<TicketRecord, 'issueDate' | 'supplierId' | 'guestName' | 'projectName' | 'subItemName' | 'supplierName' | 'note'>, filter: {
  query: string
  supplierId: string
  date: string
  range: TicketDateRange
  today: string
}) => {
  if (filter.date && ticket.issueDate !== filter.date) return false
  if (filter.range === 'today' && ticket.issueDate !== filter.today) return false
  if (filter.range === 'month' && ticket.issueDate.slice(0, 7) !== filter.today.slice(0, 7)) return false
  if (filter.supplierId && ticket.supplierId !== filter.supplierId) return false
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()
  const query = normalize(filter.query)
  return !query || [ticket.guestName ?? '', ticket.projectName, ticket.subItemName ?? '', ticket.supplierName, ticket.note].some(value => normalize(value).includes(query))
}
