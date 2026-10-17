import { describe, expect, it, vi } from 'vitest'
import { clearFinancialSubmission, readFinancialSubmission, stageFinancialSubmission } from './financial-submission'
import type { RefundInput } from '../types'
import type { Show79SettlementInput } from './show79-settlement'

const storage = () => {
  const rows = new Map<string, string>()
  return { rows, getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) }, removeItem: (key: string) => { rows.delete(key) } }
}
const refund: RefundInput = { operationId: 'refund-operation', ticketId: 'ticket', personCount: 1, isFull: false, refundRevenueThb: 500, returnedCostThb: 450, refundDate: '2026-10-16', refundTime: '12:00', note: '退款' }
const settlement: Show79SettlementInput = { operationId: 'settlement-operation', month: '2026-10', paymentDate: '2026-10-16', jimmyPaidThb: 20, partnersPaidThb: 30, note: '部分付款', expectedProfitThb: 200, expectedJimmyPaidThb: 0, expectedPartnersPaidThb: 0 }

describe('unconfirmed financial submission recovery', () => {
  it('restores the exact refund identity and payload after leaving the form or reloading', () => {
    const disk = storage(), draft = structuredClone(refund)
    const staged = stageFinancialSubmission(disk, 'owner-a', 'refund', draft)
    draft.note = '不能改变原提交'
    staged.note = '不能改变已保存内容'
    expect(readFinancialSubmission(disk, 'owner-a', 'refund')).toEqual(refund)
    expect(stageFinancialSubmission(disk, 'owner-a', 'refund', refund)).toEqual(refund)
    expect(disk.rows.size).toBe(1)
  })
  it('prevents changing a note, amount, date or ID when the original settlement may already have committed', () => {
    const disk = storage()
    stageFinancialSubmission(disk, 'owner-a', 'settlement', settlement)
    for (const changes of [{ operationId: 'new-id' }, { note: '补充备注' }, { paymentDate: '2026-10-15' }, { jimmyPaidThb: 40 }, { expectedJimmyPaidThb: 20 }]) {
      expect(() => stageFinancialSubmission(disk, 'owner-a', 'settlement', { ...settlement, ...changes })).toThrow('原笔')
    }
    expect(readFinancialSubmission(disk, 'owner-a', 'settlement')).toEqual(settlement)
  })
  it('keeps refund and settlement requests isolated by account and type', () => {
    const disk = storage()
    stageFinancialSubmission(disk, 'owner-a', 'refund', refund)
    stageFinancialSubmission(disk, 'owner-a', 'settlement', settlement)
    expect(readFinancialSubmission(disk, 'owner-b', 'refund')).toBeNull()
    expect(readFinancialSubmission(disk, '', 'refund')).toBeNull()
    stageFinancialSubmission(disk, 'owner-b', 'refund', { ...refund, operationId: 'other-owner' })
    clearFinancialSubmission(disk, 'owner-a', 'refund', refund.operationId)
    expect(readFinancialSubmission(disk, 'owner-a', 'settlement')).toEqual(settlement)
    expect(readFinancialSubmission(disk, 'owner-b', 'refund')?.operationId).toBe('other-owner')
  })
  it('clears only the confirmed operation and then allows an explicitly new payment', () => {
    const disk = storage()
    stageFinancialSubmission(disk, 'owner-a', 'settlement', settlement)
    clearFinancialSubmission(disk, 'owner-a', 'settlement', 'old-callback')
    expect(readFinancialSubmission(disk, 'owner-a', 'settlement')).toEqual(settlement)
    clearFinancialSubmission(disk, 'owner-a', 'settlement', settlement.operationId)
    expect(readFinancialSubmission(disk, 'owner-a', 'settlement')).toBeNull()
    const next = { ...settlement, operationId: 'next-partial-payment', expectedJimmyPaidThb: 20, expectedPartnersPaidThb: 30 }
    expect(stageFinancialSubmission(disk, 'owner-a', 'settlement', next)).toEqual(next)
  })
  it('fails before submission if recovery storage cannot be written or read', () => {
    const disk = storage(), fail = vi.fn(() => { throw new Error('QuotaExceededError') })
    expect(() => stageFinancialSubmission({ ...disk, setItem: fail }, 'owner-a', 'refund', refund)).toThrow('QuotaExceededError')
    expect(disk.rows.size).toBe(0)
    stageFinancialSubmission(disk, 'owner-a', 'refund', refund)
    const key = [...disk.rows.keys()][0]
    disk.rows.set(key, '{invalid')
    expect(() => stageFinancialSubmission(disk, 'owner-a', 'refund', refund)).toThrow()
    expect(() => stageFinancialSubmission(storage(), '', 'refund', refund)).toThrow('账号')
  })
})
