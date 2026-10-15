import type { TicketRecord } from '../types'
import { isValidCalendarDate } from './format'
import { monthDateRange } from './stats'
import { ticketSettlementMode } from './project-rules'
import { getTicketAmounts } from './ticket-amounts'
import { mainLedgerTickets } from './show79'

export interface ProfitTotals {
  dailyProfitThb: number
  monthlyProfitThb: number
  totalProfitThb: number
  recordCount: number
}
export interface ProfitTrendDay extends ProfitTotals { date: string }
export interface ProfitTrend {
  month: string
  mode: 'to_date' | 'full_month'
  currentRange: { start: string; end: string }
  previousRange: { start: string; end: string }
  days: ProfitTrendDay[]
  current: ProfitTotals
  previous: ProfitTotals
  differenceThb: number
  percentage: number | null
  percentageUnavailable: 'no_records' | 'zero' | 'loss' | null
}

const empty = (): ProfitTotals => ({ dailyProfitThb: 0, monthlyProfitThb: 0, totalProfitThb: 0, recordCount: 0 })
const previousMonth = (month: string) => {
  const [year, number] = month.split('-').map(Number)
  return `${String(number === 1 ? year - 1 : year).padStart(4, '0')}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`
}

// All additions are in integer cents. Settlement and refund values come from
// the ticket snapshot, never mutable catalogue prices or the refund date.
export function buildProfitTrend(tickets: TicketRecord[], month: string, today: string): ProfitTrend {
  if (!isValidCalendarDate(today)) throw new Error('请选择有效的曼谷日期。')
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效的月份。')
  if (month > today.slice(0, 7)) throw new Error('只能查看当前或历史月份。')
  const mode = month === today.slice(0, 7) ? 'to_date' : 'full_month'
  const currentRange = { ...monthDateRange(month) }
  if (mode === 'to_date') currentRange.end = today
  const previousRange = { ...monthDateRange(previousMonth(month)) }
  if (mode === 'to_date') {
    const day = Math.min(Number(today.slice(8)), Number(previousRange.end.slice(8)))
    previousRange.end = `${previousRange.start.slice(0, 7)}-${String(day).padStart(2, '0')}`
  }
  const days = Array.from({ length: Number(currentRange.end.slice(8)) }, (_, index) => ({ date: `${month}-${String(index + 1).padStart(2, '0')}`, ...empty() }))
  const currentCents = empty()
  const previousCents = empty()
  for (const ticket of mainLedgerTickets(tickets)) {
    if (ticket.deletedAt || !isValidCalendarDate(ticket.issueDate)) continue
    const current = ticket.issueDate >= currentRange.start && ticket.issueDate <= currentRange.end
    const previous = ticket.issueDate >= previousRange.start && ticket.issueDate <= previousRange.end
    if (!current && !previous) continue
    const cents = Math.round(getTicketAmounts(ticket).profitThb * 100)
    const key = ticketSettlementMode(ticket) === 'monthly' ? 'monthlyProfitThb' : 'dailyProfitThb'
    const total = current ? currentCents : previousCents
    total[key] += cents; total.totalProfitThb += cents; total.recordCount++
    if (current) {
      const day = days[Number(ticket.issueDate.slice(8)) - 1]
      day[key] += cents; day.totalProfitThb += cents; day.recordCount++
    }
  }
  const toThb = <T extends ProfitTotals>(total: T): T => ({ ...total, dailyProfitThb: total.dailyProfitThb / 100, monthlyProfitThb: total.monthlyProfitThb / 100, totalProfitThb: total.totalProfitThb / 100 })
  const differenceCents = currentCents.totalProfitThb - previousCents.totalProfitThb
  const percentageUnavailable = !previousCents.recordCount ? 'no_records' : previousCents.totalProfitThb === 0 ? 'zero' : previousCents.totalProfitThb < 0 ? 'loss' : null
  return { month, mode, currentRange, previousRange, days: days.map(toThb), current: toThb(currentCents), previous: toThb(previousCents), differenceThb: differenceCents / 100,
    percentage: percentageUnavailable ? null : differenceCents / previousCents.totalProfitThb * 100, percentageUnavailable }
}
