import type { TicketRecord } from '../types'
import { activeTickets, bySupplier, isMonthlySettlementProject, monthDateRange, summarise } from './stats'

export type ReportMode = 'day' | 'month' | 'range'
export interface ReportQuery {
  mode: ReportMode
  date: string
  month: string
  startDate: string
  endDate: string
  supplierId: string
}

const isCalendarDate = (value: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false
  const day = Number(value.slice(8))
  return day >= 1 && day <= Number(monthDateRange(value.slice(0, 7)).end.slice(8))
}

export const buildReport = (tickets: TicketRecord[], query: ReportQuery) => {
  const range = query.mode === 'month' ? monthDateRange(query.month)
    : query.mode === 'day' ? { start: query.date, end: query.date }
      : { start: query.startDate, end: query.endDate }
  if (!isCalendarDate(range.start) || !isCalendarDate(range.end)) throw new Error('请选择有效的报表日期。')
  if (range.start > range.end) throw new Error('开始日期不能晚于结束日期。')

  const selected = activeTickets(tickets).filter((ticket) =>
    isCalendarDate(ticket.issueDate) && ticket.issueDate >= range.start && ticket.issueDate <= range.end &&
    (!query.supplierId || ticket.supplierId === query.supplierId))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || (a.issueTime ?? '').localeCompare(b.issueTime ?? '') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const monthlyRecords = selected.filter((ticket) => ticket.entryMode === 'profit_only' || isMonthlySettlementProject(ticket.projectName))
  const monthlyIds = new Set(monthlyRecords.map((ticket) => ticket.id))
  const records = query.mode === 'day' ? selected.filter((ticket) => !monthlyIds.has(ticket.id)) : selected
  const headcountRecords = records.filter((ticket) => ticket.entryMode !== 'profit_only')
  const knownHeadcounts = headcountRecords.filter((ticket) => Number.isInteger(ticket.personCount) && (ticket.personCount ?? 0) > 0)
  const roundSummary = (items: TicketRecord[]) => {
    const total = summarise(items)
    return { ...total, agentPriceThb: Math.round(total.agentPriceThb * 100) / 100, costThb: Math.round(total.costThb * 100) / 100, profitThb: Math.round(total.profitThb * 100) / 100 }
  }
  return {
    mode: query.mode,
    title: query.mode === 'day' ? '出票盈利日报' : query.mode === 'month' ? '出票盈利月报' : '出票盈利区间报表',
    ...range,
    supplierId: query.supplierId,
    records,
    monthlyRecords,
    summary: roundSummary(records),
    monthlySummary: roundSummary(monthlyRecords),
    supplierStats: bySupplier(records),
    recordedPeople: knownHeadcounts.reduce((total, ticket) => total + ticket.personCount!, 0),
    unknownHeadcounts: headcountRecords.length - knownHeadcounts.length
  }
}

export type LedgerReport = ReturnType<typeof buildReport>
