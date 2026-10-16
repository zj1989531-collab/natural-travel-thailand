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
  it('offers an optional customer name for new tickets and every record type, preserving saved names', () => {
    const renderForm = (record?: TicketRecord) => renderToStaticMarkup(<TicketForm ticket={record} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    const records: (TicketRecord | undefined)[] = [undefined, { ...ticket, guestName: '客户 <A>' }, { ...ticket, projectName: '海洋公园', quantityUnit: 'person', guestName: '张三' }, { ...ticket, projectName: '月结返佣', entryMode: 'profit_only', guestName: 'jimmy' }]
    for (const record of records) {
      const html = renderForm(record)
      const nameInput = html.match(/<label>客户姓名 .*?<input[^>]+>/)?.[0]
      expect(nameInput).toContain('（可选）')
      expect(nameInput).toContain('maxLength="100"')
      expect(nameInput).not.toContain('required')
    }
    expect(renderForm(records[1])).toContain('value="客户 &lt;A&gt;"')
    expect(renderForm(records[2])).toContain('value="张三"')
    expect(renderForm(records[3])).toContain('value="jimmy"')
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
  it('shows a compact order summary with the saved pricing unit and total profit', () => {
    const renderForm = (record: TicketRecord) => renderToStaticMarkup(<TicketForm ticket={record} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    const html = renderForm({ ...ticket, guestName: 'Jimmy' })
    const summary = html.match(/<section class="ticket-order-summary[^]*?<\/section>/)?.[0] ?? ''
    for (const text of ['订单核对摘要', 'Jimmy', '2026/10/14', '2件', '药品 · 测试规格', '单件售价', '单件成本', '฿150.00', '฿95.00', '本次总利润', '฿110.00']) expect(summary).toContain(text)
    const total = renderForm({ ...ticket, amountBasis: 'total' })
    expect(total).toContain('整单总额 · 不乘人数／数量')
    expect(total).toContain('整单售价')
    expect(total).toContain('฿55.00')
    expect(total.indexOf('旧记录保留原总额')).toBeLessThan(total.indexOf('<details'))
    const commission = renderForm({ ...ticket, entryMode: 'profit_only', manualProfitThb: 50 })
    expect(commission).toContain('单件返佣')
    expect(commission).toContain('本次月结总利润')
    expect(commission).toContain('฿100.00')
  })
  it('keeps critical fields visible while grouping valid time, pricing mode and notes in more settings', () => {
    const renderForm = (record?: TicketRecord) => renderToStaticMarkup(<TicketForm ticket={record} projects={[project]} cloudLoginRequired={false} onCancel={() => {}} onManageSuppliers={() => {}} onSave={async () => {}} />)
    const html = renderForm()
    const details = html.match(/<details[^]*?<\/details>/)?.[0] ?? ''
    for (const text of ['更多设置', '时间（曼谷 UTC+7）', '计价方式', '备注']) expect(details).toContain(text)
    for (const text of ['客户姓名', '出票日期', '搜索项目', '代理售价（THB）', '供货商成本（THB）']) expect(details).not.toContain(text)
    expect(details).toMatch(/type="time"[^>]*required=""[^>]*value="\d{2}:\d{2}"/)
    const old = renderForm({ ...ticket, issueTime: undefined })
    const oldTime = old.match(/<input[^>]*type="time"[^>]*>/)?.[0] ?? ''
    expect(oldTime).toContain('value=""')
    expect(oldTime).not.toContain('required')
    expect(old).toContain('旧记录未记录时间')
  })
  it('displays a medicine quantity query as items, not ticket headcounts', () => {
    const report = buildReport([ticket], { mode: 'month', month: '2026-10', date: '2026-10-14', startDate: '2026-10-01', endDate: '2026-10-31', supplierId: '', projectName: '药品' })
    const html = renderToStaticMarkup(<ReportPreview report={report} supplierName="测试供货商" generatedAt="2026-10-14 09:30" />)
    for (const text of ['商品数量查询', '已录数量', '2 件', '每日商品数量', '不计作门票', '฿110.00']) expect(html).toContain(text)
    expect(html).not.toContain('项目出票数量查询')
    expect(html).not.toContain('已录 2 张')
  })
})
