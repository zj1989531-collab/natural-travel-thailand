import type { TicketRecord } from '../types'
import { getBangkokDate, isValidCalendarDate, isValidPersonCount } from './format'
import { commandDateMatches, removeCommandDate } from './command-date'
import { getRefundState } from './refunds'
import { getTicketAmounts } from './ticket-amounts'
import { isShow69Project } from './show69'
import { isBoxingProject } from './boxing'
import { isCarnivalProject, isKohLarnDayTripProject } from './project-rules'

// Match immutable project snapshots, including historical catalogue names.
export const isShow79Project = (name: string): boolean => {
  const normalized = name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return /^79(?:成人)?秀/.test(normalized) || /^(?:imagine)?79show(?:$|[^a-z])/.test(normalized)
}

// These ticket types share the tickets table and cloud sync pipeline, but are
// intentionally kept outside the main ledger's reports, rankings and exports.
// Keeping this classification in one place prevents a new independent page
// from accidentally leaking back into a main-ledger aggregate.
export const isIndependentLedgerProject = (projectName: string): boolean =>
  isShow79Project(projectName) || isShow69Project(projectName) || isBoxingProject(projectName) ||
  isKohLarnDayTripProject(projectName) || isCarnivalProject(projectName)

export const mainLedgerTickets = (tickets: TicketRecord[]) => tickets.filter(ticket => !isIndependentLedgerProject(ticket.projectName))

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
  const dates = commandDateMatches(normalized, today)
  if (dates.length !== 1) throw new Error('请填写一个观看日期，例如“今天”“明天”或“2026/10/20”。')
  const date = dates[0].date
  // Strip standalone product labels before counts: in “79 张三 2人”, the
  // product must not be mistaken for “79张” merely because 张 is a surname.
  const productLabel = /(^|[\s,，;；、])(?:79(?:\s*成人)?\s*秀?|(?:imagine\s*)?79\s*show)(?=$|[\s,，;；、])/gi
  const withoutDate = removeCommandDate(normalized, dates[0]).replace(productLabel, ' ')
  const counts = [...withoutDate.matchAll(/(?:人数|数量)\s*[:：]?\s*([+-]?\s*\d+(?:\.\d+)?)(?![\d.A-Za-z]|\s*[./]\s*\d)\s*(?:人|个|位|名|张)?|(?<![\d.A-Za-z/])([+-]?\s*\d+(?:\.\d+)?)\s*(?:人|个|位|名|张)/g)]
  if (counts.length !== 1) throw new Error('请填写一个人数，例如“2人”“2个”或“2位”；不要同时填写多个数量。')
  // Replacing the whole count creates a separator in compact phrases like
  // “今天2个79”, so the product can appear before or after the guest names.
  const guestName = withoutDate.replace(counts[0][0], ' ')
    .replace(productLabel, ' ')
    .replace(/^(?:79(?:\s*成人)?\s*秀?)(?:\s*出票|\s*记录)?\s*格式\s*[:：]?/i, ' ')
    .replace(/(?:观看日期|出行日期|出票日期|日期|项目名称|项目|客户姓名|姓名|名字|客户|人数|数量)\s*(?:[（(]\s*所有人\s*[）)])?\s*[:：]?/g, ' ')
    .replace(/^[\s,，;；、]+|[\s,，;；、]+$/g, '').replace(/\s+/g, ' ').trim()
  const input = { guestName, date, people: Number((counts[0][1] ?? counts[0][2]).replace(/\s/g, '')) }
  validateShow79Voucher(input)
  return input
}
