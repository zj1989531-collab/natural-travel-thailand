import type { TicketRecord } from '../types'
import { getRefundState } from './refunds'
import { isShow79Project, validateShow79Voucher, type Show79VoucherInput } from './show79'

type SavedSource = { kind: 'saved'; ticketId: string; userId: string; version: string }
export type Show79PreviewSource = { kind: 'draft'; version: string; order?: SavedSource } | SavedSource

export const show79PreviewTickets = (tickets: TicketRecord[], confirmed: { ticket: TicketRecord; baseline: TicketRecord[] } | null) =>
  confirmed && tickets === confirmed.baseline ? [...tickets.filter(row => row.id !== confirmed.ticket.id), confirmed.ticket] : tickets

export const show79DraftVersion = (input: Show79VoucherInput) => JSON.stringify([input.guestName.trim(), input.date, input.people])
export const show79DraftSource = (input: Show79VoucherInput, editing?: TicketRecord): Show79PreviewSource => ({
  kind: 'draft', version: show79DraftVersion(input),
  ...(editing ? { order: { kind: 'saved' as const, ticketId: editing.id, userId: editing.userId, version: show79TicketVersion(editing) } } : {})
})

// Include the immutable order snapshot and every refund, including cancelled
// refunds. A change to money or internal notes also retires an old voucher.
// A pending -> synced acknowledgement alone does not change its contents.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value

const timestamp = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return value
  // Postgres returns offsets and microseconds; JS creates millisecond Z values.
  // Normalize their spelling without discarding a real microsecond revision.
  const fraction = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0')
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, '.' + fraction + 'Z')
}

export const show79TicketVersion = (ticket: TicketRecord) => JSON.stringify(canonical({
  ...ticket, syncStatus: undefined,
  createdAt: timestamp(ticket.createdAt), updatedAt: timestamp(ticket.updatedAt), deletedAt: timestamp(ticket.deletedAt),
  refunds: (ticket.refunds ?? []).filter(row => row.ticketId === ticket.id && row.userId === ticket.userId)
    .map(row => ({ ...row, syncStatus: undefined, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt), cancelledAt: timestamp(row.cancelledAt) })).sort((a, b) => a.id.localeCompare(b.id))
}))

export const savedShow79Preview = (ticket: TicketRecord): { input: Show79VoucherInput; source: Show79PreviewSource } => {
  if (ticket.deletedAt || !isShow79Project(ticket.projectName) || ticket.entryMode === 'profit_only') throw new Error('这笔订单不能生成确认单，请核对订单状态。')
  const input = { guestName: ticket.guestName?.trim() ?? '', date: ticket.issueDate, people: getRefundState(ticket).remainingPeople ?? 0 }
  validateShow79Voucher(input)
  return { input, source: { kind: 'saved', ticketId: ticket.id, userId: ticket.userId, version: show79TicketVersion(ticket) } }
}

export const isShow79PreviewCurrent = (source: Show79PreviewSource, draft: Show79VoucherInput, tickets: TicketRecord[]): boolean => {
  if (source.kind === 'draft') return source.version === show79DraftVersion(draft) && (!source.order || isShow79PreviewCurrent(source.order, draft, tickets))
  const ticket = tickets.find(row => row.id === source.ticketId && row.userId === source.userId)
  return !!ticket && !ticket.deletedAt && source.version === show79TicketVersion(ticket)
}

export function createShow79PreviewGuard() {
  let generation = 0
  return {
    begin: () => ++generation,
    invalidate: () => { generation++ },
    isLatest: (request: number) => request === generation,
    async render<T>(request: number, render: () => Promise<T>, sourceIsCurrent: () => boolean): Promise<T | undefined> {
      if (request !== generation || !sourceIsCurrent()) return undefined
      const result = await render()
      return request === generation && sourceIsCurrent() ? result : undefined
    }
  }
}
