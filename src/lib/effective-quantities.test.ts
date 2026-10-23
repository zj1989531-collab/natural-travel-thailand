import { describe, expect, it } from 'vitest'
import type { RefundRecord, TicketRecord } from '../types'
import { isWholeBooking, quantityParts, summariseQuantities } from './effective-quantities'
import { getProfit, ticketsForDailyStats } from './stats'
import { buildReport } from './reports'

const ticket: TicketRecord = { id: 'test', userId: 'u', issueDate: '2026-10-15', supplierId: 's', supplierName: '测试', projectId: 'p', projectName: '普通门票', subItemName: '', personCount: 5, amountBasis: 'per_person', agentPriceThb: 650, costThb: 600, note: '', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', syncStatus: 'synced', deletedAt: null }
const refund = (extra: Partial<RefundRecord> = {}): RefundRecord => ({ id: 'r', userId: 'u', ticketId: ticket.id, personCount: 2, isFull: false, refundRevenueThb: 1300, returnedCostThb: 1200, refundDate: ticket.issueDate, refundTime: '10:00', note: '', cancelledAt: null, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, syncStatus: 'synced', ...extra })

describe('effective ticket/order/item quantities', () => {
  it('counts one five-person entry as five tickets without changing money', () => {
    expect(summariseQuantities([ticket])).toMatchObject({ recordCount: 1, ticketCount: 5 })
    expect(getProfit(ticket)).toBe(250)
    expect(quantityParts(summariseQuantities([ticket]))).toEqual(['门票 5 张'])
  })
  it('deducts partial refunds and excludes full refunds and deleted records', () => {
    expect(summariseQuantities([{ ...ticket, refunds: [refund()] }]).ticketCount).toBe(3)
    expect(summariseQuantities([{ ...ticket, refunds: [refund({ isFull: true })] }]).recordCount).toBe(0)
    expect(summariseQuantities([{ ...ticket, deletedAt: ticket.createdAt }]).ticketCount).toBe(0)
  })
  it('restores cancelled refunds and ignores receipts of other tickets or owners', () => {
    expect(summariseQuantities([{ ...ticket, refunds: [refund({ cancelledAt: ticket.createdAt }), refund({ userId: 'other' }), refund({ ticketId: 'other' })] }]).ticketCount).toBe(5)
  })
  it.each(['包车', '包船', '芭提亚游艇会'])('counts %s as one order, not five tickets', name => {
    expect(summariseQuantities([{ ...ticket, projectName: name }])).toMatchObject({ orderCount: 1, ticketCount: 0 })
  })
  it.each(['整车', '整船', '整床', '整间', '包台', '包厢', '私人床位'])('recognizes a %s subpackage in a regular tour project', subItemName => {
    expect(isWholeBooking({ projectName: '海上活动', subItemName })).toBe(true)
  })
  it('does not classify a yacht join-in tour as a whole booking', () => {
    expect(isWholeBooking({ projectName: '游艇拼船一日游', subItemName: '普通票' })).toBe(false)
  })
  it('keeps a partially refunded booking as one order and a fully refunded one as zero', () => {
    expect(summariseQuantities([{ ...ticket, projectName: '包船', refunds: [refund()] }]).orderCount).toBe(1)
    expect(summariseQuantities([{ ...ticket, projectName: '包船', refunds: [refund({ isFull: true })] }]).orderCount).toBe(0)
  })
  it('keeps items distinct and excludes manual commission from quantities', () => {
    expect(summariseQuantities([{ ...ticket, quantityUnit: 'item', refunds: [refund()] }, { ...ticket, entryMode: 'profit_only' }])).toMatchObject({ recordCount: 1, ticketCount: 0, itemCount: 3 })
  })
  it('does not guess missing headcounts or item quantities, but can count one whole booking', () => {
    const missing = { ...ticket, personCount: null }
    expect(summariseQuantities([missing, { ...missing, quantityUnit: 'item' }, { ...missing, projectName: '包车' }])).toMatchObject({ ticketCount: 0, itemCount: 0, orderCount: 1, unknownCount: 2 })
    expect(quantityParts(summariseQuantities([]))).toEqual(['门票 0 张'])
  })
  it('excludes boxing from daily and main report quantities while retaining ordinary orders', () => {
    const monthly = { ...ticket, projectName: '泰拳' }
    expect(summariseQuantities(ticketsForDailyStats([monthly], ticket.issueDate)).ticketCount).toBe(0)
    const report = buildReport([monthly, { ...ticket, id: 'order', projectName: '包车' }], { mode: 'day', date: ticket.issueDate, month: '2026-10', supplierId: '', startDate: ticket.issueDate, endDate: ticket.issueDate })
    expect(report.effectiveQuantity).toMatchObject({ ticketCount: 0, orderCount: 1 })
    expect(report.monthlyRecords).toEqual([])
  })
})
