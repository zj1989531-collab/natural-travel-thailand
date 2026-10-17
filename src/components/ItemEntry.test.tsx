import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Project, TicketRecord } from '../types'
import { TicketForm } from '../App'
import { PersonCountField } from './PersonCountField'
import { ReportPreview } from './ReportView'
import { buildReport } from '../lib/reports'

const project: Project = { id: 'item-project', userId: 'test-user', supplierId: 'test-supplier', supplierName: '测试供货商', name: '药品', normalizedName: '药品', subItemName: '测试规格', normalizedSubItemName: '测试规格', manualAgentPrice: true, quantityUnit: 'item', defaultAgentPriceThb: 0, defaultCostThb: 95, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', syncStatus: 'synced' }
const ticket: TicketRecord = { id: 'item-ticket', userId: project.userId, projectId: project.id, projectName: project.name, supplierId: project.supplierId, supplierName: project.supplierName, subItemName: project.subItemName, personCount: 2, quantityUnit: 'item', amountBasis: 'per_person', agentPriceThb: 150, costThb: 95, issueDate: '2026-10-14', issueTime: '09:30', note: '', createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: null, syncStatus: 'synced' }

describe('item entry labels', () => {
  it('renders a mandatory supplier choice and truly blank amounts for a new manual car selection without changing a saved record', () => {
    const car = { ...project, name: '叫车', manualSupplier: true, manualCostPrice: true, manualAgentPrice: true, supplierId: '', supplierName: '' }
    const draft = { ...ticket, projectName: '叫车', projectId: car.id, amountBasis: 'total' as const, quantityUnit: 'person' as const, supplierName: '', costThb: NaN, agentPriceThb: NaN }
    const html = renderToStaticMarkup(<TicketForm ticket={draft} projects={[car]} suppliers={[]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    for (const text of ['请自行选择供货商', '成本不预设', '待填写金额']) expect(html).toContain(text)
    expect(html).not.toContain('成本已自动带入'); expect(html).not.toContain('฿0.00')
    const saved = renderToStaticMarkup(<TicketForm ticket={{ ...draft, supplierName: '已选供货商', costThb: 600, agentPriceThb: 800 }} projects={[car]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    expect(saved).toContain('value="600"'); expect(saved).toContain('value="800"'); expect(saved).toContain('฿200.00')
  })
  it('uses quantity dropdowns and custom quantity, not number of people', () => {
    const html = renderToStaticMarkup(<PersonCountField quantityUnit="item" value={2} onChange={() => {}} />)
    for (const text of ['数量', '2 件', '其他数量', '单件金额 × 数量']) expect(html).toContain(text)
    expect(html).not.toContain('人数')
  })
  it('uses unit prices and preserves saved prices when editing an item record', () => {
    const html = renderToStaticMarkup(<TicketForm ticket={ticket} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    for (const text of ['单件代理售价（THB）', '单件供货商成本（THB）', '按数量计算', '售价不预设', '฿110.00']) expect(html).toContain(text)
    expect(html).toContain('value="150"')
    expect(html).toContain('value="95"')
    expect(html).not.toContain('单人代理售价')
  })
  it('does not present a fake loss or zero selling price before the required manual input', () => {
    const html = renderToStaticMarkup(<TicketForm ticket={{ ...ticket, agentPriceThb: NaN }} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    expect(html).toContain('待填写售价')
    expect(html).not.toContain('-฿190.00')
    expect(html).not.toContain('profit-preview negative')
  })
  it('displays a medicine quantity query as items, not ticket headcounts', () => {
    const report = buildReport([ticket], { mode: 'month', month: '2026-10', date: '2026-10-14', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '', projectName: '药品' })
    const html = renderToStaticMarkup(<ReportPreview report={report} supplierName="测试供货商" generatedAt="2026-10-14 09:30" />)
    for (const text of ['商品数量查询', '已录数量', '2 件', '每日商品数量', '不计作门票', '฿110.00']) expect(html).toContain(text)
    expect(html).not.toContain('项目出票数量查询')
    expect(html).not.toContain('已录 2 张')
  })
})
