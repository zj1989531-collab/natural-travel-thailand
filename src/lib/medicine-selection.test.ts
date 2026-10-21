import { describe, expect, it } from 'vitest'
import type { Project, TicketInput } from '../types'
import { buildMedicineTicketInputs, createMedicineLine, medicineLineAmounts, summariseMedicineLines, toggleMedicineProject, updateMedicineLine } from './medicine-selection'

const project = (id: string, subItemName: string, overrides: Partial<Project> = {}): Project => ({ id, userId: 'owner', name: '药品', normalizedName: '药品', subItemName, normalizedSubItemName: subItemName, supplierId: 'supplier-a', supplierName: '供货商A', quantityUnit: 'item', entryMode: 'standard', manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 95, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', syncStatus: 'synced', ...overrides })
const male = project('male-a', '果冻（男）')
const female = project('female-a', '果冻（女）', { defaultCostThb: 105 })
const maleB = project('male-b', '果冻（男）', { supplierId: 'supplier-b', supplierName: '供货商B', defaultCostThb: 100 })
const common: TicketInput = { guestName: '', issueDate: '2026-10-16', issueTime: '19:35', projectId: '', projectName: '药品', subItemName: '', supplierName: '', personCount: 99, quantityUnit: 'person', amountBasis: 'total', agentPriceThb: 999, costThb: 999, note: '共同内部备注' }
const fullMale = { ...createMedicineLine(male), personCount: 2, agentPriceThb: 150 }
const fullFemale = { ...createMedicineLine(female), personCount: 3, agentPriceThb: 220 }

describe('independent medicine selections', () => {
  it('starts each manual-price selection with one item, an empty price and its own catalogue cost', () => {
    expect(createMedicineLine(male)).toMatchObject({ projectId: male.id, personCount: 1, amountBasis: 'per_person', costThb: 95 })
    expect(Number.isNaN(createMedicineLine(male).agentPriceThb)).toBe(true)
    expect(createMedicineLine(female).costThb).toBe(105)
    expect(createMedicineLine(project('auto', '常规', { manualAgentPrice: false, defaultAgentPriceThb: 160 })).agentPriceThb).toBe(160)
    expect(createMedicineLine({ ...male, defaultAmountBasis: 'total' }).amountBasis).toBe('total')
  })

  it('keeps a manually entered cost empty rather than using the catalogue placeholder', () => {
    const line = createMedicineLine({ ...male, manualCostPrice: true, defaultCostThb: 0 })
    expect(Number.isNaN(line.costThb)).toBe(true)
    expect(summariseMedicineLines([{ ...line, agentPriceThb: 150 }]).complete).toBe(false)
    expect(() => medicineLineAmounts({ ...line, agentPriceThb: 150 })).toThrow('成本')
  })

  it('adding, editing and removing one selection preserves every other item value', () => {
    const initial = [fullMale]
    const added = toggleMedicineProject(initial, female, true)
    expect(added[0]).toBe(fullMale)
    const changed = updateMedicineLine(added, female.id, { personCount: 4, agentPriceThb: 230, costThb: 110 })
    expect(changed[0]).toBe(fullMale)
    expect(changed[1]).toMatchObject({ personCount: 4, agentPriceThb: 230, costThb: 110 })
    expect(toggleMedicineProject(changed, male, false)).toEqual([changed[1]])
    expect(toggleMedicineProject(changed, female, true)).toBe(changed)
    const reselected = toggleMedicineProject(toggleMedicineProject(changed, male, false), male, true)
    expect(reselected[0]).toBe(changed[1])
    expect(Number.isNaN(reselected[1].agentPriceThb)).toBe(true)
    expect(initial).toEqual([fullMale])
  })

  it('keeps equal subitem labels from different suppliers as distinct choices', () => {
    const lines = toggleMedicineProject(toggleMedicineProject([], male, true), maleB, true)
    expect(lines.map(line => line.projectId)).toEqual([male.id, maleB.id])
    expect(lines.map(line => line.costThb)).toEqual([95, 100])
  })

  it('totals each item quantity and money independently using exact cents', () => {
    expect(medicineLineAmounts(fullMale)).toEqual({ agentPriceThb: 300, costThb: 190, profitThb: 110 })
    expect(summariseMedicineLines([fullMale, fullFemale], [male, female])).toMatchObject({ complete: true, selectedCount: 2, quantity: 5, agentPriceThb: 960, costThb: 505, profitThb: 455 })
    expect(medicineLineAmounts({ ...fullMale, personCount: 3, agentPriceThb: 0.1, costThb: 0.03 })).toEqual({ agentPriceThb: 0.3, costThb: 0.09, profitThb: 0.21 })
  })

  it('respects a line priced as a whole item order without multiplying its amounts again', () => {
    const total = { ...fullMale, amountBasis: 'total' as const, agentPriceThb: 300, costThb: 190 }
    expect(medicineLineAmounts(total).profitThb).toBe(110)
    expect(summariseMedicineLines([total, { ...fullFemale, personCount: 1 }])).toMatchObject({ quantity: 3, agentPriceThb: 520, costThb: 295, profitThb: 225 })
  })

  it('does not show partial totals or a fake zero/loss when one manual price is still empty', () => {
    const summary = summariseMedicineLines([fullMale, createMedicineLine(female)], [male, female])
    expect(summary).toMatchObject({ complete: false, incompleteCount: 1, agentPriceThb: null, costThb: null, profitThb: null })
    expect(medicineLineAmounts({ ...fullMale, agentPriceThb: 0 })).toEqual({ agentPriceThb: 0, costThb: 190, profitThb: -190 })
    expect(summariseMedicineLines([]).complete).toBe(false)
  })

  it.each([null, 0, -1, 1.5, 2147483648])('rejects an invalid item quantity %s', personCount => {
    expect(() => medicineLineAmounts({ ...fullMale, personCount })).toThrow('数量')
  })

  it('rejects invalid currency rather than rounding away user-entered precision', () => {
    expect(() => medicineLineAmounts({ ...fullMale, agentPriceThb: NaN })).toThrow('售价')
    expect(() => medicineLineAmounts({ ...fullMale, costThb: NaN })).toThrow('成本')
    expect(() => medicineLineAmounts({ ...fullMale, agentPriceThb: 1.001 })).toThrow('两位小数')
    expect(() => medicineLineAmounts({ ...fullMale, costThb: -1 })).toThrow()
  })

  it('builds independent tickets while preserving optional customer and shared date/time/note', () => {
    const entries = buildMedicineTicketInputs(common, [fullMale, { ...createMedicineLine(maleB), personCount: 1, agentPriceThb: 180 }], [male, maleB])
    expect(entries.map(entry => [entry.projectId, entry.supplierName, entry.personCount, entry.agentPriceThb, entry.costThb])).toEqual([[male.id, '供货商A', 2, 150, 95], [maleB.id, '供货商B', 1, 180, 100]])
    for (const entry of entries) expect(entry).toMatchObject({ guestName: '', issueDate: common.issueDate, issueTime: common.issueTime, note: common.note, quantityUnit: 'item', entryMode: 'standard', amountBasis: 'per_person', settlementMode: 'daily', manualProfitThb: null })
  })

  it('refuses an incomplete, duplicate, missing or merged selection before creating any inputs', () => {
    expect(() => buildMedicineTicketInputs(common, [], [male])).toThrow('至少')
    expect(() => buildMedicineTicketInputs(common, [fullMale, fullMale], [male])).toThrow('重复')
    expect(() => buildMedicineTicketInputs(common, [fullMale, createMedicineLine(female)], [male, female])).toThrow('售价')
    expect(() => buildMedicineTicketInputs(common, [fullMale], [])).toThrow('移除')
    expect(() => buildMedicineTicketInputs(common, [fullMale], [{ ...male, mergedIntoId: 'other' }])).toThrow('移除')
    expect(() => createMedicineLine({ ...male, quantityUnit: 'person' })).toThrow('药品')
    expect(summariseMedicineLines([fullMale], []).complete).toBe(false)
  })
})
