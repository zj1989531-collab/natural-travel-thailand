import type { SyncStatus, TicketRecord } from '../types'
import { getBangkokDate, isValidCalendarDate } from './format'
import { buildShow79Report } from './show79'

export interface Show79SettlementRecord {
  id: string
  userId: string
  month: string
  snapshotProfitThb: number
  snapshotJimmyThb: number
  snapshotPartnersThb: number
  jimmyPaidThb: number
  partnersPaidThb: number
  paymentDate: string
  note: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface Show79SettlementInput {
  operationId: string
  month: string
  paymentDate: string
  /** This payment only: positive means paid out; negative means recovered. */
  jimmyPaidThb: number
  partnersPaidThb: number
  note: string
  expectedProfitThb: number
  expectedJimmyPaidThb: number
  expectedPartnersPaidThb: number
}

export type Show79SettlementStatus = 'unsettled' | 'settled' | 'adjustment' | 'partial'

export const show79SettlementStatusLabels: Record<Show79SettlementStatus, string> = {
  unsettled: '未结算', settled: '已结清', adjustment: '待调整', partial: '部分结算'
}

const validMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && isValidCalendarDate(`${month}-01`)

const signedCents = (amount: number): number => {
  if (!Number.isFinite(amount) || Math.abs(amount) > 999999999999.99 || !Number.isSafeInteger(Math.round(amount * 100))) {
    throw new Error('分账金额无效或过大，请检查输入。')
  }
  if (amount !== Number(amount.toFixed(2))) throw new Error('分账金额最多保留两位小数。')
  return Math.round(amount * 100)
}

const safeCents = (amount: number) => {
  if (!Number.isSafeInteger(amount)) throw new Error('累计分账金额过大，请检查记录。')
  return amount
}

export function buildShow79SettlementState(tickets: TicketRecord[], records: Show79SettlementRecord[], month: string) {
  if (!validMonth(month)) throw new Error('请选择有效的结算月份。')
  const report = buildShow79Report(tickets, `${month}-01`, month)
  const history = records.filter(record => record.month === month)
    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  let paidJimmyCents = 0
  let paidPartnersCents = 0
  for (const record of history) {
    paidJimmyCents = safeCents(paidJimmyCents + signedCents(record.jimmyPaidThb))
    paidPartnersCents = safeCents(paidPartnersCents + signedCents(record.partnersPaidThb))
  }
  const profitCents = signedCents(report.profitThb)
  const remainingJimmyCents = safeCents(signedCents(report.jimmyThb) - paidJimmyCents)
  const remainingPartnersCents = safeCents(signedCents(report.partnersThb) - paidPartnersCents)
  const hasProfitChange = history.some(record => signedCents(record.snapshotProfitThb) !== profitCents)
  const hasDifference = remainingJimmyCents !== 0 || remainingPartnersCents !== 0
  const status: Show79SettlementStatus = !history.length ? 'unsettled'
    : !hasDifference ? 'settled' : hasProfitChange ? 'adjustment' : 'partial'
  return {
    month,
    profitThb: report.profitThb,
    jimmyThb: report.jimmyThb,
    partnersThb: report.partnersThb,
    paidJimmyThb: paidJimmyCents / 100,
    paidPartnersThb: paidPartnersCents / 100,
    remainingJimmyThb: remainingJimmyCents / 100,
    remainingPartnersThb: remainingPartnersCents / 100,
    status,
    hasProfitChange,
    records: history
  }
}

export type Show79SettlementState = ReturnType<typeof buildShow79SettlementState>

export function validateShow79SettlementInput(input: Show79SettlementInput, today = getBangkokDate()): void {
  if (!validMonth(input.month)) throw new Error('请选择有效的结算月份。')
  if (!isValidCalendarDate(today) || !isValidCalendarDate(input.paymentDate) || input.paymentDate > today) {
    throw new Error('请填写有效的实际付款日期，不能晚于曼谷今天。')
  }
  const jimmyCents = signedCents(input.jimmyPaidThb)
  const partnersCents = signedCents(input.partnersPaidThb)
  for (const amount of [input.expectedProfitThb, input.expectedJimmyPaidThb, input.expectedPartnersPaidThb]) signedCents(amount)
  if (jimmyCents === 0 && partnersCents === 0) throw new Error('请填写至少一方本次实际支付或收回的金额，不能同时为0。')
  if (typeof input.note !== 'string' || input.note.length > 300) throw new Error('分账备注最多300个字符。')
  if ((jimmyCents < 0 || partnersCents < 0) && !input.note.trim()) throw new Error('登记收回或冲正金额时，请填写备注说明。')
  if (typeof input.operationId !== 'string' || !input.operationId.trim()) throw new Error('本次分账编号缺失，请重新填写后重试。')
}
