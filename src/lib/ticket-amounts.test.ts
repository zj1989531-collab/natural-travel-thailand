import { describe, expect, it } from 'vitest'
import { getTicketAmounts, validateAmountPrecision } from './ticket-amounts'

const input = { amountBasis: 'per_person' as const, personCount: 3, agentPriceThb: 650, costThb: 600 }

describe('headcount pricing', () => {
  it('multiplies unit sale, cost and profit exactly once', () => {
    expect(getTicketAmounts(input)).toEqual({ agentPriceThb: 1950, costThb: 1800, profitThb: 150 })
    expect(getTicketAmounts({ ...input, personCount: 5 })).toEqual({ agentPriceThb: 3250, costThb: 3000, profitThb: 250 })
    expect(getTicketAmounts(input)).toEqual(getTicketAmounts(input))
    expect(input.agentPriceThb).toBe(650)
  })
  it('handles cents, loss, deliberate zero and one person', () => {
    expect(getTicketAmounts({ ...input, agentPriceThb: 100.1, costThb: 99.9 })).toEqual({ agentPriceThb: 300.3, costThb: 299.7, profitThb: 0.6 })
    expect(getTicketAmounts({ ...input, agentPriceThb: 500 })).toEqual({ agentPriceThb: 1500, costThb: 1800, profitThb: -300 })
    expect(getTicketAmounts({ ...input, agentPriceThb: 0, costThb: 0 }).profitThb).toBe(0)
    expect(getTicketAmounts({ ...input, personCount: 1 }).profitThb).toBe(50)
  })
  it('multiplies manual commission without inventing revenue or cost', () => {
    expect(getTicketAmounts({ ...input, entryMode: 'profit_only', manualProfitThb: 50.25 })).toEqual({ agentPriceThb: 0, costThb: 0, profitThb: 150.75 })
  })
  it('preserves legacy and explicitly whole-order totals regardless of headcount', () => {
    expect(getTicketAmounts({ ...input, amountBasis: undefined })).toEqual({ agentPriceThb: 650, costThb: 600, profitThb: 50 })
    expect(getTicketAmounts({ ...input, amountBasis: 'total', personCount: 100 })).toEqual({ agentPriceThb: 650, costThb: 600, profitThb: 50 })
    expect(getTicketAmounts({ ...input, amountBasis: 'total', entryMode: 'profit_only', manualProfitThb: 50.25 }).profitThb).toBe(50.25)
  })
  it('does not display invented totals when a required headcount is blank', () => {
    expect(getTicketAmounts({ ...input, personCount: null })).toEqual({ agentPriceThb: 0, costThb: 0, profitThb: 0 })
  })
  it.each([0.001, 1.005, -1, NaN, Infinity, 1000000000000])('rejects unrepresentable money %s', (value) => {
    expect(() => validateAmountPrecision([value])).toThrow()
  })
  it('accepts two-decimal money and normal multiplication totals', () => {
    expect(() => validateAmountPrecision([0, 50.25, 300.3, 999999999999.99])).not.toThrow()
  })
})
