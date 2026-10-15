import type { TicketRecord } from '../types'
import { getBangkokDate, isValidCalendarDate, isValidPersonCount } from './format'
import { getRefundState } from './refunds'
import { getTicketAmounts } from './ticket-amounts'

// Match immutable project snapshots, including historical catalogue names.
export const isShow79Project = (name: string): boolean => {
  const normalized = name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return /^79(?:成人)?秀/.test(normalized) || /^(?:imagine)?79show(?:$|[^a-z])/.test(normalized)
}

export const mainLedgerTickets = (tickets: TicketRecord[]) => tickets.filter(ticket => !isShow79Project(ticket.projectName))

export const splitShow79Profit = (profitThb: number) => {
  const cents = Math.round(profitThb * 100)
  if (!Number.isSafeInteger(cents)) throw new Error('利润金额过大，请检查记录。')
  const jimmyCents = Math.sign(cents) * Math.round(Math.abs(cents) * 40 / 100)
  return { profitThb: cents / 100, jimmyThb: jimmyCents / 100, partnersThb: (cents - jimmyCents) / 100 }
}

export function buildShow79Report(tickets: TicketRecord[], date: string, month: string) {
  if (!isValidCalendarDate(date) || !isValidCalendarDate(`${month}-01`)) throw new Error('请选择有效的日期和月份。')
  const all = tickets.filter(ticket => !ticket.deletedAt && isShow79Project(ticket.projectName) && isValidCalendarDate(ticket.issueDate))
  const dayRecords = all.filter(ticket => ticket.issueDate === date)
  const records = all.filter(ticket => ticket.issueDate.startsWith(`${month}-`))
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const count = (rows: TicketRecord[]) => rows.reduce((sum, ticket) => sum + (ticket.entryMode === 'profit_only' ? 0 : getRefundState(ticket).remainingPeople ?? 0), 0)
  const unknown = (rows: TicketRecord[]) => rows.filter(ticket => ticket.entryMode !== 'profit_only' && getRefundState(ticket).remainingPeople == null).length
  const profitCents = records.reduce((sum, ticket) => sum + Math.round(getTicketAmounts(ticket).profitThb * 100), 0)
  return { date, month, records, dayRecords, dayPeople: count(dayRecords), monthPeople: count(records), dayUnknown: unknown(dayRecords), monthUnknown: unknown(records), ...splitShow79Profit(profitCents / 100) }
}

export interface Show79VoucherInput { guestName: string; date: string; people: number }

export const validateShow79Voucher = (input: Show79VoucherInput) => {
  if (!input.guestName.trim() || input.guestName.trim().length > 100) throw new Error('请填写客户姓名，最多100个字符。')
  if (!isValidCalendarDate(input.date)) throw new Error('请填写有效的观看日期。')
  if (!isValidPersonCount(input.people)) throw new Error('人数必须是大于或等于1的整数。')
}

export const voucherDate = (date: string) => {
  if (!isValidCalendarDate(date)) throw new Error('观看日期无效。')
  return date.replaceAll('-', '/')
}

// Parsing only prepares a preview; saving an order is always a separate action.
export function parseShow79Command(text: string, today = getBangkokDate()): Show79VoucherInput {
  const normalized = text.normalize('NFKC').trim()
  const peopleMatch = normalized.match(/(?:^|[\s,，;；])([1-9]\d*)\s*人(?=$|[\s,，;；])/)
  const dateMatch = normalized.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/)
  const relativeMatch = normalized.match(/今天|明天/)
  if (!peopleMatch || (!dateMatch && !relativeMatch)) throw new Error('请按“79 jimmy 2人 今天”或“79 张三 2人 2026/10/20”填写。')
  let date = today
  if (dateMatch) date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
  else if (relativeMatch?.[0] === '明天') {
    const next = new Date(`${today}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); date = next.toISOString().slice(0, 10)
  }
  const guestName = normalized.replace(peopleMatch[0], ' ').replace(dateMatch?.[0] ?? /今天|明天/, ' ')
    .replace(/^\s*79(?:秀)?(?=$|[\s,，;；])/, '').replace(/^[\s,，;；]+|[\s,，;；]+$/g, '').trim()
  const input = { guestName, date, people: Number(peopleMatch[1]) }
  validateShow79Voucher(input)
  return input
}
