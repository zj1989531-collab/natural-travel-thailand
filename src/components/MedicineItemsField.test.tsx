import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Project } from '../types'
import { createMedicineLine } from '../lib/medicine-selection'
import { MedicineItemsField } from './MedicineItemsField'

const male: Project = { id: 'male-a', userId: 'owner', name: '药品', normalizedName: '药品', subItemName: '果冻（男）', normalizedSubItemName: '果冻（男）', supplierId: 'supplier-a', supplierName: '供货商A', quantityUnit: 'item', entryMode: 'standard', manualAgentPrice: true, defaultAgentPriceThb: 0, defaultCostThb: 95, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', syncStatus: 'synced' }
const female = { ...male, id: 'female-a', subItemName: '果冻（女）', defaultCostThb: 105 }
const maleB = { ...male, id: 'male-b', supplierId: 'supplier-b', supplierName: '供货商B' }

describe('medicine multi-select entry', () => {
  it('offers explicit checkbox choices with supplier labels and an at-least-one prompt', () => {
    const html = renderToStaticMarkup(<MedicineItemsField projects={[male, female, maleB]} lines={[]} onChange={() => {}} />)
    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
    for (const text of ['药品子项（可多选）', '果冻（男）', '果冻（女）', '供货商A', '供货商B', '至少勾选1个']) expect(html).toContain(text)
    expect(html).not.toContain('入场人数')
  })

  it('shows independent item amounts, numeric quantity fields, per-line and whole-selection profit', () => {
    const lines = [{ ...createMedicineLine(male), personCount: 2, agentPriceThb: 150 }, { ...createMedicineLine(female), personCount: 3, agentPriceThb: 220 }]
    const html = renderToStaticMarkup(<MedicineItemsField projects={[male, female]} lines={lines} onChange={() => {}} />)
    expect(html.match(/checked=""/g)).toHaveLength(2)
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(2)
    expect(html.match(/type="number"/g)).toHaveLength(6)
    for (const text of ['数量（件）', '单件售价', '单件成本', '本项总利润', '฿110.00', '฿345.00', '总销售额', '฿960.00', '总成本', '฿505.00', '总利润', '฿455.00', '合计 5 件', '移除 果冻（男） · 供货商A']) expect(html).toContain(text)
    expect(html).not.toContain('人数')
    expect(html).not.toContain('单人')
  })

  it('keeps an unfilled manual price blank and avoids fake losses or partial totals', () => {
    const html = renderToStaticMarkup(<MedicineItemsField projects={[male]} lines={[createMedicineLine(male)]} onChange={() => {}} />)
    expect(html).toContain('售价需手动填写')
    expect(html).toContain('请填写本项售价')
    expect(html).toContain('value="95"')
    expect(html).not.toContain('value="0"')
    expect(html).not.toContain('-฿95.00')
    expect(html).toContain('待填写完整')
  })

  it('labels whole-order amounts and disables every editable control while saving', () => {
    const totalProject = { ...male, defaultAmountBasis: 'total' as const }
    const html = renderToStaticMarkup(<MedicineItemsField projects={[totalProject]} lines={[{ ...createMedicineLine(totalProject), personCount: 2, agentPriceThb: 300, costThb: 190 }]} onChange={() => {}} disabled />)
    for (const text of ['整单金额，不再乘件数', '整单售价', '整单成本', '฿110.00']) expect(html).toContain(text)
    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    expect(html.match(/<input[^>]*type="number"[^>]*disabled=""/g)).toHaveLength(3)
    expect(html).toMatch(/aria-label="移除 [^"]*" disabled=""/)
  })

  it('exposes missing catalogue rows without offering a valid-looking total', () => {
    const html = renderToStaticMarkup(<MedicineItemsField projects={[]} lines={[{ ...createMedicineLine(male), agentPriceThb: 150 }]} onChange={() => {}} />)
    expect(html).toContain('已从目录移除')
    expect(html).toContain('重新选择')
    expect(html).not.toContain('฿55.00')
    expect(html).toContain('待填写完整')
  })
})
