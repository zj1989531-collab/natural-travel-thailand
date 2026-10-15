import type { TicketRecord } from '../types'
import { activeTickets, bySupplier, monthDateRange, summarise } from './stats'
import { ticketSettlementMode } from './project-rules'
import { getEffectivePersonCount, getRefundState } from './refunds'
import { isItemQuantity } from './quantity'
import { cleanProjectLabel, ticketDisplay } from './project-labels'
import { summariseQuantities } from './effective-quantities'
import { mainLedgerTickets } from './show79'

export type ReportMode = 'day' | 'month' | 'range' | 'all'
export interface ReportQuery {
  mode: ReportMode
  date: string
  month: string
  startDate: string
  endDate: string
  supplierId: string
  projectName?: string
}

const isCalendarDate = (value: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false
  const day = Number(value.slice(8))
  return day >= 1 && day <= Number(monthDateRange(value.slice(0, 7)).end.slice(8))
}

export const buildReport = (tickets: TicketRecord[], query: ReportQuery) => {
  const active = activeTickets(mainLedgerTickets(tickets)).filter((ticket) => isCalendarDate(ticket.issueDate))
  const allDates = active.map((ticket) => ticket.issueDate).sort()
  const range = query.mode === 'all' ? { start: allDates[0] ?? query.date, end: allDates.at(-1) ?? query.date }
    : query.mode === 'month' ? monthDateRange(query.month)
    : query.mode === 'day' ? { start: query.date, end: query.date }
      : { start: query.startDate, end: query.endDate }
  if (!isCalendarDate(range.start) || !isCalendarDate(range.end)) throw new Error('请选择有效的报表日期。')
  if (range.start > range.end) throw new Error('开始日期不能晚于结束日期。')

  const selected = active.filter((ticket) =>
    isCalendarDate(ticket.issueDate) && ticket.issueDate >= range.start && ticket.issueDate <= range.end &&
    (!query.supplierId || ticket.supplierId === query.supplierId) &&
    (!query.projectName || cleanProjectLabel(ticket.projectName || '未分类项目') === cleanProjectLabel(query.projectName)))
    .map(ticketDisplay)
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || (a.issueTime ?? '').localeCompare(b.issueTime ?? '') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const monthlyRecords = selected.filter((ticket) => ticketSettlementMode(ticket) === 'monthly')
  const monthlyIds = new Set(monthlyRecords.map((ticket) => ticket.id))
  const records = query.mode === 'day' ? selected.filter((ticket) => !monthlyIds.has(ticket.id)) : selected
  const headcountRecords = records.filter((ticket) => ticket.entryMode !== 'profit_only' && !getRefundState(ticket).full && !isItemQuantity(ticket))
  const knownHeadcounts = headcountRecords.filter((ticket) => getEffectivePersonCount(ticket) != null)
  // Quantity queries include monthly-settlement tickets even in a daily report.
  // A manual commission is not a ticket; missing headcount is never guessed.
  const quantityRecords = selected.filter((ticket) => ticket.entryMode !== 'profit_only' && !getRefundState(ticket).full && !isItemQuantity(ticket))
  const itemRecords = selected.filter((ticket) => ticket.entryMode !== 'profit_only' && !getRefundState(ticket).full && isItemQuantity(ticket))
  const itemDays = new Map<string, { date: string; recordCount: number; quantityCount: number; unknownCount: number }>()
  for (const ticket of itemRecords) {
    const row = itemDays.get(ticket.issueDate) ?? { date: ticket.issueDate, recordCount: 0, quantityCount: 0, unknownCount: 0 }
    row.recordCount++
    const count = getEffectivePersonCount(ticket)
    if (Number.isInteger(count) && (count ?? 0) > 0) row.quantityCount += count!
    else row.unknownCount++
    itemDays.set(ticket.issueDate, row)
  }
  const itemQuantityDays = [...itemDays.values()]
  const dailyQuantities = new Map<string, { date: string; recordCount: number; peopleCount: number; unknownCount: number }>()
  for (const ticket of quantityRecords) {
    const row = dailyQuantities.get(ticket.issueDate) ?? { date: ticket.issueDate, recordCount: 0, peopleCount: 0, unknownCount: 0 }
    row.recordCount++
    const people = getEffectivePersonCount(ticket)
    if (Number.isInteger(people) && (people ?? 0) > 0) row.peopleCount += people!
    else row.unknownCount++
    dailyQuantities.set(ticket.issueDate, row)
  }
  const quantityDays = [...dailyQuantities.values()]
  const roundSummary = (items: TicketRecord[]) => {
    const total = summarise(items)
    return { ...total, agentPriceThb: Math.round(total.agentPriceThb * 100) / 100, costThb: Math.round(total.costThb * 100) / 100, profitThb: Math.round(total.profitThb * 100) / 100 }
  }
  return {
    mode: query.mode,
    title: query.mode === 'day' ? '出票盈利日报' : query.mode === 'month' ? '出票盈利月报' : query.mode === 'all' ? '出票盈利累计报表' : '出票盈利区间报表',
    ...range,
    supplierId: query.supplierId,
    projectName: cleanProjectLabel(query.projectName ?? ''),
    effectiveQuantity: summariseQuantities(selected),
    itemQuantity: { recordCount: itemRecords.length, quantityCount: itemQuantityDays.reduce((sum, day) => sum + day.quantityCount, 0), unknownCount: itemQuantityDays.reduce((sum, day) => sum + day.unknownCount, 0), days: itemQuantityDays },
    quantity: {
      recordCount: quantityRecords.length,
      peopleCount: quantityDays.reduce((sum, day) => sum + day.peopleCount, 0),
      unknownCount: quantityDays.reduce((sum, day) => sum + day.unknownCount, 0),
      days: quantityDays
    },
    records,
    monthlyRecords,
    summary: roundSummary(records),
    monthlySummary: roundSummary(monthlyRecords),
    supplierStats: bySupplier(records),
    recordedPeople: knownHeadcounts.reduce((total, ticket) => total + getEffectivePersonCount(ticket)!, 0),
    unknownHeadcounts: headcountRecords.length - knownHeadcounts.length
  }
}

export type LedgerReport = ReturnType<typeof buildReport>
