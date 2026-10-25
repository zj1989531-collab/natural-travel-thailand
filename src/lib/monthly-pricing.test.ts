import { describe, expect, it } from 'vitest'
import type { Project } from '../types'
import { monthlyPricingOptions, resolveMonthlyPricing } from './monthly-pricing'
import type { Show69RecordInput } from './show69'

const project = (id: string, patch: Partial<Project> = {}): Project => ({
  id, userId: 'owner', name: '69秀', normalizedName: '69秀', subItemName: '', normalizedSubItemName: '',
  supplierId: 'starlight', supplierName: '星光旅行社', entryMode: 'standard', quantityUnit: 'person',
  defaultAmountBasis: 'per_person', settlementMode: 'monthly', defaultAgentPriceThb: 430, defaultCostThb: 400,
  createdAt: '', updatedAt: '', syncStatus: 'synced', ...patch
})
const normal = project('69')
const asian = project('asian', { name: '泰拳', subItemName: '亚洲面孔', defaultAgentPriceThb: 650, defaultCostThb: 620 })
const western = project('western', { name: '泰拳', subItemName: '欧美面孔', defaultAgentPriceThb: 900, defaultCostThb: 850 })
const old = project('old', { supplierName: '69秀独立记录', subItemName: '独立记录', defaultAgentPriceThb: 0, defaultCostThb: 0 })
const input: Show69RecordInput = { date: '2026-10-23', guestName: '张三', people: 3 }

describe('monthly record per-person pricing', () => {
  it('matches the current real supplier table for each category and preserves the catalogue', () => {
    const catalogue = [old, normal, asian, western]
    const original = structuredClone(catalogue)
    expect(monthlyPricingOptions('show69', catalogue)).toEqual([normal])
    expect(monthlyPricingOptions('boxing', catalogue, 'asian')).toEqual([asian])
    expect(monthlyPricingOptions('boxing', catalogue, 'western')).toEqual([western])
    expect(resolveMonthlyPricing('show69', input, catalogue)).toMatchObject({ project: normal, agentPriceThb: 430, costThb: 400, profitThb: 30, subItemName: '' })
    expect(resolveMonthlyPricing('boxing', { ...input, boxingCategory: 'asian' }, catalogue)).toMatchObject({ project: asian, agentPriceThb: 650, costThb: 620, profitThb: 30, boxingCategory: 'asian' })
    expect(resolveMonthlyPricing('boxing', { ...input, boxingCategory: 'western' }, catalogue)).toMatchObject({ project: western, agentPriceThb: 900, costThb: 850, profitThb: 50, boxingCategory: 'western' })
    expect(catalogue).toEqual(original)
  })
  it('uses fixed fallback prices only when there is no available configured catalogue price', () => {
    expect(resolveMonthlyPricing('show69', input, [old])).toMatchObject({ project: undefined, agentPriceThb: 430, costThb: 400, profitThb: 30, subItemName: '独立记录' })
    expect(resolveMonthlyPricing('boxing', { ...input, boxingCategory: 'asian' }, [])).toMatchObject({ project: undefined, agentPriceThb: 650, costThb: 620, profitThb: 30, subItemName: '亚洲面孔' })
    expect(resolveMonthlyPricing('boxing', { ...input, boxingCategory: 'western' }, [])).toMatchObject({ project: undefined, agentPriceThb: 900, costThb: 850, profitThb: 50, subItemName: '欧美面孔' })
  })
  it('requires a boxing category even if only one category exists in the catalogue', () => {
    expect(() => resolveMonthlyPricing('boxing', input, [asian])).toThrow('请选择泰拳票种')
    expect(() => resolveMonthlyPricing('boxing', { ...input, projectId: asian.id }, [asian])).toThrow('请选择泰拳票种')
  })
  it('uses changed real catalogue prices instead of overwriting them with the initial presets', () => {
    const changed = project('current', { defaultAgentPriceThb: 440.25, defaultCostThb: 405.1 })
    expect(resolveMonthlyPricing('show69', input, [changed])).toMatchObject({ project: changed, agentPriceThb: 440.25, costThb: 405.1, profitThb: 35.15 })
  })
  it('uses configured main-ledger prices for Koh Larn and carnival, with no invented fallback', () => {
    const kohLarn = project('koh-larn-c', { name: '格兰岛跟团一日游', subItemName: 'C套餐', defaultAgentPriceThb: 850, defaultCostThb: 720 })
    const carnival = project('carnival-vip', { name: '东方嘉年华', subItemName: 'VIP', defaultAgentPriceThb: 1200, defaultCostThb: 990 })
    expect(monthlyPricingOptions('kohlarn', [kohLarn, carnival])).toEqual([kohLarn])
    expect(monthlyPricingOptions('carnival', [kohLarn, carnival])).toEqual([carnival])
    expect(resolveMonthlyPricing('kohlarn', { ...input, projectId: kohLarn.id }, [kohLarn])).toMatchObject({ project: kohLarn, agentPriceThb: 850, costThb: 720, profitThb: 130 })
    expect(resolveMonthlyPricing('carnival', { ...input, projectId: carnival.id }, [carnival])).toMatchObject({ project: carnival, agentPriceThb: 1200, costThb: 990, profitThb: 210 })
    expect(() => resolveMonthlyPricing('kohlarn', input, [])).toThrow('维护有效的月结套餐')
  })
  it('requires an explicit choice between real suppliers even when their prices match', () => {
    const second = project('second', { supplierId: 'other', supplierName: '其他旅行社' })
    expect(() => resolveMonthlyPricing('show69', input, [normal, second])).toThrow('多个供货商')
    expect(resolveMonthlyPricing('show69', { ...input, projectId: second.id }, [normal, second]).project).toBe(second)
  })
  it('prefers real suppliers over both old zero-price and newly priced internal templates', () => {
    const internal = { ...old, id: 'internal', defaultAgentPriceThb: 430, defaultCostThb: 400 }
    const internalAsian = { ...asian, id: 'internal-asian', supplierName: '泰拳独立记录' }
    expect(monthlyPricingOptions('show69', [old, internal, normal])).toEqual([normal])
    expect(monthlyPricingOptions('boxing', [internalAsian, asian], 'asian')).toEqual([asian])
    expect(monthlyPricingOptions('show69', [internal])).toEqual([internal])
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: internal.id }, [normal, internal])).toThrow('重新选择')
  })
  it.each([
    { mergedIntoId: 'merged' }, { entryMode: 'profit_only' as const }, { quantityUnit: 'item' as const },
    { manualAgentPrice: true }, { manualCostPrice: true }, { manualSupplier: true }, { defaultAmountBasis: 'total' as const },
    { defaultAgentPriceThb: Number.NaN }, { defaultCostThb: Infinity }, { defaultCostThb: -1 }, { defaultAgentPriceThb: 430.123 }
  ])('does not treat invalid, manual or whole-booking configuration %j as a per-person price', patch => {
    const invalid = project('invalid', patch)
    expect(monthlyPricingOptions('show69', [invalid])).toEqual([])
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: invalid.id }, [invalid])).toThrow('重新选择')
  })
  it('never silently falls back for a missing, unrelated or wrong-category explicitly selected project', () => {
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: 'missing' }, [normal])).toThrow('重新选择')
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: asian.id }, [asian])).toThrow('重新选择')
    expect(() => resolveMonthlyPricing('boxing', { ...input, boxingCategory: 'asian', projectId: western.id }, [asian, western])).toThrow('重新选择')
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: old.id }, [old])).toThrow('重新选择')
  })
  it('does not reuse an unpriced zero template or invent category for an unknown package', () => {
    const free = project('free', { defaultAgentPriceThb: 0, defaultCostThb: 0 })
    expect(monthlyPricingOptions('show69', [free])).toEqual([])
    expect(resolveMonthlyPricing('show69', input, [free])).toMatchObject({ project: undefined, agentPriceThb: 430, costThb: 400 })
    expect(() => resolveMonthlyPricing('show69', { ...input, projectId: free.id }, [free])).toThrow('重新选择')
    expect(monthlyPricingOptions('show69', [{ ...free, defaultAgentPriceThb: 430 }])).toHaveLength(1)
    expect(monthlyPricingOptions('boxing', [{ ...asian, subItemName: '独立记录' }], 'asian')).toEqual([])
    expect(monthlyPricingOptions('boxing', [{ ...asian, subItemName: '亚洲人/欧美人' }], 'asian')).toEqual([])
  })
})
