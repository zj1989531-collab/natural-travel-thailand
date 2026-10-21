import { describe, expect, it } from 'vitest'
import type { TicketRecord } from '../types'
import { buildShow79SettlementState, validateShow79SettlementInput, type Show79SettlementInput, type Show79SettlementRecord } from './show79-settlement'

const month = '2026-10'
const today = '2026-10-16'
const ticket = (profitThb = 100, extra: Partial<TicketRecord> = {}): TicketRecord => ({
  id: 'ticket', userId: 'user', issueDate: '2026-10-15', projectId: 'project', projectName: '79秀', subItemName: '门票',
  supplierId: 'supplier', supplierName: '供货商', amountBasis: 'total', personCount: 2,
  agentPriceThb: Math.max(0, profitThb), costThb: Math.max(0, -profitThb), note: '',
  createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', deletedAt: null, syncStatus: 'synced', ...extra
})
const record = (extra: Partial<Show79SettlementRecord> = {}): Show79SettlementRecord => ({
  id: 'payment', userId: 'user', month, snapshotProfitThb: 100, snapshotJimmyThb: 40, snapshotPartnersThb: 60,
  jimmyPaidThb: 40, partnersPaidThb: 60, paymentDate: today, note: '实际已支付',
  createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', syncStatus: 'synced', ...extra
})
const input = (extra: Partial<Show79SettlementInput> = {}): Show79SettlementInput => ({
  operationId: '741839e0-778b-40b7-9742-7988b7a50b78', month, paymentDate: today,
  jimmyPaidThb: 40, partnersPaidThb: 60, note: '', expectedProfitThb: 100, expectedJimmyPaidThb: 0, expectedPartnersPaidThb: 0, ...extra
})

describe('79 show settlement state', () => {
  it('does not invent payments for a new month or a month with zero profit', () => {
    const state = buildShow79SettlementState([ticket()], [], month)
    expect(state).toMatchObject({ status: 'unsettled', profitThb: 100, jimmyThb: 40, partnersThb: 60, paidJimmyThb: 0, paidPartnersThb: 0, remainingJimmyThb: 40, remainingPartnersThb: 60, records: [] })
    expect(buildShow79SettlementState([], [], month)).toMatchObject({ status: 'unsettled', profitThb: 0, paidJimmyThb: 0, paidPartnersThb: 0 })
  })
  it('uses only active 79 show orders and payment records from the selected month', () => {
    const state = buildShow79SettlementState([
      ticket(), ticket(999, { id: 'main', projectName: '海洋公园' }), ticket(999, { id: 'deleted', deletedAt: today }),
      ticket(999, { id: 'other-month', issueDate: '2026-09-30' })
    ], [record({ month: '2026-09' })], month)
    expect(state).toMatchObject({ profitThb: 100, paidJimmyThb: 0, paidPartnersThb: 0, records: [] })
  })
  it('adds actual payment increments rather than replacing earlier payments', () => {
    const state = buildShow79SettlementState([ticket()], [record({ id: 'first', jimmyPaidThb: 10, partnersPaidThb: 15 }), record({ id: 'second', jimmyPaidThb: 10, partnersPaidThb: 15 })], month)
    expect(state).toMatchObject({ status: 'partial', paidJimmyThb: 20, paidPartnersThb: 30, remainingJimmyThb: 20, remainingPartnersThb: 30 })
  })
  it('requires each payee to balance independently before reporting settled', () => {
    expect(buildShow79SettlementState([ticket()], [record()], month).status).toBe('settled')
    expect(buildShow79SettlementState([ticket()], [record({ jimmyPaidThb: 45, partnersPaidThb: 55 })], month))
      .toMatchObject({ status: 'partial', remainingJimmyThb: -5, remainingPartnersThb: 5 })
  })
  it('recalculates the original month after a refund without changing paid history', () => {
    const refund = { id: 'refund', userId: 'user', ticketId: 'ticket', personCount: 1, isFull: false, refundRevenueThb: 50, returnedCostThb: 0, refundDate: today, refundTime: '10:00', note: '', cancelledAt: null, createdAt: today, updatedAt: today, syncStatus: 'synced' as const }
    const payment = record()
    const state = buildShow79SettlementState([ticket(100, { refunds: [refund] })], [payment], month)
    expect(state).toMatchObject({ status: 'adjustment', hasProfitChange: true, profitThb: 50, jimmyThb: 20, partnersThb: 30, paidJimmyThb: 40, paidPartnersThb: 60, remainingJimmyThb: -20, remainingPartnersThb: -30 })
    expect(payment).toMatchObject({ snapshotProfitThb: 100, snapshotJimmyThb: 40, snapshotPartnersThb: 60, jimmyPaidThb: 40, partnersPaidThb: 60 })
  })
  it('keeps partial refund adjustments pending until both differences are recovered', () => {
    const correction = record({ id: 'correction', snapshotProfitThb: 50, snapshotJimmyThb: 20, snapshotPartnersThb: 30, jimmyPaidThb: -10, partnersPaidThb: -15, note: '退票后部分收回' })
    expect(buildShow79SettlementState([ticket(50)], [record(), correction], month))
      .toMatchObject({ status: 'adjustment', paidJimmyThb: 30, paidPartnersThb: 45, remainingJimmyThb: -10, remainingPartnersThb: -15 })
    expect(buildShow79SettlementState([ticket(50)], [record(), { ...correction, jimmyPaidThb: -20, partnersPaidThb: -30 }], month))
      .toMatchObject({ status: 'settled', paidJimmyThb: 20, paidPartnersThb: 30, remainingJimmyThb: 0, remainingPartnersThb: 0 })
  })
  it('shows later added profit as an adjustment and preserves signed loss shares', () => {
    expect(buildShow79SettlementState([ticket(150)], [record()], month)).toMatchObject({ status: 'adjustment', remainingJimmyThb: 20, remainingPartnersThb: 30 })
    expect(buildShow79SettlementState([ticket(-100)], [], month)).toMatchObject({ status: 'unsettled', profitThb: -100, jimmyThb: -40, partnersThb: -60, remainingJimmyThb: -40, remainingPartnersThb: -60 })
    expect(buildShow79SettlementState([ticket(-100)], [record({ snapshotProfitThb: -100, snapshotJimmyThb: -40, snapshotPartnersThb: -60, jimmyPaidThb: -40, partnersPaidThb: -60, note: '亏损分摊收回' })], month).status).toBe('settled')
  })
  it('calculates shares and sums in cents without floating point residuals', () => {
    const state = buildShow79SettlementState([ticket(0.03)], [
      record({ id: 'one', snapshotProfitThb: 0.03, snapshotJimmyThb: 0.01, snapshotPartnersThb: 0.02, jimmyPaidThb: 0.01, partnersPaidThb: 0.01 }),
      record({ id: 'two', snapshotProfitThb: 0.03, snapshotJimmyThb: 0.01, snapshotPartnersThb: 0.02, jimmyPaidThb: 0, partnersPaidThb: 0.01 })
    ], month)
    expect(state).toMatchObject({ status: 'settled', paidJimmyThb: 0.01, paidPartnersThb: 0.02, remainingJimmyThb: 0, remainingPartnersThb: 0 })
  })
  it('sorts retained history by actual payment day without mutating the inputs', () => {
    const history = [record({ id: 'old', paymentDate: '2026-10-01' }), record({ id: 'new', paymentDate: '2026-10-15' })]
    Object.freeze(history); history.forEach(Object.freeze)
    const state = buildShow79SettlementState([ticket(200)], history, month)
    expect(state.records.map(item => item.id)).toEqual(['new', 'old'])
    expect(history.map(item => item.id)).toEqual(['old', 'new'])
    expect(state.records[0]).toBe(history[1])
  })
  it.each(['', '2026-00', '2026-13', '2026-1', '0000-10', '2026-10-01'])('rejects invalid month %s', invalid => {
    expect(() => buildShow79SettlementState([], [], invalid)).toThrow('月份')
  })
})

describe('79 show settlement input validation', () => {
  it('accepts real actual payments before month end without requiring the month to have ended', () => {
    expect(() => validateShow79SettlementInput(input(), today)).not.toThrow()
    expect(() => validateShow79SettlementInput(input({ month: '2026-12', paymentDate: today }), today)).not.toThrow()
    expect(() => validateShow79SettlementInput(input({ month: '2024-02', paymentDate: '2024-02-29' }), today)).not.toThrow()
  })
  it('permits one payee to be zero and negative recovery with a reason', () => {
    expect(() => validateShow79SettlementInput(input({ jimmyPaidThb: 0 }), today)).not.toThrow()
    expect(() => validateShow79SettlementInput(input({ jimmyPaidThb: -20, partnersPaidThb: -30, note: '退票后收回', expectedProfitThb: -10, expectedJimmyPaidThb: -5, expectedPartnersPaidThb: -5 }), today)).not.toThrow()
  })
  it.each(['2026-02-29', '2026-04-31', '2026-10-17', '', '2026/10/16'])('rejects invalid or future payment day %s', paymentDate => {
    expect(() => validateShow79SettlementInput(input({ paymentDate }), today)).toThrow('付款日期')
  })
  it('rejects invalid month, no payment, missing operation and missing recovery notes', () => {
    expect(() => validateShow79SettlementInput(input({ month: '2026-13' }), today)).toThrow('月份')
    expect(() => validateShow79SettlementInput(input({ jimmyPaidThb: 0, partnersPaidThb: -0 }), today)).toThrow('同时为0')
    expect(() => validateShow79SettlementInput(input({ operationId: ' ' }), today)).toThrow('编号')
    expect(() => validateShow79SettlementInput(input({ jimmyPaidThb: -1, note: '  ' }), today)).toThrow('备注')
    expect(() => validateShow79SettlementInput(input({ partnersPaidThb: -1, note: '' }), today)).toThrow('备注')
    expect(() => validateShow79SettlementInput(input({ note: '字'.repeat(301) }), today)).toThrow('300')
  })
  it.each(['jimmyPaidThb', 'partnersPaidThb', 'expectedProfitThb', 'expectedJimmyPaidThb', 'expectedPartnersPaidThb'] as const)('checks precision and signed limits of %s', field => {
    for (const value of [NaN, Infinity, -Infinity, 1000000000000, -1000000000000, 0.001, -0.001]) {
      expect(() => validateShow79SettlementInput(input({ [field]: value }), today)).toThrow('金额')
    }
    expect(() => validateShow79SettlementInput(input({ [field]: 999999999999.99 }), today)).not.toThrow()
    expect(() => validateShow79SettlementInput(input({ [field]: -999999999999.99, note: '冲正说明' }), today)).not.toThrow()
  })
})
